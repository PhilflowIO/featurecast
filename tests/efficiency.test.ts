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

describe('computeCaptureEfficiencyReport', () => {
  it('scores 100% when every painted frame was captured', () => {
    const paintTimestamps = [0, 16, 33, 50, 66, 83]
    const manifest = manifestWithFrameTimestamps(paintTimestamps)
    const windows: MotionWindow[] = [{ end: 100, label: 'scroll', start: 0 }]

    const report = computeCaptureEfficiencyReport(
      manifest,
      windows,
      paintTimestamps,
    )

    expect(report.overallEfficiency).toBe(1)
    expect(report.windows[0]?.paintedFrameCount).toBe(6)
    expect(report.windows[0]?.capturedFrameCount).toBe(6)
  })

  it('scores partial efficiency when the source drops frames the page painted', () => {
    // Page painted 6 frames (real ~60fps), the source only delivered 3 of them.
    const paintTimestamps = [0, 16, 33, 50, 66, 83]
    const capturedTimestamps = [0, 33, 66]
    const manifest = manifestWithFrameTimestamps(capturedTimestamps)
    const windows: MotionWindow[] = [{ end: 100, label: 'scroll', start: 0 }]

    const report = computeCaptureEfficiencyReport(
      manifest,
      windows,
      paintTimestamps,
    )

    expect(report.overallEfficiency).toBeCloseTo(0.5, 5)
    expect(report.windows[0]?.efficiency).toBeCloseTo(0.5, 5)
  })

  it('does not penalize a window the app itself painted slowly', () => {
    // Only 2 real paints in a 500ms window (the app's own cost, e.g. real
    // DOM-grid virtualization) but both were captured: this must score
    // ~100% efficiency even though `paintedFps` is far below 60.
    const paintTimestamps = [0, 250]
    const manifest = manifestWithFrameTimestamps(paintTimestamps)
    const windows: MotionWindow[] = [
      { end: 500, label: 'table:tasks:scroll-down', start: 0 },
    ]

    const report = computeCaptureEfficiencyReport(
      manifest,
      windows,
      paintTimestamps,
    )

    expect(report.overallEfficiency).toBe(1)
    expect(report.windows[0]?.paintedFps).toBeCloseTo(4, 5)
  })

  it('treats a window with zero paints as fully efficient, not a division-by-zero failure', () => {
    const manifest = manifestWithFrameTimestamps([])
    const windows: MotionWindow[] = [{ end: 100, label: 'idle', start: 0 }]

    const report = computeCaptureEfficiencyReport(manifest, windows, [])

    expect(report.windows[0]?.efficiency).toBe(1)
    expect(report.overallEfficiency).toBe(1)
  })

  it('only counts frames inside each window, not the whole run', () => {
    const paintTimestamps = [0, 50, 100, 150, 200]
    const capturedTimestamps = [0, 50, 100, 150, 200]
    const manifest = manifestWithFrameTimestamps(capturedTimestamps)
    const windows: MotionWindow[] = [
      { end: 100, label: 'first', start: 0 },
      { end: 200, label: 'second', start: 100 },
    ]

    const report = computeCaptureEfficiencyReport(
      manifest,
      windows,
      paintTimestamps,
    )

    expect(report.windows[0]?.paintedFrameCount).toBe(2) // 0, 50
    expect(report.windows[1]?.paintedFrameCount).toBe(2) // 100, 150
  })
})

describe('validateCaptureEfficiencyReport', () => {
  it('passes at or above the efficiency floor', () => {
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 95,
        overallEfficiency: 0.95,
        overallPaintedFrameCount: 100,
        windows: [],
      }),
    ).not.toThrow()
  })

  it('rejects below the efficiency floor with the counts in the message', () => {
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 69,
        overallEfficiency: 0.69,
        overallPaintedFrameCount: 100,
        windows: [],
      }),
    ).toThrow('69 of 100 painted frames captured')
  })

  it('never gates on a slow painted fps by itself', () => {
    // A window that paints at 5fps but captures everything it paints must
    // never fail this gate — that is the app's own cost, reported as
    // `paintedFps` context, not judged here.
    expect(() =>
      validateCaptureEfficiencyReport({
        overallCapturedFrameCount: 10,
        overallEfficiency: 1,
        overallPaintedFrameCount: 10,
        windows: [
          {
            capturedFrameCount: 10,
            capturedFps: 5,
            efficiency: 1,
            label: 'slow-real-content',
            paintedFrameCount: 10,
            paintedFps: 5,
          },
        ],
      }),
    ).not.toThrow()
  })
})
