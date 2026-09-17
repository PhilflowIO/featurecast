/**
 * Measures capture yield at a capture area of your choosing.
 *
 * One question only: capture efficiency, i.e. frames written to disk divided
 * by the frames Chromium reports it actually presented. The metric is NOT
 * reimplemented here — `src/presented.ts` supplies the denominator,
 * `src/efficiency.ts` computes and gates the ratio, and `src/browser.ts`
 * records which binary actually ran, exactly as `demo/m1-capture.ts` does.
 * This file is wiring.
 *
 * Why it exists next to `demo/m1-capture.ts`: that one is welded to
 * `CAPTURE_SIZE` (2560x1600) and to `runBenchMotion`. `src/session.ts` does
 * take a capture override through `resolveDevice`, but deliberately carries
 * none of the instrumentation ("What is deliberately not here: the M1
 * benchmark's instrumentation"). This is that instrumentation wrapped around
 * session.ts's own browser leg, with the capture area as an argument.
 *
 * Windows: the run is tiled into fixed slices covering the whole recording,
 * so nothing is cherry-picked — idle passages count too.
 *
 * Usage and what the output lines mean: docs/YIELD-BENCH.md.
 */
import { parseArgs } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'

import type { BrowserContext, Frame, Page } from 'playwright'

import {
  launchChromium,
  resolveBrowserRequest,
  writeBrowserProvenance,
} from '../src/browser.js'
import { captureScreencast, type TimestampManifest } from '../src/capture.js'
import type { MotionWindow } from '../src/cadence.js'
import { resolveDevice, type ResolvedDevice } from '../src/devices.js'
import {
  computeCaptureEfficiencyReport,
  validateCaptureEfficiencyReport,
  writeCaptureEfficiencyReport,
} from '../src/efficiency.js'
import { framedGeometry, openFramedSurface } from '../src/framed.js'
import { formatsFor, importScript, prepareCapture } from '../src/pipeline.js'
import { readPaintTimestamps, startPaintRateProbe } from '../src/paint-rate.js'
import { startPresentedFrameTrace } from '../src/presented.js'
import {
  createRecorder,
  type RecordPage,
  type RecordRuntime,
} from '../src/record.js'
import { renderRecording } from '../src/render/render.js'
import {
  assertHardwareRenderer,
  detectRenderer,
  HARDWARE_GL_LAUNCH_ARGS,
} from '../src/renderer.js'
import { contextOptionsFor, requireAppUrl } from '../src/session.js'
import { recordPageFor } from '../src/surface.js'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  args: process.argv.slice(2),
  options: {
    capture: { type: 'string' },
    device: { type: 'string' },
    out: { type: 'string' },
    passes: { type: 'string' },
    render: { type: 'string' },
    windowMs: { type: 'string' },
  },
  strict: true,
})

const scriptPath = positionals[0] ?? 'demo/fixture-tour.ts'
const outRoot = values.out ?? 'artifacts/yield'
const windowMs = Number(values.windowMs ?? '1000')
const passes = Number(values.passes ?? '1')
const [width, height] = (values.capture ?? '2560x1600').split('x').map(Number)
if (!Number.isInteger(width) || !Number.isInteger(height)) {
  throw new Error(`--capture wants WIDTHxHEIGHT, got "${values.capture ?? ''}"`)
}

const device: ResolvedDevice = resolveDevice({
  capture: { height: height as number, width: width as number },
  extends: values.device ?? 'desktop',
})
const capture = prepareCapture(device)
const script = await importScript(scriptPath)
requireAppUrl(device, script.url)

const captureArea = { height: capture.height, width: capture.width }
const captureDirectory = `${outRoot}/capture`

function capturedPageRuntime(recordPage: RecordPage): RecordRuntime {
  return {
    async run(_options, run) {
      await run(recordPage)
    },
  }
}

async function openSurface(
  context: BrowserContext,
  page: Page,
  resolved: ResolvedDevice,
): Promise<{ app: Frame; scale: number }> {
  if (resolved.capture.strategy === 'screencast') {
    return { app: page.mainFrame(), scale: 1 }
  }
  const geometry = framedGeometry(resolved.capture, resolved.device)
  return {
    app: await openFramedSurface(context, page, script.url as string, geometry),
    scale: geometry.scale,
  }
}

/** The whole recording, tiled — every frame of the run lands in exactly one window. */
function tiledWindows(manifest: TimestampManifest): MotionWindow[] {
  const windows: MotionWindow[] = []
  const { duration, startedAt } = manifest.session
  for (let offset = 0; offset < duration; offset += windowMs) {
    const end = Math.min(offset + windowMs, duration)
    windows.push({
      end: startedAt + end,
      label: `t${(offset / 1000).toFixed(1)}-${(end / 1000).toFixed(1)}s`,
      start: startedAt + offset,
    })
  }
  return windows
}

