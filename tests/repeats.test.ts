import { describe, expect, it } from 'vitest'

import {
  computeRepeatedFrameReport,
  mapOutputFramesToSource,
  parseTimelineSpans,
  validateRepeatedFrameReport,
  type SourceFrameSpan,
} from '../src/repeats.js'

describe('parseTimelineSpans', () => {
  it('parses an ffconcat file into cumulative display spans', () => {
    const ffconcat =
      'ffconcat version 1.0\n' +
      "file '/tmp/frames/frame-000000.jpg'\n" +
      'option framerate 1000\n' +
      'duration 0.1\n' +
      "file '/tmp/frames/frame-000001.jpg'\n" +
      'option framerate 1000\n' +
      'duration 0.2\n' +
      "file '/tmp/frames/frame-000001.jpg'\n" +
      'option framerate 1000\n'

    expect(parseTimelineSpans(ffconcat)).toEqual([
      { end: 0.1, file: '/tmp/frames/frame-000000.jpg', index: 0, start: 0 },
      {
        end: 0.30000000000000004,
        file: '/tmp/frames/frame-000001.jpg',
        index: 1,
        start: 0.1,
      },
    ])
  })
})

/** Builds spans for `count` equal-length slides of `slideSeconds` each. */
function slideSpans(count: number, slideSeconds: number): SourceFrameSpan[] {
  return Array.from({ length: count }, (_value, index) => ({
    end: (index + 1) * slideSeconds,
    file: `frame-${String(index)}.jpg`,
    index,
    start: index * slideSeconds,
  }))
}

describe('mapOutputFramesToSource / computeRepeatedFrameReport', () => {
  it('maps output frames to the correct source span', () => {
    const spans = slideSpans(2, 0.05) // 0.1s total = 6 output frames
    const map = mapOutputFramesToSource(spans)
    expect(map).toEqual([0, 0, 0, 1, 1, 1])
  })

  it('rejects case E: ~22 slides of ~0.9s, ~1.1 distinct frames per second', () => {
    // Gate-constructed counter-example that passed the old freezedetect
    // (d=1) gate at 0.0%/0.0%: every slide changes once, but the change is
    // only ~1/54 of that slide's 54 output frames, so nothing here is ever
    // frozen for a full second.
    const spans = slideSpans(22, 0.9)
    const map = mapOutputFramesToSource(spans)
    const windows = [{ end: 19.8, label: 'scripted-motion', start: 0 }]

    const report = computeRepeatedFrameReport(map, windows)

    expect(report.motionWindowRepeatedShare).toBeGreaterThan(0.9)
    expect(() => validateRepeatedFrameReport(report)).toThrow(
      'exceeds the 40% limit',
    )
  })

  it('rejects case F: 7x[1.05s hard freeze + 1.65s of 1.8fps stutter]', () => {
    // 28 distinct source frames across 18.9s: one long span per cycle
    // (1.05s) plus 3 stutter spans per cycle (1.65s / 1.8fps ~= 0.55s each).
    const spans: SourceFrameSpan[] = []
    let cursor = 0
    let index = 0
    for (let cycle = 0; cycle < 7; cycle += 1) {
      spans.push({
        end: cursor + 1.05,
        file: `freeze-${String(cycle)}.jpg`,
        index,
        start: cursor,
      })
      cursor += 1.05
      index += 1
      for (let stutter = 0; stutter < 3; stutter += 1) {
        spans.push({
          end: cursor + 0.55,
          file: `stutter-${String(cycle)}-${String(stutter)}.jpg`,
          index,
          start: cursor,
        })
        cursor += 0.55
        index += 1
      }
    }
    const map = mapOutputFramesToSource(spans)
    const windows = [{ end: cursor, label: 'scripted-motion', start: 0 }]

    const report = computeRepeatedFrameReport(map, windows)

    expect(report.motionWindowRepeatedShare).toBeGreaterThan(0.9)
    expect(() => validateRepeatedFrameReport(report)).toThrow(
      'exceeds the 40% limit',
    )
  })

  it('accepts a genuinely motion-dominated run', () => {
    // A new source frame every 10ms (100fps, above the 60fps output rate)
    // for 3.33s — real continuous motion, not a slideshow.
    const spans = slideSpans(333, 0.01)
    const map = mapOutputFramesToSource(spans)
    const windows = [{ end: 3.33, label: 'scroll-down', start: 0 }]

    const report = computeRepeatedFrameReport(map, windows)

    expect(report.motionWindowRepeatedShare).toBeLessThan(0.4)
    expect(() => validateRepeatedFrameReport(report)).not.toThrow()
  })

  it('reports scroll-window share separately from the overall motion-window share', () => {
    const spans = slideSpans(4, 0.5)
    const map = mapOutputFramesToSource(spans)
    const windows = [
      { end: 1, label: 'dark-mode-toggle', start: 0 },
      { end: 2, label: 'tasks:scroll-down', start: 1 },
    ]

    const report = computeRepeatedFrameReport(map, windows)

    expect(report.windows).toHaveLength(2)
    expect(report.scrollWindowRepeatedShare).toBeGreaterThanOrEqual(0)
  })
})
