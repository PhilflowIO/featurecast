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

    const report = computeCaptureEfficiencyReport(
      manifest,
      windows,
      presented,
      [],
    )

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

    const report = computeCaptureEfficiencyReport(
      manifest,
      windows,
      presented,
      [],
    )

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

    const report = computeCaptureEfficiencyReport(
      manifest,
      windows,
      presented,
      [],
    )

    expect(report.overallEfficiency).toBe(1)
    expect(report.windows[0]?.presentedFps).toBeCloseTo(4, 5)
  })

  it('treats a window with zero presentations as fully efficient, not a division-by-zero failure', () => {
    const manifest = manifestWithFrameTimestamps([])
    const windows: MotionWindow[] = [{ end: 100, label: 'idle', start: 0 }]

    const report = computeCaptureEfficiencyReport(manifest, windows, [], [])

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

    const report = computeCaptureEfficiencyReport(
      manifest,
      windows,
      presented,
      [],
    )

    expect(report.windows[0]?.presentedFrameCount).toBe(2) // 0, 50
    expect(report.windows[1]?.presentedFrameCount).toBe(2) // 100, 150
  })

  it("carries each window's own length through to the refresh bound", () => {
    // A three-second window presenting a steady 50fps is ordinary content,
    // and the 60Hz bound has to be measured against *this* window's three
    // seconds. Hard-coding one second anywhere on that path turns 150
    // honest presentations into an impossible 150fps and fails a good run —
    // the bound would then be a statement about window length, not about
    // the compositor.
    const presented = evenlySpaced(150, 0, 3_000)
    const report = computeCaptureEfficiencyReport(
      manifestWithFrameTimestamps(presented),
      [{ end: 3_000, label: 'tasks:scroll-down:long', start: 0 }],
      presented,
      [],
    )

    expect(report.windows[0]?.durationSeconds).toBe(3)
    expect(report.windows[0]?.presentedFps).toBeCloseTo(50, 5)
    expect(() => {
      validateCaptureEfficiencyReport(report)
    }).not.toThrow()
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
  /**
   * Default duration puts the window at 50 presented frames per second —
   * below the 60Hz refresh ceiling, so these fixtures describe runs that
   * could physically have happened. A fixture that could not is not a
   * fixture, and the refresh check below has its own explicit durations.
   */
  function windowWith(
    captured: number,
    presented: number,
    label = 'scroll',
    durationSeconds = Math.max(presented / 50, 0.1),
  ): CaptureEfficiencyWindowFixture {
    return {
      capturedFrameCount: captured,
      capturedFps: captured / durationSeconds,
      durationSeconds,
      efficiency: presented > 0 ? captured / presented : 1,
      label,
      paintedFrameCount: presented,
      paintedFps: presented / durationSeconds,
      presentedFrameCount: presented,
      presentedFps: presented / durationSeconds,
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

  it('refuses a denominator above what a 60Hz compositor can present', () => {
    // The real window and the real number: `invoices:scroll-down:1` of a
    // product run on the AI box, 1.0245s long, for which the report-counting
    // denominator claimed 92 presented frames — 89.8 per second on a display
    // that refreshes 60 times a second. Nothing else in this file could see
    // that: the efficiency ratio was 0.66, comfortably below 1, and the
    // captured-over-presented check is satisfied by *any* inflated
    // denominator. This bound comes from the hardware, not from the numbers
    // it judges, which is the only reason it can fail when they agree.
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 61,
        overallEfficiency: 61 / 92,
        overallPaintedFrameCount: 61,
        overallPresentedFrameCount: 92,
        windows: [windowWith(61, 92, 'invoices:scroll-down:1', 1.0245)],
      }),
    ).toThrow(
      'invoices:scroll-down:1 (92 presented in 1.024s = 89.8fps) exceeds what a 60Hz compositor can present',
    )
  })

  it('passes the same window once the denominator counts instants', () => {
    // Same window, same duration, same captured count — only the
    // denominator changed from 92 reports to the 61 distinct presentation
    // instants behind them. 59.6fps, and the efficiency goes from 66% to
    // 100%. The pair is the point: the bound must reject one and accept the
    // other, or it is not measuring the defect.
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 61,
        overallEfficiency: 1,
        overallPaintedFrameCount: 61,
        overallPresentedFrameCount: 61,
        windows: [windowWith(61, 61, 'invoices:scroll-down:1', 1.0245)],
      }),
    ).not.toThrow()
  })

  it('leaves room for the sub-refresh instants real traces do contain', () => {
    // Partially presented frames land between refreshes: 5.4% of the gaps
    // in a real run are under 12ms. Measured over nine full runs and every
    // sub-3s stretch of each, the honest excess over the 60Hz line peaks at
    // 1.78 frames, so a window sitting 4 above it must still pass — the
    // defect it has to catch sits 35 to 51 above.
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 64,
        overallEfficiency: 1,
        overallPaintedFrameCount: 64,
        overallPresentedFrameCount: 65,
        windows: [windowWith(64, 65, 'dense-but-real', 1.0)],
      }),
    ).not.toThrow()
  })

  it('checks the refresh ceiling before the floor, so an impossible fail cannot mislead either', () => {
    // A run whose denominator is inflated reads *below* the floor, not
    // above it — that is how round one concluded the 95% gate was broken at
    // 81.3% when the honest number was 98.1%. The message has to name the
    // denominator, or the next reader fixes the wrong thing.
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 40,
        overallEfficiency: 0.4,
        overallPaintedFrameCount: 40,
        overallPresentedFrameCount: 100,
        windows: [windowWith(40, 100, 'inflated-and-low', 1.0)],
      }),
    ).toThrow(/exceeds what a 60Hz compositor can present/)
  })

  it('names the refresh ceiling first when a window trips both denominator checks', () => {
    // An inflated denominator can be overshot by the numerator as well. The
    // useful diagnosis is the one that says *why* the denominator is wrong,
    // not the one that says the numerator is bigger than it — the second
    // sends the reader into the capture path, which is not where the defect
    // is.
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 200,
        overallEfficiency: 2,
        overallPaintedFrameCount: 200,
        overallPresentedFrameCount: 100,
        windows: [windowWith(200, 100, 'both-wrong', 1.0)],
      }),
    ).toThrow(/exceeds what a 60Hz compositor can present/)
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
