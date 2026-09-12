import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { TimestampManifest } from './capture.js'
import type { MotionWindow } from './cadence.js'

export type CaptureEfficiencyWindow = {
  capturedFrameCount: number
  capturedFps: number
  /** `capturedFrameCount / presentedFrameCount`; 1 (not undefined) when nothing was presented, so an idle window never reads as a loss. */
  efficiency: number
  label: string
  /**
   * The in-page change-tick count for this window (`src/paint-rate.ts`).
   * Context only, and known to undercount during compositor-driven scrolling
   * — it is kept because the gap between it and `presentedFrameCount` is
   * itself informative, not because it measures the page's frame rate.
   */
  paintedFrameCount: number
  /** `paintedFrameCount` as a rate; same caveat. */
  paintedFps: number
  /** Frames Chromium presented in this window — the denominator; see `src/presented.ts`. */
  presentedFrameCount: number
  /** The app's own presentation rate for this window — reported as context, never gated on (see `validateCaptureEfficiencyReport`'s doc comment). */
  presentedFps: number
}

export type CaptureEfficiencyReport = {
  overallCapturedFrameCount: number
  overallEfficiency: number
  overallPaintedFrameCount: number
  overallPresentedFrameCount: number
  windows: CaptureEfficiencyWindow[]
}

/**
 * Compares, per scripted motion window, how many frames Chromium actually
 * put on screen against how many `captureScreencast` received.
 *
 * **The denominator is Chromium's own presented-frame count**
 * (`src/presented.ts`), not a number this pipeline produces. That is the
 * whole point: a ratio is only as honest as the denominator it is measured
 * against, and this one used to be measured against an in-page
 * `requestAnimationFrame` probe that counted a tick whenever the page
 * signalled a visual change. That probe runs on the renderer's main thread
 * while smooth scrolling is driven by the compositor thread, so it
 * systematically undercounts exactly during a scroll — measured in one real
 * window, 66 frames presented against 51 ticks counted. An undercounting
 * denominator makes the ratio read better the worse things get, and on a
 * real acceptance run it reported **100.9%** capture efficiency, which the
 * 95% gate happily passed. Against the presented-frame count the same run
 * scores 83.3%. `paintedFrameCount` is still reported per window, as
 * context and as the visible size of that gap, but nothing is gated on it.
 *
 * This is deliberately a different question from `cadence.ts`'s per-window
 * source cadence ("how fast did the source deliver frames") and from
 * `repeats.ts`'s repeated-frame share ("how much of the *output* is a
 * repeat"). Both of those mix two unrelated causes: the app's own frame
 * rate (not this pipeline's to fix) and any loss between presentation and
 * capture (this pipeline's responsibility, if it is inside this pipeline at
 * all — see the next paragraph). Capture efficiency isolates the second
 * cause only: a window that legitimately presents at 20fps because of real
 * main-thread cost in the captured app can still score ~100% efficiency.
 *
 * Measured directly for M1 (`docs/CAPTURE-CADENCE.md`, "capture efficiency"
 * section): the gap between presented and captured frames during real
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
  presentedTimestamps: readonly number[],
  paintTimestamps: readonly number[] = [],
): CaptureEfficiencyReport {
  const countIn = (
    timestamps: readonly number[],
    window: MotionWindow,
  ): number =>
    timestamps.filter(
      (timestamp) => timestamp >= window.start && timestamp < window.end,
    ).length

  const windows = motionWindows.map((window) => {
    const durationSeconds = (window.end - window.start) / 1000
    const paintedFrameCount = countIn(paintTimestamps, window)
    const presentedFrameCount = countIn(presentedTimestamps, window)
    const capturedFrameCount = manifest.frames.filter(
      (frame) =>
        frame.timestamp >= window.start && frame.timestamp < window.end,
    ).length
    return {
      capturedFrameCount,
      capturedFps:
        durationSeconds > 0 ? capturedFrameCount / durationSeconds : 0,
      efficiency:
        presentedFrameCount > 0 ? capturedFrameCount / presentedFrameCount : 1,
      label: window.label,
      paintedFrameCount,
      paintedFps: durationSeconds > 0 ? paintedFrameCount / durationSeconds : 0,
      presentedFrameCount,
      presentedFps:
        durationSeconds > 0 ? presentedFrameCount / durationSeconds : 0,
    }
  })

  const totals = windows.reduce(
    (accumulator, current) => ({
      captured: accumulator.captured + current.capturedFrameCount,
      painted: accumulator.painted + current.paintedFrameCount,
      presented: accumulator.presented + current.presentedFrameCount,
    }),
    { captured: 0, painted: 0, presented: 0 },
  )

  return {
    overallCapturedFrameCount: totals.captured,
    overallEfficiency:
      totals.presented > 0 ? totals.captured / totals.presented : 1,
    overallPaintedFrameCount: totals.painted,
    overallPresentedFrameCount: totals.presented,
    windows,
  }
}

/**
 * Below this, this pipeline is dropping frames Chromium actually put on
 * screen — a real loss in the capture path (or, per the finding above,
 * inside Chromium's screencast production itself under heavy DOM churn),
 * distinct from the app's own frame rate. ~95%, not 100%: the presented
 * frames and the capture manifest are sampled a few ms apart at each window
 * boundary, so a couple of percent of boundary noise is expected even at
 * genuinely full efficiency.
 */