const startedAtWall = Date.now()
const { browser, provenance } = await launchChromium(
  { args: [...HARDWARE_GL_LAUNCH_ARGS], headless: true },
  resolveBrowserRequest(process.env),
)
console.log(
  `browser: ${provenance.executablePath} (${provenance.version}; requested: ${provenance.request.source})`,
)
console.log(
  `capture area: ${String(captureArea.width)}x${String(captureArea.height)}, strategy ${device.capture.strategy}, fps ${String(capture.fps)}, jpeg q${String(capture.quality)}`,
)
let recordSeconds = 0
try {
  const context = await browser.newContext(
    contextOptionsFor(device, captureArea),
  )
  const page = await context.newPage()
  const rendererInfo = await detectRenderer(page)
  console.log(`renderer: ${rendererInfo.renderer}`)
  assertHardwareRenderer(rendererInfo)

  const { app, scale } = await openSurface(context, page, device)
  if (script.prepare !== undefined) await script.prepare(app)

  const runInteractions = createRecorder(
    capturedPageRuntime(
      recordPageFor(app, page, {
        cdp: await context.newCDPSession(page),
        hasTouch: device.device.hasTouch,
        scale,
      }),
    ),
  )
  const presentedFrames = await startPresentedFrameTrace(browser, page)
  const recordStart = Date.now()
  const captureResult = await captureScreencast(
    page,
    captureDirectory,
    captureArea,
    async () => {
      await startPaintRateProbe(page)
      // The tour is driven more than once inside one capture when asked.
      // Measured reason: one pass yields ~170 presentation instants over a
      // ~31s session, and `resolveRefreshHz` needs 150 gaps inside the
      // 5-30ms band before it will bound the denominator at all - one pass
      // lands at ~140. The journey is unchanged; it is simply driven again,
      // with the script's own `prepare` in between so the second pass starts
      // from the same state as the first (the dark-mode control is named for
      // the state it would switch to).
      for (let pass = 0; pass < passes; pass += 1) {
        if (pass > 0) {
          // The corpus keeps the chosen theme in localStorage, so a bare
          // reload would leave the dark-mode control named for the other
          // direction and the second pass would miss its first target.
          await app.evaluate(() => {
            localStorage.clear()
          })
          if (script.prepare !== undefined) await script.prepare(app)
        }
        await runInteractions(
          { out: captureDirectory, seed: 1, settleTimeoutMs: 10_000 },
          script.recording,
        )
      }
    },
  )
  recordSeconds = (Date.now() - recordStart) / 1000
  await writeBrowserProvenance(captureDirectory, provenance)
  const paintTimestamps = await readPaintTimestamps(page)
  const presentedTimestamps = await presentedFrames.stop()
  const manifest = JSON.parse(
    await readFile(captureResult.timestampsPath, 'utf8'),
  ) as TimestampManifest

  await writeFile(
    `${captureDirectory}/presented.json`,
    `${JSON.stringify(presentedTimestamps)}\n`,
  )
  console.log(
    `DIAG presentedInstants=${String(presentedTimestamps.length)} capturedFrames=${String(manifest.frames.length)} sessionMs=${String(manifest.session.duration)} paintTicks=${String(paintTimestamps.length)}`,
  )
  const report = computeCaptureEfficiencyReport(
    manifest,
    tiledWindows(manifest),
    presentedTimestamps,
    paintTimestamps,
  )
  await writeCaptureEfficiencyReport(captureDirectory, report)
  console.log(
    `RESULT capture=${String(captureArea.width)}x${String(captureArea.height)} device=${values.device ?? 'desktop'} ` +
      `efficiency=${(report.overallEfficiency * 100).toFixed(1)}% ` +
      `captured=${String(report.overallCapturedFrameCount)} presented=${String(report.overallPresentedFrameCount)} ` +
      `refreshHz=${report.refreshHz.toFixed(2)} ` +
      `sessionSeconds=${(manifest.session.duration / 1000).toFixed(2)} ` +
      `recordSeconds=${recordSeconds.toFixed(1)} ` +
      `framesOnDisk=${String(manifest.frames.length)} ` +
      `droppedDuplicates=${String(captureResult.droppedDuplicateFrameCount)}`,
  )
  try {
    validateCaptureEfficiencyReport(report)
    console.log('GATE pass (>=95%, denominator checks clean)')
  } catch (error) {
    console.log(
      `GATE fail: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  await context.close()
} finally {
  await browser.close()
}

if (values.render !== undefined) {
  const [outWidth, outHeight] = values.render.split('x').map(Number)
  const renderStart = Date.now()
  const result = await renderRecording(captureDirectory, `${outRoot}/video`, {
    formats: formatsFor(
      {
        ...device.output,
        height: outHeight as number,
        width: outWidth as number,
      },
      false,
    ),
    encoder: device.output.quality,
  })
  console.log(`renderSeconds=${((Date.now() - renderStart) / 1000).toFixed(1)}`)
  for (const output of result.outputs) {
    console.log(
      `  ${output.label}  ${String(output.width)}x${String(output.height)}  ${output.outputPath}`,
    )
    for (const clamp of output.clamps) console.log(`  ! ${clamp}`)
  }
}
console.log(`totalSeconds=${((Date.now() - startedAtWall) / 1000).toFixed(1)}`)
process.exit(0)
