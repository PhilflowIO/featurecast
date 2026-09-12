import { readFile, writeFile } from 'node:fs/promises'

import { chromium, type Page } from 'playwright'

import { assembleScreencast } from '../src/assemble.js'
import { captureScreencast, type TimestampManifest } from '../src/capture.js'
import {
  computeMotionWindowCadence,
  validateNoDuplicateAdjacentFrames,
  writeCaptureStats,
  type MotionWindow,
} from '../src/cadence.js'
import {
  computeCaptureEfficiencyReport,
  validateCaptureEfficiencyReport,
  writeCaptureEfficiencyReport,
} from '../src/efficiency.js'
import {
  resolveM1CaptureArguments,
  runOnlyDashMotion,
  warmUpOnlyDash,
} from '../src/m1-benchmark.js'
import { readPaintTimestamps, startPaintRateProbe } from '../src/paint-rate.js'
import { startPresentedFrameTrace } from '../src/presented.js'
import { probeOutput } from '../src/probe.js'
import {
  createRecorder,
  type RecordPage,
  type RecordRuntime,
} from '../src/record.js'
import {
  computeRepeatedFrameReport,
  mapOutputFramesToSource,
  parseTimelineSpans,
} from '../src/repeats.js'
import {
  assertHardwareRenderer,
  detectRenderer,
  HARDWARE_GL_LAUNCH_ARGS,
} from '../src/renderer.js'

const { outputDirectory, url } = resolveM1CaptureArguments(
  process.argv.slice(2),
)

/**
 * Wraps the capture's own `page` (2560x1600 viewport, hardware-GL context)
 * as a `RecordRuntime` so the benchmark's interactions drive the merged
 * `demo` wrapper (60Hz-paced clicks/types/scrolls, `src/record.ts`)
 * against the exact same page `captureScreencast` is attached to, instead
 * of launching a second, uncaptured browser the way `record()`'s own
 * default runtime does.
 */
function capturedPageRuntime(page: Page): RecordRuntime {
  return {
    async run(_options, script) {
      const recordPage = page as unknown as RecordPage
      recordPage.hasTouch = false
      await script(recordPage)
    },
  }
}

