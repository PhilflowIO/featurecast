import { describe, expect, it } from 'vitest'

import {
  computeCaptureEfficiencyReport,
  validateCaptureEfficiencyReport,
} from '../src/efficiency.js'
import type { TimestampManifest } from '../src/capture.js'
import type { MotionWindow } from '../src/cadence.js'

function manifestWithFrameTimestamps(timestamps: number[]): TimestampManifest {
  return {
    captureSize: { height: 1600, width: 2560 },
    frames: timestamps.map((timestamp, index) => ({
      file: `frame-${String(index)}.jpg`,
      timestamp,
      viewport: { height: 1600, width: 2560 },
    })),
    session: {
      duration: 1_000,
      endedAt: timestamps.at(-1) ?? 0,
      startedAt: timestamps[0] ?? 0,
    },
    version: 1,
  }
}

/** `count` evenly spaced timestamps across `[start, end)`, as a stand-in for a window's presentations. */
function evenlySpaced(count: number, start: number, end: number): number[] {
  const step = (end - start) / count
  return Array.from({ length: count }, (_, index) => start + index * step)
}

describe('computeCaptureEfficiencyReport', () => {
  it('scores 100% when every presented frame was captured', () => {
    const presented = [0, 16, 33, 50, 66, 83]
    const manifest = manifestWithFrameTimestamps(presented)
    const windows: MotionWindow[] = [{ end: 100, label: 'scroll', start: 0 }]

    const report = computeCaptureEfficiencyReport(manifest, windows, presented)

    expect(report.overallEfficiency).toBe(1)
    expect(report.windows[0]?.presentedFrameCount).toBe(6)
    expect(report.windows[0]?.capturedFrameCount).toBe(6)
  })

  it('scores partial efficiency when the source drops frames Chromium presented', () => {
    // Chromium presented 6 frames (real ~60fps), the screencast only
    // delivered 3 of them.
    const presented = [0, 16, 33, 50, 66, 83]
    const manifest = manifestWithFrameTimestamps([0, 33, 66])
    const windows: MotionWindow[] = [{ end: 100, label: 'scroll', start: 0 }]

    const report = computeCaptureEfficiencyReport(manifest, windows, presented)

    expect(report.overallEfficiency).toBeCloseTo(0.5, 5)
    expect(report.windows[0]?.efficiency).toBeCloseTo(0.5, 5)
  })

  it('does not penalize a window the app itself presented slowly', () => {
    // Only 2 real presentations in a 500ms window (the app's own cost, e.g.
    // real DOM-grid virtualization) but both were captured: this must score
    // ~100% efficiency even though `presentedFps` is far below 60.
    const presented = [0, 250]
    const manifest = manifestWithFrameTimestamps(presented)
    const windows: MotionWindow[] = [
      { end: 500, label: 'table:tasks:scroll-down', start: 0 },
    ]

    const report = computeCaptureEfficiencyReport(manifest, windows, presented)

    expect(report.overallEfficiency).toBe(1)
    expect(report.windows[0]?.presentedFps).toBeCloseTo(4, 5)
  })

  it('treats a window with zero presentations as fully efficient, not a division-by-zero failure', () => {
    const manifest = manifestWithFrameTimestamps([])
    const windows: MotionWindow[] = [{ end: 100, label: 'idle', start: 0 }]

    const report = computeCaptureEfficiencyReport(manifest, windows, [])

    expect(report.windows[0]?.efficiency).toBe(1)
    expect(report.overallEfficiency).toBe(1)
  })

  it('only counts frames inside each window, not the whole run', () => {
    const presented = [0, 50, 100, 150, 200]
    const manifest = manifestWithFrameTimestamps(presented)
    const windows: MotionWindow[] = [
      { end: 100, label: 'first', start: 0 },
      { end: 200, label: 'second', start: 100 },
    ]

    const report = computeCaptureEfficiencyReport(manifest, windows, presented)

    expect(report.windows[0]?.presentedFrameCount).toBe(2) // 0, 50
    expect(report.windows[1]?.presentedFrameCount).toBe(2) // 100, 150
  })

  it('reports the in-page change-tick count as context without letting it set the score', () => {
    // The real numbers from one scroll window of the patched-Chromium
    // acceptance run on the AI box: Chromium presented 66 frames, the
    // in-page `requestAnimationFrame` change-tick probe saw only 51 of them
    // (it runs on the main thread; the scroll is composited off it), and
    // the capture got 53. Against the tick count that window reads 104% —
    // the defect this denominator exists to end. Against the presented
    // count it reads 80%, and the tick count survives only as context.
    const windows: MotionWindow[] = [
      { end: 1_000, label: 'tasks:scroll-up:2', start: 0 },
    ]
    const report = computeCaptureEfficiencyReport(
      manifestWithFrameTimestamps(evenlySpaced(53, 0, 1_000)),
      windows,
      evenlySpaced(66, 0, 1_000),
      evenlySpaced(51, 0, 1_000),
    )

    expect(report.windows[0]?.presentedFrameCount).toBe(66)
    expect(report.windows[0]?.paintedFrameCount).toBe(51)
    expect(report.windows[0]?.capturedFrameCount).toBe(53)
    expect(report.windows[0]?.efficiency).toBeCloseTo(53 / 66, 5)
    expect(report.windows[0]?.efficiency).toBeLessThan(1)
  })
})

