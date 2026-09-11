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
  resolveM1CaptureArguments,
  runOnlyDashMotion,
  warmUpOnlyDash,
} from '../src/m1-benchmark.js'
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
  validateRepeatedFrameReport,
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
  const capture = await captureScreencast(page, outputDirectory, async () => {
    await runInteractions(
      { out: outputDirectory, seed: 1, settleTimeoutMs: 10_000 },
      async (_recordPage, demo) => {
        motionWindows = await runOnlyDashMotion(page, demo)
      },
    )
  })
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
    capture.clampedTimestampCount,
  )
  console.log(
    `source cadence: ${String(cadence.frameCount)} frames, median ${cadence.medianIntervalMs.toFixed(2)}ms, p95 ${cadence.p95IntervalMs.toFixed(2)}ms, ${(cadence.shareUnderTwentyMs * 100).toFixed(1)}% of gaps <=20ms, ${String(cadence.droppedDuplicateFrameCount)} duplicate source frames folded away`,
  )

  const { durationSeconds } = await assembleScreencast(
    outputDirectory,
    `${outputDirectory}/output.mp4`,
  )
  await probeOutput(`${outputDirectory}/output.mp4`, durationSeconds)

  // Content-based acceptance gate: ffprobe and adjacent-source-frame
  // hashing cannot tell 30s of motion from an 11s slideshow padded to the
  // right duration. ffmpeg's freezedetect (the previous version of this
  // gate) cannot either, above a certain grain: it requires >=1s of no
  // change to register anything, so a video that changes content once per
  // second sails through regardless of how static each of those seconds
  // is. `repeats.ts` instead maps every 60fps output frame to its source
  // frame via the exact `timeline.ffconcat` ffmpeg was fed — exact, not a
  // perceptual approximation, and with no minimum-duration floor — and
  // judges the share of output frames that are exact repeats.
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
      `repeated share inside motion windows: ${(repeatedFrameReport.motionWindowRepeatedShare * 100).toFixed(1)}%, ` +
      `repeated share of scroll windows: ${(repeatedFrameReport.scrollWindowRepeatedShare * 100).toFixed(1)}%, ` +
      `repeated share of whole run: ${(repeatedFrameReport.overallRepeatedShare * 100).toFixed(1)}%`,
  )
  validateRepeatedFrameReport(repeatedFrameReport)

  await context.close()
} finally {
  await browser.close()
}
