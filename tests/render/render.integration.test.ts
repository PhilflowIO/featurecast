import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { beforeAll, describe, expect, it } from 'vitest'

import { serializeEvent, type RecordEvent } from '../../src/record.js'
import { renderRecording } from '../../src/render/render.js'

const run = promisify(execFile)

const SOURCE = { width: 1280, height: 800 }
const FRAME_COUNT = 30
const FRAME_SPACING_MS = 1000 / 30
const STARTED_AT = 1_700_000_000_000

let ffmpegAvailable = false

async function hasTool(name: string): Promise<boolean> {
  try {
    await run(name, ['-version'])
    return true
  } catch {
    return false
  }
}

/**
 * A capture directory of the shape `captureScreencast` writes, small enough to
 * encode on a workstation in a second or two.
 */
async function makeCapture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-render-'))
  const frames = join(directory, 'frames')
  await mkdir(frames, { recursive: true })
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${SOURCE.width}x${SOURCE.height}:rate=30:duration=1`,
    '-frames:v',
    String(FRAME_COUNT),
    '-q:v',
    '2',
    join(frames, 'frame-%06d.jpg'),
  ])

  const manifest = {
    captureSize: SOURCE,
    frames: Array.from({ length: FRAME_COUNT }, (_, index) => ({
      file: `frame-${String(index + 1).padStart(6, '0')}.jpg`,
      timestamp: STARTED_AT + index * FRAME_SPACING_MS,
      viewport: SOURCE,
    })),
    session: {
      duration: FRAME_COUNT * FRAME_SPACING_MS,
      endedAt: STARTED_AT + FRAME_COUNT * FRAME_SPACING_MS,
      startedAt: STARTED_AT,
    },
    version: 1,
  }
  await writeFile(
    join(directory, 'timestamps.json'),
    JSON.stringify(manifest),
    'utf8',
  )

  const events: RecordEvent[] = [
    { type: 'header', version: 1, fps: 60, seed: 1 },
  ]
  for (let tick = 0; tick <= 60; tick += 1) {
    events.push({ type: 'pointer', tick, x: 120 + tick * 4, y: 90 + tick })
  }
  events.push({
    type: 'click',
    tick: 40,
    x: 560,
    y: 260,
    bbox: { x: 500, y: 236, width: 120, height: 48 },
  })
  await writeFile(
    join(directory, 'events.jsonl'),
    `${events.map(serializeEvent).join('\n')}\n`,
    'utf8',
  )
  return directory
}

async function probe(path: string): Promise<{ height: number; width: number }> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    path,
  ])
  const parsed = JSON.parse(stdout) as {
    streams: Array<{ height: number; width: number }>
  }
  const stream = parsed.streams[0]
  if (stream === undefined) throw new Error(`${path} has no video stream`)
  return stream
}

beforeAll(async () => {
  ffmpegAvailable = (await hasTool('ffmpeg')) && (await hasTool('ffprobe'))
}, 30_000)

describe('rendering a recording end to end', () => {
  it('turns one raw recording into three finished videos, with no browser', async () => {
    if (!ffmpegAvailable) return
    const capture = await makeCapture()
    const out = await mkdtemp(join(tmpdir(), 'featurecast-out-'))
    const result = await renderRecording(capture, out)

    expect(result.outputs).toHaveLength(3)
    for (const output of result.outputs) {
      const probed = await probe(output.outputPath)
      expect(probed.width).toBe(output.width)
      expect(probed.height).toBe(output.height)
    }
  }, 180_000)

  it('writes the same decisions twice, byte for byte', async () => {
    if (!ffmpegAvailable) return
    const capture = await makeCapture()
    const first = await mkdtemp(join(tmpdir(), 'featurecast-a-'))
    const second = await mkdtemp(join(tmpdir(), 'featurecast-b-'))
    await renderRecording(capture, first, { dryRun: true })
    await renderRecording(capture, second, { dryRun: true })
    expect(await readFile(join(first, 'decisions.json'), 'utf8')).toBe(
      await readFile(join(second, 'decisions.json'), 'utf8'),
    )
  }, 120_000)

  it('re-renders a changed look without the capture directory changing', async () => {
    if (!ffmpegAvailable) return
    const capture = await makeCapture()
    const out = await mkdtemp(join(tmpdir(), 'featurecast-look-'))
    const before = await renderRecording(capture, out, {
      dryRun: true,
      formats: [{ aspect: '16:9', desired: { width: 640, height: 360 } }],
      zoom: { paddingPx: 8 },
    })
    const after = await renderRecording(capture, out, {
      dryRun: true,
      formats: [{ aspect: '16:9', desired: { width: 640, height: 360 } }],
      zoom: { paddingPx: 240 },
    })
    const beforeCrops = before.plan.formats[0]?.frames.map(
      (frame) => frame.crop,
    )
    const afterCrops = after.plan.formats[0]?.frames.map((frame) => frame.crop)
    expect(beforeCrops).not.toEqual(afterCrops)
  }, 120_000)
})