describe('validateCaptureEfficiencyReport', () => {
  function windowWith(
    captured: number,
    presented: number,
    label = 'scroll',
  ): CaptureEfficiencyWindowFixture {
    return {
      capturedFrameCount: captured,
      capturedFps: captured,
      efficiency: presented > 0 ? captured / presented : 1,
      label,
      paintedFrameCount: presented,
      paintedFps: presented,
      presentedFrameCount: presented,
      presentedFps: presented,
    }
  }
  type CaptureEfficiencyWindowFixture = Parameters<
    typeof validateCaptureEfficiencyReport
  >[0]['windows'][number]

  it('passes at or above the efficiency floor', () => {
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 95,
        overallEfficiency: 0.95,
        overallPaintedFrameCount: 100,
        overallPresentedFrameCount: 100,
        windows: [windowWith(95, 100)],
      }),
    ).not.toThrow()
  })

  it('rejects below the efficiency floor with the counts in the message', () => {
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 69,
        overallEfficiency: 0.69,
        overallPaintedFrameCount: 100,
        overallPresentedFrameCount: 100,
        windows: [windowWith(69, 100)],
      }),
    ).toThrow('69 of 100 presented frames captured')
  })

  it('never gates on a slow presented fps by itself', () => {
    // A window that presents at 5fps but captures everything it presents
    // must never fail this gate — that is the app's own cost, reported as
    // `presentedFps` context, not judged here.
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 10,
        overallEfficiency: 1,
        overallPaintedFrameCount: 10,
        overallPresentedFrameCount: 10,
        windows: [windowWith(10, 10, 'slow-real-content')],
      }),
    ).not.toThrow()
  })

  it('tolerates exactly one frame of boundary carry-in', () => {
    // Measured: across three full runs and 114 motion windows, exactly one
    // window held more frames than were presented in it, by exactly one
    // (8 captured against 7 presented over 0.47s), traced to a presentation
    // 15.6ms before that window's own start. Real, and not a broken
    // denominator.
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 8,
        overallEfficiency: 8 / 7,
        overallPaintedFrameCount: 7,
        overallPresentedFrameCount: 7,
        windows: [windowWith(8, 7, 'tasks:1:sort-asc')],
      }),
    ).not.toThrow()
  })

  it('refuses to report a ratio whose denominator the numerator overshoots', () => {
    // The sibling assertion the old gate lacked. A capture cannot hold more
    // frames than Chromium presented; when it appears to, the denominator
    // is measuring the wrong thing and *every* ratio built on it is void —
    // including a passing one. The old in-page denominator did exactly this
    // and the 95% gate read 100.9% and passed.
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 53,
        overallEfficiency: 53 / 51,
        overallPaintedFrameCount: 51,
        overallPresentedFrameCount: 51,
        windows: [windowWith(53, 51, 'tasks:scroll-up:2')],
      }),
    ).toThrow(
      'Capture efficiency denominator is not trustworthy: more frames were captured than Chromium presented in tasks:scroll-up:2 (53 captured, 51 presented)',
    )
  })

  it('checks the denominator before the floor, so an impossible pass cannot slip through', () => {
    // A report that is both over its denominator and above the floor used to
    // pass silently. It must now fail, and fail with the denominator's
    // message rather than the floor's.
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 100,
        overallEfficiency: 1.009,
        overallPaintedFrameCount: 99,
        overallPresentedFrameCount: 99,
        windows: [windowWith(100, 90, 'inflated')],
      }),
    ).toThrow(/denominator is not trustworthy/)
  })
})
