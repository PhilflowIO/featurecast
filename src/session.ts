import type { Page } from 'playwright'

import { FRAME_RATE } from './assemble.js'
import {
  launchChromium,
  resolveBrowserRequest,
  writeBrowserProvenance,
} from './browser.js'
import { CAPTURE_QUALITY, CAPTURE_SIZE, captureScreencast } from './capture.js'
import type { CaptureSettings, ResolvedDevice } from './devices.js'
import {
  createRecorder,
  type Demo,
  type RecordPage,
  type RecordRuntime,
} from './record.js'

/**
 * One device's browser leg: open a context for the resolved device, run the
 * recording script through the `demo` wrapper, and capture the screencast
 * around it.
 *
 * This is the composition `docs/RECORDING-SCRIPTS.md` said did not exist yet
 * — "Die Aufnahme der Einzelbilder (src/capture.ts) und der Zusammenbau
 * (src/assemble.ts) existieren, sind aber bisher nur in demo/m1-capture.ts
 * von Hand mit dem Wrapper verdrahtet." The wiring is the same one that
 * benchmark uses and for the same reason: `record()`'s own default runtime
 * launches a *second*, uncaptured browser, so the script has to be driven
 * against the exact page the screencast is attached to.
 *
 * What is deliberately not here: the M1 benchmark's instrumentation (paint
 * probe, presented-frame trace, efficiency gate, repeat report). Those
 * measure the pipeline; this one runs it.
 */
export type RecordingScript = (page: RecordPage, demo: Demo) => Promise<void>

export type SessionRequest = {
  /** The capture settings `requireCaptureSettings` already approved. */
  capture: CaptureSettings
  device: ResolvedDevice
  /** Directory that receives `frames/`, `timestamps.json`, `browser.json`. */
  outputDirectory: string
  recording: RecordingScript
  seed: number
  settleTimeoutMs?: number
}

export type SessionResult = {
  captureDirectory: string
  timestampsPath: string
}

/**
 * The capture geometry `src/capture.ts` is able to record, as opposed to the
 * geometry a device may ask for.
 *
 * `captureScreencast` starts the screencast at `CAPTURE_SIZE` and
 * `CAPTURE_QUALITY`, and `validateCaptureManifest` rejects any manifest whose
 * frames are a different size — M1's acceptance evidence is tied to that one
 * geometry. So a preset whose capture area differs cannot be recorded today,
 * and this says so by name rather than recording 2560x1600 under a preset
 * that asked for something else.
 *
 * The disagreement is real and documented: PLAN.md wants to over-capture at
 * 2560x1600 and keep 1.33x zoom reserve, while `docs/DEVICES.md`'s `desktop`
 * preset asks for an already-16:9 2560x1440 with no reserve. Making the
 * capture area a parameter means settling that first (docs/CAPTURE-CADENCE.md)
 * and re-earning M1's numbers at the new size; it is not a line of plumbing.
 */
export function assertCaptureSupported(
  capture: CaptureSettings,
  label: string,
): void {
  const mismatches: string[] = []
  if (
    capture.width !== CAPTURE_SIZE.width ||
    capture.height !== CAPTURE_SIZE.height
  ) {
    mismatches.push(
      `it asks to record ${String(capture.width)}x${String(capture.height)}, and src/capture.ts records a fixed ${String(CAPTURE_SIZE.width)}x${String(CAPTURE_SIZE.height)}`,
    )
  }
  if (capture.quality !== CAPTURE_QUALITY) {
    mismatches.push(
      `it asks for JPEG quality ${String(capture.quality)}, and src/capture.ts encodes every frame at ${String(CAPTURE_QUALITY)}`,
    )
  }
  if (capture.fps !== FRAME_RATE) {
    mismatches.push(
      `it asks for ${String(capture.fps)} fps, and the capture and render stages are both fixed at ${String(FRAME_RATE)}`,
    )
  }
  if (capture.strategy !== 'screencast') {
    mismatches.push(
      `it asks for the "${capture.strategy}" capture strategy, and only "screencast" is implemented (the other three are M3's candidates)`,
    )
  }
  if (mismatches.length === 0) return
  throw new Error(
    `${label} cannot be recorded yet: ${mismatches.join('; ')}. ` +
      'Whether to over-capture and crop at all is still open between PLAN.md and docs/DEVICES.md — see docs/CAPTURE-CADENCE.md. ' +
      'Until that is settled, use a device whose capture area is the recorded one, e.g. "desktop-wide".',
  )
}

/**
 * Drives the script against the page the screencast is attached to.
 *
 * `record()`'s public entry point cannot be used here: its default runtime
 * opens its own browser, which would leave the capture pointed at a page
 * nothing happens on.
 */
function capturedPageRuntime(page: Page, hasTouch: boolean): RecordRuntime {
  return {
    async run(_options, script) {
      const recordPage = page as unknown as RecordPage
      recordPage.hasTouch = hasTouch
      await script(recordPage)
    },
  }
}

export async function recordSession(
  request: SessionRequest,
): Promise<SessionResult> {
  const { browser, provenance } = await launchChromium(
    { headless: true },
    resolveBrowserRequest(process.env),
  )
  try {
    // The screencast delivers CSS pixels and ignores `deviceScaleFactor`
    // (PLAN.md, "Der ungelöste Teil"), so the viewport — not the device
    // profile's own — is what decides the recorded resolution. Everything
    // else about the device (touch, user agent, engine hint) comes from the
    // resolved descriptor unchanged.
    const context = await browser.newContext({
      ...request.device.device,
      viewport: {
        height: request.capture.height,
        width: request.capture.width,
      },
    })
    try {
      const page = await context.newPage()
      const runInteractions = createRecorder(
        capturedPageRuntime(page, request.device.device.hasTouch),
      )
      const capture = await captureScreencast(
        page,
        request.outputDirectory,
        async () => {
          await runInteractions(
            {
              out: request.outputDirectory,
              seed: request.seed,
              ...(request.settleTimeoutMs === undefined
                ? {}
                : { settleTimeoutMs: request.settleTimeoutMs }),
            },
            request.recording,
          )
        },
      )
      // The capture creates the output directory, so this is the first
      // moment the provenance can be written next to the frames it
      // describes.
      await writeBrowserProvenance(request.outputDirectory, provenance)
      return {
        captureDirectory: request.outputDirectory,
        timestampsPath: capture.timestampsPath,
      }
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
  }
}
