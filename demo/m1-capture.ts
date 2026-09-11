import { readFile } from 'node:fs/promises'

import { chromium } from 'playwright'

import { assembleScreencast } from '../src/assemble.js'
import { captureScreencast, type TimestampManifest } from '../src/capture.js'
import {
  validateNoDuplicateAdjacentFrames,
  writeCaptureStats,
} from '../src/cadence.js'
import {
  resolveM1CaptureArguments,
  runOnlyDashBenchmark,
} from '../src/m1-benchmark.js'
import { probeOutput } from '../src/probe.js'

const { outputDirectory, url } = resolveM1CaptureArguments(
  process.argv.slice(2),
)

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({
    viewport: { height: 1600, width: 2560 },
  })
  const page = await context.newPage()

  const capture = await captureScreencast(page, outputDirectory, async () => {
    await runOnlyDashBenchmark(page, url)
  })
  const manifest = JSON.parse(
    await readFile(capture.timestampsPath, 'utf8'),
  ) as TimestampManifest

  // Should always be zero: `captureScreencast` already folds any
  // byte-identical redelivered source frame into the previous frame's
  // duration instead of writing it. This is a regression check, not the
  // primary defense.
  await validateNoDuplicateAdjacentFrames(capture.framesDirectory)
  const cadence = await writeCaptureStats(outputDirectory, manifest)
  console.log(
    `source cadence: ${String(cadence.frameCount)} frames, median ${cadence.medianIntervalMs.toFixed(2)}ms, p95 ${cadence.p95IntervalMs.toFixed(2)}ms, ${(cadence.shareUnderTwentyMs * 100).toFixed(1)}% of gaps <=20ms, ${String(capture.droppedDuplicateFrameCount)} duplicate source frames folded away`,
  )

  const { durationSeconds } = await assembleScreencast(
    outputDirectory,
    `${outputDirectory}/output.mp4`,
  )
  await probeOutput(`${outputDirectory}/output.mp4`, durationSeconds)
  await context.close()
} finally {
  await browser.close()
}
