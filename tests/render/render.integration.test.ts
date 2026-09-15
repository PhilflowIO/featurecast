import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  serializeEvent,
  serializeEventTimes,
  type RecordEvent,
} from '../../src/record.js'
import { createRaster, type Raster } from '../../src/render/compose.js'
import { DEFAULT_CURSOR_LOOK } from '../../src/render/cursor.js'
import {
  buildEncodePlan,
  sourceFrameForOutput,
} from '../../src/render/ffmpeg.js'
import type { Size } from '../../src/render/geometry.js'
import { composeFrame } from '../../src/render/pipeline.js'
import { formatSlug, renderRecording } from '../../src/render/render.js'
import { SpriteCache } from '../../src/render/sprite.js'

const run = promisify(execFile)

/**
 * A scratch directory that is actually given back.
 *
 * These tests made a dozen of them per run and removed none. Over a few hundred
 * runs — a mutation sweep is exactly that — they filled a 14GB `tmpfs`, and the
 * suite then failed with `No space left on device` on tests that had nothing to
 * do with the change under test. A test rig that degrades the machine it runs
 * on cannot be trusted to report on anything else.
 */
const scratchDirectories: string[] = []

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  scratchDirectories.push(directory)
  return directory
}

afterAll(async () => {
  await Promise.all(
    scratchDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

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

function meanAbsoluteDifference(a: Uint8Array, b: Uint8Array): number {
  let total = 0
  for (let i = 0; i < a.length; i += 1) {
    total += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
  }
  return total / a.length
}

/**
 * A composed frame put through exactly the colour conversion the encoder
 * applies, and left in the planar form the encoder actually sees.
 *
 * Comparing RGB against RGB counts 4:2:0 chroma subsampling as an error: on the
 * saturated edges of a synthetic test pattern that alone is a mean difference
 * of 7 to 10, which says nothing about whether the video followed the decision
 * data. In yuv420p at crf 0 the encode is lossless, so what is left is the
 * geometry — and the tolerance can stay tight instead of being widened until
 * the codec fits under it.
 */
async function composedAsEncoded(raster: Raster): Promise<Buffer> {
  const raw = join(await scratch('featurecast-rgb-'), 'frame.rgb')
  await writeFile(raw, raster.data)
  const { stdout } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${raster.width}x${raster.height}`,
      '-i',
      raw,
      '-vf',
      COLOUR_CHAIN,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 256 },
  )
  return stdout
}

/** One frame of a finished video, in the encoder's own planar form. */
async function encodedFrame(
  path: string,
  n: number,
  size: Size,
): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-vf',
      `select=eq(n\\,${String(n)})`,
      '-fps_mode',
      'passthrough',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 256 },
  )
  return stdout.subarray(0, (size.width * size.height * 3) / 2)
}

/** The encoder's colour chain, mirrored here so the test sees what it sees. */
const COLOUR_CHAIN = buildEncodePlan({ width: 2, height: 2 }, 60, 'unused.mp4')
  .arguments[
  buildEncodePlan({ width: 2, height: 2 }, 60, 'unused.mp4').arguments.indexOf(
    '-vf',
  ) + 1
] as string

const SOURCE = { width: 1280, height: 800 }
const FRAME_COUNT = 30
const FRAME_SPACING_MS = 1000 / 30
const STARTED_AT = 1_700_000_000_000
/**
 * The synthetic capture has a hole in it: no frame for 1500ms after the
 * fifteenth. That is what a still passage looks like in a real capture —
 * `captureScreencast` folds byte-identical frames into their predecessor, so
 * stillness shows up as a gap between surviving frames, not as repeated files.
 *
 * Without the hole this suite never ran the trimmer: 33ms of frame spacing
 * against a 600ms threshold means no gap ever qualified, so "idle trimming
 * works end to end" was an untested claim in two rounds of review.
 */
const IDLE_AFTER_FRAME = 15
const IDLE_GAP_MS = 1500

function frameTimestamp(index: number): number {
  const gap = index >= IDLE_AFTER_FRAME ? IDLE_GAP_MS : 0
  return STARTED_AT + index * FRAME_SPACING_MS + gap
}

const SESSION_DURATION_MS = FRAME_COUNT * FRAME_SPACING_MS + IDLE_GAP_MS

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
  const directory = await scratch('featurecast-render-')
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
      timestamp: frameTimestamp(index),
      viewport: SOURCE,
    })),
    session: {
      duration: SESSION_DURATION_MS,
      endedAt: STARTED_AT + SESSION_DURATION_MS,
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
  // At 166ms, well clear of the still stretch that starts at 500ms: an
  // interaction protects 250ms either side of itself, and a protected gap is
  // not trimmed. The trimmer has to be given something it is allowed to cut.
  events.push({
    type: 'click',
    tick: 10,
    x: 560,
    y: 260,
    bbox: { x: 500, y: 236, width: 120, height: 48 },
  })
  await writeFile(
    join(directory, 'events.jsonl'),
    `${events.map(serializeEvent).join('\n')}\n`,
    'utf8',
  )
  // The times beside the log, as the recorder writes them. This fixture is
  // synthetic, so the tick axis *is* its timeline — but the renderer no longer
  // knows how to read a tick, and rightly so: it reads what the recording says
  // the clock was. Writing that here keeps the fixture honest about the shape
  // a capture directory has.
  await writeFile(
    join(directory, 'event-times.jsonl'),
    serializeEventTimes(
      events.filter((event) => event.type !== 'header'),
      events
        .filter((event) => event.type !== 'header')
        .map((event) => STARTED_AT + (event.tick * 1000) / 60),
    ),
    'utf8',
  )
  return directory
}

type Probed = {
  color_primaries: string
  color_range: string
  color_space: string
  color_transfer: string
  height: number
  nb_read_frames?: string
  pix_fmt: string
  width: number
}

/**
 * What the finished file says about itself. Colour is in here on purpose: the
 * suite used to check the ffmpeg *argument string* and nothing else, so it kept
 * passing while `-color_range tv` silently failed to reach the H.264 VUI and
 * every output shipped untagged. An argument is an intention; `ffprobe` on a
 * real encode is the result.
 */
async function probe(path: string): Promise<Probed> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,pix_fmt,color_range,color_space,color_primaries,' +
      'color_transfer',
    '-of',
    'json',
    path,
  ])
  const parsed = JSON.parse(stdout) as { streams: Probed[] }
  const stream = parsed.streams[0]
  if (stream === undefined) throw new Error(`${path} has no video stream`)
  return stream
}

/** How many frames the finished file actually contains. */
async function countFrames(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-count_frames',
    '-show_entries',
    'stream=nb_read_frames',
    '-of',
    'json',
    path,
  ])
  const parsed = JSON.parse(stdout) as {
    streams: Array<{ nb_read_frames: string }>
  }
  return Number(parsed.streams[0]?.nb_read_frames ?? '0')
}

beforeAll(async () => {
  ffmpegAvailable = (await hasTool('ffmpeg')) && (await hasTool('ffprobe'))
}, 30_000)

describe('rendering a recording end to end', () => {
  it('turns one raw recording into three finished videos, with no browser', async (context) => {
    if (!ffmpegAvailable) context.skip()
    const capture = await makeCapture()
    const out = await scratch('featurecast-out-')
    const result = await renderRecording(capture, out)

    expect(result.outputs).toHaveLength(3)
    for (const output of result.outputs) {
      const probed = await probe(output.outputPath)
      expect(probed.width).toBe(output.width)
      expect(probed.height).toBe(output.height)
      // Colour, asserted on the file rather than on the command line that made
      // it. An untagged yuv420p stream is read as full range by anything that
      // guesses, and the levels get stretched on the way to the viewer.
      expect(probed.pix_fmt).toBe('yuv420p')
      expect(probed.color_range).toBe('tv')
      expect(probed.color_space).toBe('bt709')
      expect(probed.color_primaries).toBe('bt709')
      expect(probed.color_transfer).toBe('bt709')
    }
  }, 180_000)

  it('compresses the still passage, in the file and not just in the plan', async (context) => {
    if (!ffmpegAvailable) context.skip()
    const capture = await makeCapture()
    const out = await scratch('featurecast-idle-')
    const result = await renderRecording(capture, out, {
      formats: [{ label: '16:9', desired: { width: 640, height: 360 } }],
      encoder: { crf: 0, encoder: 'x264' },
    })

    // The capture is 1500ms of stillness plus a second of motion; the trimmer
    // keeps 250ms of the stillness. Both numbers are asserted, not just the
    // ratio: a trim that removed everything, or a capture that accidentally
    // stopped having a still passage, would otherwise look the same as success.
    expect(result.plan.idle.trimmed).toHaveLength(1)
    const gap = result.plan.idle.trimmed[0]
    expect(gap).toBeDefined()
    if (gap === undefined) return
    // **The trimmed stretch is the overlap, not the whole hole.** The gap
    // between surviving frames opens at 500ms, but this fixture's pointer is
    // still walking until 1000ms — its log carries a sample per tick up to
    // tick 60 — and a stretch the pointer moves through is not still however
    // unchanged the picture is. So the still stretch runs from the end of the
    // pointer path to the frame that ends the hole.
    const pointerEndsMs = (60 * 1000) / 60
    const stillMs =
      IDLE_AFTER_FRAME * FRAME_SPACING_MS + IDLE_GAP_MS - pointerEndsMs
    expect(gap.startMs).toBeCloseTo(pointerEndsMs, 0)
    expect(gap.endMs - gap.startMs).toBeCloseTo(stillMs, 0)
    expect(result.removedIdleSeconds).toBeCloseTo((stillMs - 250) / 1000, 2)
    expect(result.plan.idle.outputDurationMs).toBeCloseTo(
      SESSION_DURATION_MS - (stillMs - 250),
      0,
    )

    const output = result.outputs[0]
    expect(output).toBeDefined()
    if (output === undefined) return
    const frames = await countFrames(output.outputPath)
    // 60fps over the trimmed duration, give or take the last frame.
    const expectedFrames = Math.round(
      (result.plan.idle.outputDurationMs / 1000) * result.plan.fps,
    )
    expect(frames).toBeGreaterThanOrEqual(expectedFrames - 1)
    expect(frames).toBeLessThanOrEqual(expectedFrames + 1)
    // And the untrimmed recording would have been markedly longer, which is
    // the denominator of the claim above. Stated exactly rather than as a
    // margin: 750ms of the 1500ms hole is removed — the other half is the
    // stretch the pointer is still walking through, plus the 250ms the hold
    // keeps — and at 60fps that is 45 frames.
    const savedFrames = Math.round(((stillMs - 250) / 1000) * result.plan.fps)
    expect(savedFrames).toBe(45)
    expect(expectedFrames).toBe(
      Math.round((SESSION_DURATION_MS / 1000) * result.plan.fps) - savedFrames,
    )
  }, 180_000)

  it('writes the same decisions twice, byte for byte', async (context) => {
    if (!ffmpegAvailable) context.skip()
    const capture = await makeCapture()
    const first = await scratch('featurecast-a-')
    const second = await scratch('featurecast-b-')
    await renderRecording(capture, first, { dryRun: true })
    await renderRecording(capture, second, { dryRun: true })
    expect(await readFile(join(first, 'decisions.json'), 'utf8')).toBe(
      await readFile(join(second, 'decisions.json'), 'utf8'),
    )
  }, 120_000)

  it('renders the same video twice, in two separate processes, byte for byte', async (context) => {
    if (!ffmpegAvailable) context.skip()
    const capture = await makeCapture()
    const first = await scratch('featurecast-p1-')
    const second = await scratch('featurecast-p2-')
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

  it('renders the same video however many threads it is given', async (context) => {
    if (!ffmpegAvailable) context.skip()
    const capture = await makeCapture()
    const alone = await scratch('featurecast-t1-')
    const many = await scratch('featurecast-t4-')
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

  it('draws what decisions.json says, on the frame it says', async (context) => {
    if (!ffmpegAvailable) context.skip()
    const capture = await makeCapture()
    const out = await scratch('featurecast-follow-')
    // All three formats, not one: the zoomed landscape crop, the 1:1 crop and
    // the portrait strip that is copied 1:1 go through different code paths in
    // the compositor, and only one of them used to be checked.
    const result = await renderRecording(capture, out, {
      encoder: { crf: 0, encoder: 'x264' },
    })
    expect(result.plan.formats).toHaveLength(3)

    const sourceIndices = sourceFrameForOutput(result.plan)
    const sprites = new SpriteCache(DEFAULT_CURSOR_LOOK)
    let compared = 0
    for (const format of result.plan.formats) {
      // Spread across the whole video instead of one frame in the middle: the
      // first frame, one on each side of the trimmed still passage, and the
      // last one, where an accumulated timing drift would show up first.
      const last = format.frames.length - 1
      const jump = Math.round(
        ((format.frames[0]?.timeMs ?? 0) + 500) / (1000 / result.plan.fps),
      )
      const sampled = [...new Set([0, jump - 1, jump + 1, last])].filter(
        (n) => n >= 0 && n <= last,
      )
      expect(sampled.length).toBeGreaterThanOrEqual(4)
      for (const n of sampled) {
        // Decode the source frame the plan puts on screen at output frame `n`,
        // and compose that frame here from the decision data. The encoded frame
        // has to be the same picture — that is the whole claim: the video
        // follows the decisions rather than a command channel's idea of what
        // time it is.
        const decision = format.frames[n]
        const sourceIndex = sourceIndices[n] ?? 0
        expect(decision).toBeDefined()
        if (decision === undefined) continue
        const sourceFile = result.plan.frames[sourceIndex]?.file
        expect(sourceFile).toBeDefined()
        if (sourceFile === undefined) continue
        const source = await rawFrame(
          join(capture, 'frames', sourceFile),
          SOURCE,
          [],
        )
        const expectedRaster = createRaster(format.output)
        composeFrame(
          source,
          decision,
          { geometry: sprites.geometry, sprites },
          expectedRaster,
        )
        const actual = await encodedFrame(
          join(out, `${formatSlug(format.label)}.mp4`),
          n,
          format.output,
        )
        const expected = await composedAsEncoded(expectedRaster)
        expect(actual.length).toBe(expected.length)
        expect(meanAbsoluteDifference(expected, actual)).toBeLessThan(3)
        compared += 1
      }
    }
    // The denominator: twelve comparisons, three formats, four frames each. A
    // green run over two of them would mean nothing.
    expect(compared).toBe(12)
  }, 600_000)

  it('re-renders a changed look without the capture directory changing', async (context) => {
    if (!ffmpegAvailable) context.skip()
    const capture = await makeCapture()
    const out = await scratch('featurecast-look-')
    const before = await renderRecording(capture, out, {
      dryRun: true,
      formats: [{ label: '16:9', desired: { width: 640, height: 360 } }],
      zoom: { paddingPx: 8 },
    })
    const after = await renderRecording(capture, out, {
      dryRun: true,
      formats: [{ label: '16:9', desired: { width: 640, height: 360 } }],
      zoom: { paddingPx: 240 },
    })
    const beforeCrops = before.plan.formats[0]?.frames.map(
      (frame) => frame.crop,
    )
    const afterCrops = after.plan.formats[0]?.frames.map((frame) => frame.crop)
    expect(beforeCrops).not.toEqual(afterCrops)
  }, 120_000)
})
