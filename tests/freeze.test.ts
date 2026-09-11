import { describe, expect, it } from 'vitest'

import {
  computeMotionQuality,
  detectFreezes,
  parseFreezeIntervals,
  validateMotionQuality,
} from '../src/freeze.js'

// Real ffmpeg stderr shape (`-v info`, `freezedetect`), captured against a
// real m1-002-style recording with two dead scroll passes.
const SAMPLE_STDERR = `
[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_start: 1.366667
[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_duration: 4.6
[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_end: 5.966667
[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_start: 6.4
[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_duration: 4.816667
[Parsed_freezedetect_0 @ 0x1] lavfi.freezedetect.freeze_end: 11.216667
`

describe('parseFreezeIntervals', () => {
  it('parses ffmpeg freezedetect stderr into intervals', () => {
    expect(parseFreezeIntervals(SAMPLE_STDERR)).toEqual([
      { durationSeconds: 4.6, endSeconds: 5.966667, startSeconds: 1.366667 },
      { durationSeconds: 4.816667, endSeconds: 11.216667, startSeconds: 6.4 },
    ])
  })

  it('returns an empty array when nothing froze', () => {
    expect(parseFreezeIntervals('no freezes here')).toEqual([])
  })
})

describe('detectFreezes', () => {
  it('runs ffmpeg with the freezedetect filter and parses its stderr', async () => {
    const runner = async (arguments_: readonly string[]) => {
      expect(arguments_).toEqual([
        '-v',
        'info',
        '-i',
        '/tmp/output.mp4',
        '-vf',
        'freezedetect=n=0.001:d=1',
        '-f',
        'null',
        '-',
      ])
      return SAMPLE_STDERR
    }

    const freezes = await detectFreezes('/tmp/output.mp4', 0.001, 1, runner)

    expect(freezes).toHaveLength(2)
  })
})

// Three shapes proven live against real ffmpeg output in the M1 report
// (frozen-bad.mp4, slideshow.mp4, accept.mp4): a single long freeze, a
// slideshow of short windows each individually under any per-window
// tolerance but frozen almost the whole time, and a genuinely
// motion-dominated run with brief, tolerable settle time.
describe('computeMotionQuality / validateMotionQuality', () => {
  it('rejects case A: one long freeze inside a single motion window', () => {
    const freezes = [{ durationSeconds: 10, endSeconds: 15, startSeconds: 5 }]
    const windows = [{ end: 16, label: 'scripted-motion', start: 6 }]

    const quality = computeMotionQuality(freezes, windows, 20)

    expect(quality.frozenShareOfMotionWindows).toBeCloseTo(0.9, 5)
    expect(() => validateMotionQuality(quality)).toThrow(
      'scripted motion-window time',
    )
  })

  it('rejects case B: a sawtooth of short windows each individually under a per-window tolerance', () => {
    const freezes = Array.from({ length: 19 }, (_value, index) => ({
      durationSeconds: 1,
      endSeconds: index * 1.05 + 1,
      startSeconds: index * 1.05,
    }))
    const windows = Array.from({ length: 19 }, (_value, index) => ({
      end: index * 1.05 + 1.05,
      label: `table:${String(index)}`,
      start: index * 1.05,
    }))

    const quality = computeMotionQuality(freezes, windows, 19.95)

    // Every individual window's freeze (1.0s of ~1.05s) would pass any
    // per-window tolerance above 1.0s — the bug this replaces. The
    // aggregate share does not.
    expect(quality.frozenShareOfMotionWindows).toBeGreaterThan(0.9)
    expect(() => validateMotionQuality(quality)).toThrow(
      'scripted motion-window time',
    )
  })

  it('accepts a motion-dominated run with brief, tolerable settle time', () => {
    // 10 windows of 2s: 0.3s settle + 1.7s of real scroll/transition motion.
    const freezes = Array.from({ length: 10 }, (_value, index) => ({
      durationSeconds: 0.3,
      endSeconds: index * 2 + 0.3,
      startSeconds: index * 2,
    }))
    const windows = Array.from({ length: 10 }, (_value, index) => ({
      end: index * 2 + 2,
      label: `table:${String(index)}`,
      start: index * 2,
    }))

    const quality = computeMotionQuality(freezes, windows, 20)

    expect(quality.frozenShareOfMotionWindows).toBeCloseTo(0.15, 5)
    expect(() => validateMotionQuality(quality)).not.toThrow()
  })
})
