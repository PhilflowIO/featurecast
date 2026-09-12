import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { beforeAll, describe, expect, it } from 'vitest'

import { serializeEvent, type RecordEvent } from '../../src/record.js'
import { createRaster, type Raster } from '../../src/render/compose.js'
import { DEFAULT_CURSOR_LOOK } from '../../src/render/cursor.js'
import { sourceFrameForOutput } from '../../src/render/ffmpeg.js'
import type { Size } from '../../src/render/geometry.js'
import { composeFrame } from '../../src/render/pipeline.js'
import { renderRecording } from '../../src/render/render.js'
import { SpriteCache } from '../../src/render/sprite.js'

const run = promisify(execFile)

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** One frame of `input`, decoded to the packed RGB the compositor works in. */
async function rawFrame(
  input: string,
  size: Size,
  extra: readonly string[],
): Promise<Raster> {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      input,
      ...extra,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 256 },
  )
  const raster = createRaster(size)
  raster.data.set(stdout.subarray(0, raster.data.length))
  return raster
}

function meanAbsoluteDifference(a: Raster, b: Raster): number {
  let total = 0
  for (let i = 0; i < a.data.length; i += 1) {
    total += Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0))
  }
  return total / a.data.length
}

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

  it('renders the same video twice, in two separate processes, byte for byte', async () => {
    if (!ffmpegAvailable) return
    const capture = await makeCapture()
    const first = await mkdtemp(join(tmpdir(), 'featurecast-p1-'))
    const second = await mkdtemp(join(tmpdir(), 'featurecast-p2-'))
    // Two processes, not two calls: the defect this replaces was in ffmpeg's
    // dispatch of timed commands, and it varied between invocations rather than
    // within one. Six runs of the old renderer over one command file produced
    // four different videos.
    for (const out of [first, second]) {
      await run('node', [
        join(
          import.meta.dirname,
          '..',
          '..',
          'node_modules',
          'tsx',
          'dist',
          'cli.mjs',
        ),
        join(import.meta.dirname, '..', '..', 'src', 'render', 'cli.ts'),
        capture,
        out,
      ])
    }
    for (const name of ['16-9.mp4', '9-16.mp4', '1-1.mp4', 'decisions.json']) {
      expect(sha256(await readFile(join(first, name)))).toBe(
        sha256(await readFile(join(second, name))),
      )
    }
  }, 300_000)

  it('renders the same video however many threads it is given', async () => {
    if (!ffmpegAvailable) return
    const capture = await makeCapture()
    const alone = await mkdtemp(join(tmpdir(), 'featurecast-t1-'))
    const many = await mkdtemp(join(tmpdir(), 'featurecast-t4-'))
    // Composition is split by output row across threads, and output rows are
    // independent. A machine with more cores must therefore produce the same
    // file, not merely an equivalent one — otherwise "identical decisions imply
    // an identical video" would quietly mean "on this laptop".
    await renderRecording(capture, alone, { threads: 1 })
    await renderRecording(capture, many, { threads: 4 })
    for (const name of ['16-9.mp4', '9-16.mp4', '1-1.mp4']) {
      expect(sha256(await readFile(join(alone, name)))).toBe(
        sha256(await readFile(join(many, name))),
      )
    }
  }, 300_000)

  it('draws what decisions.json says, on the frame it says', async () => {
    if (!ffmpegAvailable) return
    const capture = await makeCapture()
    const out = await mkdtemp(join(tmpdir(), 'featurecast-follow-'))
    const result = await renderRecording(capture, out, {
      formats: [{ aspect: '16:9', desired: { width: 640, height: 360 } }],
      encoder: { crf: 0, preset: 'ultrafast' },
    })
    const format = result.plan.formats[0]
    expect(format).toBeDefined()
    if (format === undefined) return

    // Decode the source frame the plan puts on screen at output frame `n`, and
    // compose that frame here from the decision data. The encoded frame has to
    // be the same picture — that is the whole claim: the video follows the
    // decisions rather than a command channel's idea of what time it is.
    const n = Math.min(40, format.frames.length - 1)
    const decision = format.frames[n]
    const sourceIndex = sourceFrameForOutput(result.plan)[n] ?? 0
    expect(decision).toBeDefined()
    if (decision === undefined) return

    const sourceFile = result.plan.frames[sourceIndex]?.file
    expect(sourceFile).toBeDefined()
    if (sourceFile === undefined) return
    const source = await rawFrame(
      join(capture, 'frames', sourceFile),
      SOURCE,
      [],
    )
    const sprites = new SpriteCache(DEFAULT_CURSOR_LOOK)
    const expectedRaster = createRaster(format.output)
    composeFrame(
      source,
      decision,
      { geometry: sprites.geometry, sprites },
      expectedRaster,
    )
    const actual = await rawFrame(join(out, '16-9.mp4'), format.output, [
      '-vf',
      `select=eq(n\\,${String(n)})`,
      '-fps_mode',
      'passthrough',
      '-frames:v',
      '1',
    ])
    expect(meanAbsoluteDifference(expectedRaster, actual)).toBeLessThan(3)
  }, 300_000)

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
