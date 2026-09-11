import { describe, expect, it } from 'vitest'

import {
  buildFfmpegPlan,
  buildGeometryCommands,
  buildRenderTimeline,
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
      {
        crop: { x: 100, y: 50, width: 1920, height: 1080 },
        cursor: null,
        n: 2,
        timeMs: 33.333,
      },
      {
        crop: { x: 140, y: 50, width: 1920, height: 1080 },
        cursor: null,
        n: 3,
        timeMs: 50,
      },
    ],
    maxZoom: 2560 / 1920,
    output: { width: 1920, height: 1080 },
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

describe('the retimed frame list', () => {
  it('writes absolute paths, because concat resolves against its own directory', () => {
    const timeline = buildRenderTimeline('out/frames', PLAN)
    expect(timeline.split('\n')[1]).toMatch(/^file '\/.*frame-000000\.jpg'$/)
  })

  it('gives every entry a millisecond timebase', () => {
    const timeline = buildRenderTimeline('out/frames', PLAN)
    const entries = timeline
      .split('\n')
      .filter((line) => line.startsWith('file '))
    const options = timeline
      .split('\n')
      .filter((line) => line === 'option framerate 1000')
    expect(options).toHaveLength(entries.length)
  })

  it('repeats the last frame so its own duration is honoured', () => {
    const timeline = buildRenderTimeline('out/frames', PLAN)
    const entries = timeline
      .split('\n')
      .filter((line) => line.startsWith('file '))
    expect(entries).toHaveLength(3)
    expect(entries[1]).toBe(entries[2])
  })

  it('takes its durations from the trimmed output timeline', () => {
    const timeline = buildRenderTimeline('out/frames', PLAN)
    expect(timeline).toContain('duration 0.016')
    expect(timeline).toContain('duration 0.017')
  })
})

describe('per-frame geometry commands', () => {
  it('writes a command only when something actually changed', () => {
    const commands = buildGeometryCommands(format(), 60, null)
    const lines = commands.trim().split('\n')
    // Four frames, but the second repeats the first exactly, so it costs no
    // line at all; the fourth moves only sideways, so it costs one value.
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('crop w 2560')
    expect(lines[1]).toContain('crop x 100')
    expect(lines[2]).toBe('0.050000-0.058333 [enter] crop x 140;')
  })

  it('parks the pointer far offscreen when there is nothing to draw', () => {
    const commands = buildGeometryCommands(format(), 60, {
      hotspotX: 80,
      hotspotY: 80,
      size: 160,
    })
    expect(commands).toContain('overlay x -20000')
  })

  it('places the pointer by its hotspot, not its corner', () => {
    const withCursor = format({
      frames: [
        {
          crop: BASE,
          cursor: {
            kind: 'arrow',
            ripplePhase: null,
            screenX: 500,
            screenY: 300,
          },
          n: 0,
          timeMs: 0,
        },
      ],
    })
    const commands = buildGeometryCommands(withCursor, 60, {
      hotspotX: 80,
      hotspotY: 80,
      size: 160,
    })
    expect(commands).toContain('overlay x 420')
    expect(commands).toContain('overlay y 220')
  })
})

describe('the encode', () => {
  it('crops and scales in one pass, driven by the command file', () => {
    const plan = buildFfmpegPlan(format(), PLAN, {
      commands: '/tmp/geom.cmds',
      cursorPattern: null,
      outputPath: '/tmp/out.mp4',
      timeline: '/tmp/timeline.ffconcat',
    })
    const filter = plan.arguments[plan.arguments.indexOf('-filter_complex') + 1]
    expect(filter).toContain('fps=60')
    expect(filter).toContain('sendcmd=f=/tmp/geom.cmds')
    expect(filter).toContain('crop=2560:1440:0:0')
    expect(filter).toContain('scale=1920:1080')
    expect(filter).toContain('in_range=full:out_range=tv')
    expect(filter).not.toContain('overlay')
  })

  it('composites the pointer sequence when there is one', () => {
    const plan = buildFfmpegPlan(format(), PLAN, {
      commands: '/tmp/geom.cmds',
      cursorPattern: '/tmp/cursor/%06d.png',
      outputPath: '/tmp/out.mp4',
      timeline: '/tmp/timeline.ffconcat',
    })
    expect(plan.arguments).toContain('/tmp/cursor/%06d.png')
    const filter = plan.arguments[plan.arguments.indexOf('-filter_complex') + 1]
    expect(filter).toContain('overlay=')
  })

  it('bounds the output to the trimmed duration', () => {
    const plan = buildFfmpegPlan(format(), PLAN, {
      commands: '/tmp/geom.cmds',
      cursorPattern: null,
      outputPath: '/tmp/out.mp4',
      timeline: '/tmp/timeline.ffconcat',
    })
    expect(plan.arguments[plan.arguments.indexOf('-t') + 1]).toBe('0.033')
  })
})
