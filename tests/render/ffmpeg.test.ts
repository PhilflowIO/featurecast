import { describe, expect, it } from 'vitest'

import {
  buildDecodePlan,
  buildEncodePlan,
  buildSourceList,
  sourceFrameForOutput,
} from '../../src/render/ffmpeg.js'
import type { FormatPlan, RenderPlan } from '../../src/render/plan.js'

const BASE = { x: 0, y: 0, width: 2560, height: 1440 }

function format(overrides: Partial<FormatPlan> = {}): FormatPlan {
  return {
    aspect: '16:9',
    base: BASE,
    clamps: [],
    frames: [
      { crop: BASE, cursor: null, n: 0, timeMs: 0 },
      { crop: BASE, cursor: null, n: 1, timeMs: 16.667 },
    ],
    maxZoom: 2560 / 1920,
    output: { width: 1920, height: 1080 },
    panBounds: BASE,
    segments: [],
    ...overrides,
  }
}

const PLAN: RenderPlan = {
  frames: [
    { file: 'frame-000000.jpg', outputMs: 0 },
    { file: 'frame-000001.jpg', outputMs: 16 },
  ],
  formats: [format()],
  fps: 60,
  idle: { outputDurationMs: 33, removedMs: 0, trimmed: [] },
  source: { width: 2560, height: 1600 },
  version: 1,
}

describe('the source frame list', () => {
  it('writes absolute paths, because concat resolves against its own directory', () => {
    const list = buildSourceList('out/frames', PLAN)
    expect(list.split('\n')[1]).toMatch(/^file '\/.*frame-000000\.jpg'$/)
  })

  it('lists every captured frame exactly once, in capture order', () => {
    const list = buildSourceList('out/frames', PLAN)
    const entries = list.split('\n').filter((line) => line.startsWith('file '))
    expect(entries).toHaveLength(PLAN.frames.length)
    expect(entries[0]).toContain('frame-000000.jpg')
    expect(entries[1]).toContain('frame-000001.jpg')
  })

  it('carries no output timing at all — retiming is not ffmpeg’s job', () => {
    const list = buildSourceList('out/frames', PLAN)
    // Every entry gets the same placeholder duration purely to keep the
    // demuxer's timestamps monotonic. Nothing downstream reads it.
    const durations = new Set(
      list.split('\n').filter((line) => line.startsWith('duration ')),
    )
    expect([...durations]).toEqual(['duration 1'])
  })

  it('refuses a plan with no frames', () => {
    expect(() =>
      buildSourceList('out/frames', { ...PLAN, frames: [] }),
    ).toThrow(/no frames/)
  })
})

describe('which source frame is on screen', () => {
  function plan(
    frames: ReadonlyArray<{ file: string; outputMs: number }>,
    outputDurationMs: number,
    fps = 60,
  ): RenderPlan {
    return {
      ...PLAN,
      fps,
      frames,
      idle: { outputDurationMs, removedMs: 0, trimmed: [] },
    }
  }

  it('holds a frame for as long as the next one has not arrived', () => {
    const indices = sourceFrameForOutput(
      plan(
        [
          { file: 'a', outputMs: 0 },
          { file: 'b', outputMs: 100 },
        ],
        200,
      ),
    )
    expect(indices).toHaveLength(12)
    expect([...indices]).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1])
  })

  it('skips the frames a trimmed stretch collapsed', () => {
    // Five captured frames crowded into 20ms of output, which is what a
    // compressed idle stretch looks like: at 60fps the timeline steps straight
    // over the ones whose slot is narrower than a frame.
    const indices = sourceFrameForOutput(
      plan(
        [
          { file: 'a', outputMs: 0 },
          { file: 'b', outputMs: 5 },
          { file: 'c', outputMs: 10 },
          { file: 'd', outputMs: 15 },
          { file: 'e', outputMs: 20 },
        ],
        50,
      ),
    )
    expect([...indices]).toEqual([0, 3, 4])
  })

  it('never goes backwards, so the decoder can be read in one pass', () => {
    const indices = sourceFrameForOutput(
      plan(
        Array.from({ length: 40 }, (_, index) => ({
          file: `f${String(index)}`,
          outputMs: index * 37,
        })),
        1480,
      ),
    )
    for (let n = 1; n < indices.length; n += 1) {
      expect(indices[n] ?? 0).toBeGreaterThanOrEqual(indices[n - 1] ?? 0)
    }
  })

  it('is the same mapping at 30fps as at 60fps, sampled differently', () => {
    const frames = Array.from({ length: 20 }, (_, index) => ({
      file: `f${String(index)}`,
      outputMs: index * 50,
    }))
    const sixty = sourceFrameForOutput(plan(frames, 1000, 60))
    const thirty = sourceFrameForOutput(plan(frames, 1000, 30))
    for (let n = 0; n < thirty.length; n += 1) {
      expect(thirty[n]).toBe(sixty[n * 2])
    }
  })
})

describe('the ffmpeg jobs that are left', () => {
  it('decodes one frame per file and resamples nothing', () => {
    const decode = buildDecodePlan('/tmp/list.ffconcat')
    expect(decode.arguments).toContain('/tmp/list.ffconcat')
    expect(decode.arguments.join(' ')).toContain('-fps_mode passthrough')
    expect(decode.arguments.join(' ')).toContain('-pix_fmt rgb24')
  })

  it('encodes finished frames, with no geometry filter to get wrong', () => {
    const encode = buildEncodePlan(
      { width: 1920, height: 1080 },
      60,
      '/tmp/out.mp4',
    )
    const line = encode.arguments.join(' ')
    expect(line).toContain('-s 1920x1080')
    expect(line).toContain('-r 60')
    expect(line).not.toContain('sendcmd')
    expect(line).not.toContain('crop=')
    expect(line).not.toContain('overlay')
  })

  it('remaps the full-range JPEG levels rather than relabelling them', () => {
    const encode = buildEncodePlan(
      { width: 1920, height: 1080 },
      60,
      '/tmp/out.mp4',
    )
    expect(encode.arguments.join(' ')).toContain(
      'scale=in_range=full:out_range=tv',
    )
  })

  it('keeps the library version out of the container, so two renders match', () => {
    const encode = buildEncodePlan(
      { width: 1080, height: 1080 },
      30,
      '/tmp/out.mp4',
    )
    expect(encode.arguments).toContain('+bitexact')
  })

  it('passes the encoder settings through', () => {
    const encode = buildEncodePlan(
      { width: 1920, height: 1080 },
      60,
      '/tmp/out.mp4',
      { crf: 23, preset: 'veryfast' },
    )
    expect(encode.arguments[encode.arguments.indexOf('-crf') + 1]).toBe('23')
    expect(encode.arguments[encode.arguments.indexOf('-preset') + 1]).toBe(
      'veryfast',
    )
  })
})