const browser = await chromium.launch({
  args: [...HARDWARE_GL_LAUNCH_ARGS],
  headless: true,
})
try {
  const context = await browser.newContext({
    viewport: { height: 1600, width: 2560 },
  })
  const page = await context.newPage()

  const rendererInfo = await detectRenderer(page)
  console.log(`renderer: ${rendererInfo.renderer}`)
  assertHardwareRenderer(rendererInfo)

  // Signing in and reaching the data grid happens before capture starts:
  // recording it produced ~0.9s of blank white frames at the head of the
  // video, which is loading-screen time, not the 20s of dense UI M1 asks
  // for.
  await warmUpOnlyDash(page, url)

  const runInteractions = createRecorder(capturedPageRuntime(page))
  let motionWindows: MotionWindow[] = []
  // Chromium's own presented-frame count, the denominator capture
  // efficiency is measured against. Started before the capture so no
  // presented frame of the recording falls outside it; read only after the
  // recording has finished, so the trace never competes with the screencast
  // on the CDP channel while frames are flowing. See `src/presented.ts`.
  const presentedFrames = await startPresentedFrameTrace(browser, page)
  const capture = await captureScreencast(page, outputDirectory, async () => {
    // Started right before the scripted motion begins, on the same
    // Date.now()-domain clock the motion windows below and the capture
    // manifest already share — see `src/efficiency.ts` for why this,
    // rather than the source cadence or repeated-frame share, is the
    // metric that isolates this pipeline's own loss from the app's own
    // paint rate.
    await startPaintRateProbe(page)
    await runInteractions(
      { out: outputDirectory, seed: 1, settleTimeoutMs: 10_000 },
      async (_recordPage, demo) => {
        motionWindows = await runOnlyDashMotion(page, demo)
      },
    )
  })
  const paintTimestamps = await readPaintTimestamps(page)
  const presentedTimestamps = await presentedFrames.stop()
  const manifest = JSON.parse(
    await readFile(capture.timestampsPath, 'utf8'),
  ) as TimestampManifest

  // Should always be zero: `captureScreencast` already folds any
  // byte-identical redelivered source frame into the previous frame's
  // duration instead of writing it. This is a regression check, not the
  // primary defense.
  await validateNoDuplicateAdjacentFrames(capture.framesDirectory)
  const cadence = await writeCaptureStats(
    outputDirectory,
    manifest,
    capture.droppedDuplicateFrameCount,
    rendererInfo,
    capture.outOfDeliveryOrderFrameCount,
    capture.coincidentTimestampCount,
  )
  console.log(
    `source cadence: ${String(cadence.frameCount)} frames, median ${cadence.medianIntervalMs.toFixed(2)}ms, p95 ${cadence.p95IntervalMs.toFixed(2)}ms, ${(cadence.shareUnderTwentyMs * 100).toFixed(1)}% of gaps <=20ms, ${String(cadence.droppedDuplicateFrameCount)} duplicate source frames folded away, ${String(cadence.outOfDeliveryOrderFrameCount)} frames restored to capture order`,
  )

  const { durationSeconds } = await assembleScreencast(
    outputDirectory,
    `${outputDirectory}/output.mp4`,
  )
  await probeOutput(`${outputDirectory}/output.mp4`, durationSeconds)

  // Reported, not gated: the repeated-output-frame share mixes two
  // unrelated causes — this pipeline's own loss and the app's own paint
  // rate (real MUI DataGrid virtualization repaints far below 60fps during
  // scroll on this content/hardware, proven in docs/CAPTURE-CADENCE.md's
  // "capture efficiency" section; that is the app's cost, not a defect
  // here). ffmpeg's freezedetect (the previous version of this gate)
  // couldn't even see that distinction: it requires >=1s of no change to
  // register anything, so a video that changes content once per second
  // sails through regardless of how static each of those seconds is.
  // `repeats.ts` maps every 60fps output frame to its source frame via the
  // exact `timeline.ffconcat` ffmpeg was fed — exact, not a perceptual
  // approximation — and is kept here as a reported slideshow-detection
  // number (still fails loudly on synthetic slideshow counter-examples, see
  // `tests/repeats.test.ts`), while `capture-efficiency.json` below is what
  // M1 acceptance actually gates on.
  const timelineText = await readFile(
    `${outputDirectory}/timeline.ffconcat`,
    'utf8',
  )
  const sourceIndexPerOutputFrame = mapOutputFramesToSource(
    parseTimelineSpans(timelineText),
  )
  const motionWindowsSeconds = motionWindows.map((window) => ({
    end: (window.end - manifest.session.startedAt) / 1000,
    label: window.label,
    start: (window.start - manifest.session.startedAt) / 1000,
  }))
  const motionWindowCadence = computeMotionWindowCadence(
    manifest,
    motionWindows,
  )
  const repeatedFrameReport = computeRepeatedFrameReport(
    sourceIndexPerOutputFrame,
    motionWindowsSeconds,
  )
  await writeFile(
    `${outputDirectory}/motion-windows.json`,
    `${JSON.stringify(
      { repeatedFrameReport, windows: motionWindowCadence },
      null,
      2,
    )}\n`,
  )
  console.log(
    `motion windows: ${String(motionWindowCadence.length)}, ` +
      `repeated share inside motion windows: ${(repeatedFrameReport.motionWindowRepeatedShare * 100).toFixed(1)}% (reported, not gated), ` +
      `repeated share of scroll windows: ${(repeatedFrameReport.scrollWindowRepeatedShare * 100).toFixed(1)}% (reported, not gated), ` +
      `repeated share of whole run: ${(repeatedFrameReport.overallRepeatedShare * 100).toFixed(1)}% (reported, not gated)`,
  )

  // Content-independent acceptance gate: did we capture essentially
  // everything Chromium actually put on screen, regardless of how fast (or
  // slow) it was putting it there. See `src/efficiency.ts` for the measured
  // evidence behind the 95% floor, why the app's own rate is never gated,
  // and why the denominator is Chromium's presented-frame count rather than
  // anything this pipeline counts for itself.
  const efficiencyReport = computeCaptureEfficiencyReport(
    manifest,
    motionWindows,
    presentedTimestamps,
    paintTimestamps,
  )
  await writeCaptureEfficiencyReport(outputDirectory, efficiencyReport)
  // The denominator itself, not just the counts derived from it. Without
  // this file every claim about capture efficiency has to be taken on
  // trust: the trace is discarded at the end of the run, so nobody can
  // re-derive the presentation instants afterwards, re-check them against
  // the 60Hz refresh, or compare them to what the finished video shows.
  // Round one's denominator was wrong by half and the artifacts carried no
  // way to notice.
  await writeFile(
    `${outputDirectory}/presented.json`,
    `${JSON.stringify(presentedTimestamps)}\n`,
  )
  console.log(
    `capture efficiency: ${(efficiencyReport.overallEfficiency * 100).toFixed(1)}% ` +
      `(${String(efficiencyReport.overallCapturedFrameCount)} of ${String(efficiencyReport.overallPresentedFrameCount)} presented frames captured, gated at 95%)`,
  )
  for (const window of efficiencyReport.windows) {
    console.log(
      `  ${window.label}: presented ${window.presentedFps.toFixed(1)}fps (app's own rate, context only), ` +
        `in-page change ticks ${String(window.paintedFrameCount)} (context only), ` +
        `efficiency ${(window.efficiency * 100).toFixed(1)}%`,
    )
  }
  validateCaptureEfficiencyReport(efficiencyReport)

  await context.close()
} finally {
  await browser.close()
}
