import { readFile, writeFile } from 'node:fs/promises'

import { chromium } from 'playwright'

import { assembleScreencast } from '../src/assemble.js'
import { captureScreencast, type TimestampManifest } from '../src/capture.js'
import {
  computeMotionWindowCadence,
  validateNoDuplicateAdjacentFrames,
  writeCaptureStats,
  type MotionWindow,
} from '../src/cadence.js'
import { detectFreezes, validateNoFrozenMotionWindows } from '../src/freeze.js'
import {
  resolveM1CaptureArguments,
  runOnlyDashMotion,
  warmUpOnlyDash,
} from '../src/m1-benchmark.js'
import { probeOutput } from '../src/probe.js'
import {
  assertHardwareRenderer,
  detectRenderer,
  HARDWARE_GL_LAUNCH_ARGS,
} from '../src/renderer.js'

const { outputDirectory, url } = resolveM1CaptureArguments(
  process.argv.slice(2),
)

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

  let motionWindows: MotionWindow[] = []
  const capture = await captureScreencast(page, outputDirectory, async () => {
    motionWindows = await runOnlyDashMotion(page)
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
  // hashing cannot tell 30s of motion from an 11s slideshow padded out to
  // the right duration. freezedetect can.
  const freezes = await detectFreezes(`${outputDirectory}/output.mp4`)
  const motionWindowsSeconds = motionWindows.map((window) => ({
    end: (window.end - manifest.session.startedAt) / 1000,
    label: window.label,
    start: (window.start - manifest.session.startedAt) / 1000,
  }))
  const motionWindowCadence = computeMotionWindowCadence(
    manifest,
    motionWindows,
  )
  await writeFile(
    `${outputDirectory}/motion-windows.json`,
    `${JSON.stringify({ freezes, windows: motionWindowCadence }, null, 2)}\n`,
  )
  console.log(
    `motion windows: ${String(motionWindowCadence.length)}, freezes detected: ${String(freezes.length)}`,
  )
  validateNoFrozenMotionWindows(freezes, motionWindowsSeconds)

  await context.close()
} finally {
  await browser.close()
}
