import { describe, expect, it } from 'vitest'

import {
  detectFreezes,
  parseFreezeIntervals,
  validateNoFrozenMotionWindows,
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

describe('validateNoFrozenMotionWindows', () => {
  const freezes = [
    { durationSeconds: 4.6, endSeconds: 5.97, startSeconds: 1.37 },
  ]

  it('rejects a motion window that overlaps a freeze beyond the tolerance', () => {
    expect(() =>
      validateNoFrozenMotionWindows(freezes, [
        { end: 6, label: 'sidebar-scroll-down', start: 0 },
      ]),
    ).toThrow('sidebar-scroll-down')
  })

  it('accepts a motion window with only a brief, tolerable overlap', () => {
    expect(() =>
      validateNoFrozenMotionWindows(
        freezes,
        [{ end: 1.7, label: 'dark-mode-toggle', start: 1.2 }],
        1,
      ),
    ).not.toThrow()
  })

  it('accepts a motion window that does not overlap any freeze at all', () => {
    expect(() =>
      validateNoFrozenMotionWindows(freezes, [
        { end: 20, label: 'table:tasks', start: 12 },
      ]),
    ).not.toThrow()
  })
})
