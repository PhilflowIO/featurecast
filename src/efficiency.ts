import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { TimestampManifest } from './capture.js'
import type { MotionWindow } from './cadence.js'

export type CaptureEfficiencyWindow = {
  capturedFrameCount: number
  capturedFps: number
  /** `capturedFrameCount / paintedFrameCount`; 1 (not undefined) when nothing painted, so an idle window never reads as a loss. */
  efficiency: number
  label: string
  paintedFrameCount: number
  /** The app's own paint rate for this window — reported as context, never gated on (see `validateCaptureEfficiencyReport`'s doc comment). */
  paintedFps: number
}

export type CaptureEfficiencyReport = {
  overallCapturedFrameCount: number
  overallEfficiency: number
  overallPaintedFrameCount: number
  windows: CaptureEfficiencyWindow[]
}

/**
 * Compares, per scripted motion window, how many frames the page actually
 * painted (`paint-rate.ts`'s in-page `requestAnimationFrame` count) against
 * how many `captureScreencast` actually received (its own timestamp
 * manifest) — the two counters share the same `Date.now()`-domain clock, so
 * no reconciliation is needed beyond filtering both to `[window.start,
 * window.end)`.
 *
 * This is deliberately a different question from `cadence.ts`'s per-window
 * source cadence ("how fast did the source deliver frames") and from
 * `repeats.ts`'s repeated-frame share ("how much of the *output* is a
 * repeat"). Both of those mix two unrelated causes: the app's own paint
 * rate (not this pipeline's to fix) and any loss between paint and capture
 * (this pipeline's responsibility, if it is inside this pipeline at all —
 * see the next paragraph). Capture efficiency isolates the second cause
 * only: a window that legitimately paints at 20fps because of real
 * main-thread cost in the captured app can still score ~100% efficiency.
 *
 * Measured directly for M1 (`docs/CAPTURE-CADENCE.md`, "capture efficiency"
 * section): the gap between painted and captured frames during real
 * content does **not** originate in this file or in `capture.ts`. Isolated,
 * non-interactive synthetic fixtures prove it: a compositor-only dense
 * fixture (transform-animated, no layout) captured 98.9% of what it
 * painted; a fixture forcing real synchronous layout every frame (no DOM
 * churn) still captured 97.8%; but a fixture that creates and destroys real
 * DOM nodes every frame — the same technique MUI DataGrid's row
 * virtualization uses — reproduced a 45-86% efficiency loss with **zero**
 * Playwright interaction and a trivial (`() => count++`, no I/O) `onFrame`
 * callback, and lowering JPEG quality alone (less Chromium-side encode CPU
 * cost, same DOM churn) recovered it to 96.7%. The CDP
 * `Page.screencastFrameAck` round-trip stayed 1-2ms median in every case,
 * including the lossy ones, which rules out this pipeline's ack handling
 * or write queue as the cause: the loss happens inside Chromium's own
 * screencast frame production, competing with the captured page's own
 * DOM-mutation cost for CPU, before a frame ever reaches `onFrame`.
 */
export function computeCaptureEfficiencyReport(
  manifest: TimestampManifest,
  motionWindows: readonly MotionWindow[],
  paintTimestamps: readonly number[],
): CaptureEfficiencyReport {
  const windows = motionWindows.map((window) => {
    const durationSeconds = (window.end - window.start) / 1000
    const paintedFrameCount = paintTimestamps.filter(
      (timestamp) => timestamp >= window.start && timestamp < window.end,
    ).length
    const capturedFrameCount = manifest.frames.filter(
      (frame) =>
        frame.timestamp >= window.start && frame.timestamp < window.end,
    ).length
    return {
      capturedFrameCount,
      capturedFps:
        durationSeconds > 0 ? capturedFrameCount / durationSeconds : 0,
      efficiency:
        paintedFrameCount > 0 ? capturedFrameCount / paintedFrameCount : 1,
      label: window.label,
      paintedFrameCount,
      paintedFps: durationSeconds > 0 ? paintedFrameCount / durationSeconds : 0,
    }
  })

  const totals = windows.reduce(
    (accumulator, current) => ({
      captured: accumulator.captured + current.capturedFrameCount,
      painted: accumulator.painted + current.paintedFrameCount,
    }),
    { captured: 0, painted: 0 },
  )

  return {
    overallCapturedFrameCount: totals.captured,
    overallEfficiency:
      totals.painted > 0 ? totals.captured / totals.painted : 1,
    overallPaintedFrameCount: totals.painted,
    windows,
  }
}

/**
 * Below this, this pipeline is dropping frames the browser actually
 * painted — a real loss in the capture path (or, per the finding above,
 * inside Chromium's screencast production itself under heavy DOM churn),
 * distinct from the app's own paint rate. ~95%, not 100%: `paintTimestamps`
 * and the capture manifest are sampled a few ms apart at each window
 * boundary (the last `requestAnimationFrame` tick before a window's `end`
 * and the last screencast frame before it rarely land in the exact same
 * millisecond), so a couple of percent of boundary noise is expected even
 * at genuinely full efficiency.
 */
const DEFAULT_MIN_CAPTURE_EFFICIENCY = 0.95

/**
 * Gates on capture efficiency only — never on the page's own painted fps
 * (`paintedFps` is reported per window for context, per the M1 acceptance
 * brief: "report the page's painted rate per motion window as context, not
 * as pass/fail of our pipeline"). A window whose app content is genuinely
 * slow to paint is not this pipeline's failure as long as it captured
 * essentially everything that *was* painted.
 *
 * Gates on the aggregate across all motion-window time, not per window:
 * several scripted windows (e.g. `dark-mode-toggle`, ~0.4s) paint too few
 * frames for a per-window ratio to be statistically meaningful on its own.
 */
export function validateCaptureEfficiencyReport(
  report: CaptureEfficiencyReport,
  minEfficiency = DEFAULT_MIN_CAPTURE_EFFICIENCY,
): void {
  if (report.overallEfficiency < minEfficiency) {
    throw new Error(
      `Capture efficiency ${(report.overallEfficiency * 100).toFixed(1)}% (${String(report.overallCapturedFrameCount)} of ${String(report.overallPaintedFrameCount)} painted frames captured across scripted motion windows) is below the ${(minEfficiency * 100).toFixed(0)}% floor`,
    )
  }
}

/** Writes `capture-efficiency.json` next to the other M1 acceptance artifacts. */
export async function writeCaptureEfficiencyReport(
  captureDirectory: string,
  report: CaptureEfficiencyReport,
): Promise<void> {
  await writeFile(
    join(captureDirectory, 'capture-efficiency.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: 'wx' },
  )
}