const DEFAULT_MIN_CAPTURE_EFFICIENCY = 0.95

/**
 * The most frames a single window may hold beyond what was presented in it
 * before the denominator itself is treated as broken.
 *
 * One, because that is exactly the boundary effect, and the boundary effect
 * is real: a frame presented shortly *before* a window opens can still be
 * delivered and stamped inside it. Measured across three full runs and 114
 * motion windows, exactly one window exceeded its denominator, by exactly
 * one frame (8 captured against 7 presented over 0.47s), and it was traced
 * to a presentation 15.6ms before the window's own start. Anything beyond
 * one frame is not carry-in, it is a denominator that does not measure what
 * it claims to.
 */
const MAX_BOUNDARY_CARRY_IN_FRAMES = 1

/**
 * Gates on capture efficiency only — never on the page's own presented fps
 * (`presentedFps` is reported per window for context, per the M1 acceptance
 * brief: "report the page's painted rate per motion window as context, not
 * as pass/fail of our pipeline"). A window whose app content is genuinely
 * slow to present is not this pipeline's failure as long as it captured
 * essentially everything that *was* presented.
 *
 * Gates on the aggregate across all motion-window time, not per window:
 * several scripted windows (e.g. `dark-mode-toggle`, ~0.4s) present too few
 * frames for a per-window ratio to be statistically meaningful on its own.
 *
 * **And it gates the denominator itself.** A capture cannot hold more frames
 * than the browser presented; if any window says otherwise by more than the
 * one frame of boundary carry-in above, the denominator is wrong and every
 * ratio built on it is meaningless — including a passing one. This is the
 * sibling assertion the old gate lacked: it read 100.9% and passed, because
 * a ratio alone cannot tell "we captured everything" from "we counted the
 * wrong thing".
 */
export function validateCaptureEfficiencyReport(
  report: CaptureEfficiencyReport,
  minEfficiency = DEFAULT_MIN_CAPTURE_EFFICIENCY,
): void {
  const impossible = report.windows.filter(
    (window) =>
      window.capturedFrameCount >
      window.presentedFrameCount + MAX_BOUNDARY_CARRY_IN_FRAMES,
  )
  if (impossible.length > 0) {
    const detail = impossible
      .map(
        (window) =>
          `${window.label} (${String(window.capturedFrameCount)} captured, ${String(window.presentedFrameCount)} presented)`,
      )
      .join(', ')
    throw new Error(
      `Capture efficiency denominator is not trustworthy: more frames were captured than Chromium presented in ${detail}. The ratio cannot be read until this is explained.`,
    )
  }
  if (report.overallEfficiency < minEfficiency) {
    throw new Error(
      `Capture efficiency ${(report.overallEfficiency * 100).toFixed(1)}% (${String(report.overallCapturedFrameCount)} of ${String(report.overallPresentedFrameCount)} presented frames captured across scripted motion windows) is below the ${(minEfficiency * 100).toFixed(0)}% floor`,
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
