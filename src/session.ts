import type {
  BrowserContext,
  BrowserContextOptions,
  Frame,
  Page,
} from 'playwright'

import { FRAME_RATE } from './assemble.js'
import {
  launchChromium,
  resolveBrowserRequest,
  writeBrowserProvenance,
} from './browser.js'
import { CAPTURE_QUALITY, captureScreencast } from './capture.js'
import type { CaptureSettings, ResolvedDevice } from './devices.js'
import { framedGeometry, openFramedSurface } from './framed.js'
import {
  createRecorder,
  type Demo,
  type RecordPage,
  type RecordRuntime,
} from './record.js'
import { pinClockAndRandomness, hideOverlay } from './recipes.js'
import {
  assertHardwareRenderer,
  detectRenderer,
  HARDWARE_GL_LAUNCH_ARGS,
} from './renderer.js'
import { recordPageFor } from './surface.js'

/**
 * One device's browser leg: open a context for the resolved device, run the
 * recording script through the `demo` wrapper, and capture the screencast
 * around it.
 *
 * This is the composition `docs/RECORDING-SCRIPTS.md` said did not exist yet
 * — "frame capture (src/capture.ts) and assembly (src/assemble.ts) exist, but
 * so far are only wired to the wrapper by hand in demo/m1-capture.ts." The
 * wiring is the same one that
 * benchmark uses and for the same reason: `record()`'s own default runtime
 * launches a *second*, uncaptured browser, so the script has to be driven
 * against the exact page the screencast is attached to.
 *
 * What is deliberately not here: the M1 benchmark's instrumentation (paint
 * probe, presented-frame trace, efficiency gate, repeat report). Those
 * measure the pipeline; this one runs it.
 */
export type RecordingScript = (page: RecordPage, demo: Demo) => Promise<void>

/**
 * Setup that runs before the capture starts, against the document the video
 * is about. See `SessionRequest.prepare`.
 *
 * A `Frame` rather than a `Page` because under the framed strategy the
 * application is not the page — it is one document inside it, and a
 * `page.goto` in a prepare step would navigate the shell away and take the
 * recording with it. For a direct capture this is the page's main frame, so
 * nothing about a desktop prepare step changes except the name of its type.
 */
export type PrepareStep = (app: Frame) => Promise<void>

/**
 * The two Chromium switches that give a page a camera and a microphone
 * without a person or a device: one answers every permission prompt with
 * "allow", the other supplies a synthetic camera picture and a tone.
 *
 * A headless browser has neither by default, and `getUserMedia` fails with
 * `NotAllowedError`. For most pages that is invisible. For a video-call page
 * it is not: Raven's pre-join card answers it with a red "you are joining
 * without camera and microphone" banner at the top of the screen, which is a
 * screen no guest with a working browser ever sees.
 */
export const FAKE_MEDIA_LAUNCH_ARGS: readonly string[] = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
]

/**
 * The permissions granted alongside the switches. The switches make the
 * prompt say yes; the grant makes `navigator.permissions.query` say
 * `granted` before anything has been asked, which is what a page that checks
 * first (instead of simply calling `getUserMedia`) reads.
 */
export const FAKE_MEDIA_PERMISSIONS: readonly string[] = [
  'camera',
  'microphone',
]

export type SessionRequest = {
  /**
   * Let the framed shell hold an application that forbids framing
   * (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), by relaxing exactly
   * those headers on the framed application document inside this recording
   * browser. What is relaxed and why that is safe: src/framed.ts, "An
   * application that forbids framing altogether".
   *
   * Meaningless under the direct strategy, which has no frame, and ignored
   * there rather than refused: a script meant for a phone and a desktop
   * carries it for the phone.
   */
  allowFramingOfApp?: boolean
  /**
   * The application being filmed.
   *
   * Required by the framed strategy and unused by the direct one: the shell
   * a framed capture puts the application inside has to be served from the
   * application's own origin (src/framed.ts), which cannot be known from a
   * navigation the recording script has not performed yet.
   */
  appUrl?: string
  /** The capture settings `assertCaptureSupported` already approved. */
  capture: CaptureSettings
  device: ResolvedDevice
  /**
   * Give the page a synthetic camera and microphone, already permitted
   * (`FAKE_MEDIA_LAUNCH_ARGS`, `FAKE_MEDIA_PERMISSIONS`).
   *
   * Browser-level rather than something a script could do: the switches are
   * launch arguments, and a script is handed a page of a browser that is
   * already running.
   */
  fakeMedia?: boolean
  /**
   * The wall clock every document of this recording claims, e.g.
   * `2026-01-15T09:00:00Z`; it also seeds the page's own `Math.random`.
   *
   * Context-level, like `hideSelectors` and `storageStatePath`, and for the
   * same reason: by the time a recording script is handed a page, the first
   * render has happened and the relative timestamps on it are already
   * whatever today happened to be.
   */
  fixedTime?: string
  /**
   * CSS selectors of surfaces that are gone before the page's own scripts
   * run — a consent banner, a card that shows an internal address.
   */
  hideSelectors?: readonly string[]
  /** Directory that receives `frames/`, `timestamps.json`, `browser.json`. */
  outputDirectory: string
  /**
   * Everything that has to happen before the camera rolls: signing in,
   * navigating to the screen the demo is about, dismissing a cookie banner.
   *
   * It runs against the same document the recording will be driven against,
   * but *outside* the capture window, so none of it reaches the video. Without it a
   * recording of any real application opens on its login screen — and the
   * pointer travel of the sign-in clicks is recorded too, which is worse,
   * because those are seconds of a cursor moving through a screen the video
   * is not about.
   *
   * It is deliberately a bare Playwright `Frame` and not the `demo` wrapper:
   * nothing here is being demonstrated, so nothing here should be smoothed,
   * paced or written to the event log. `demo`'s pointer travel is a feature
   * of the recording, and setup is not part of the recording.
   */
  prepare?: PrepareStep
  recording: RecordingScript
  seed: number
  settleTimeoutMs?: number
  /**
   * The signed-in session to record under — **a path, never the contents.**
   *
   * A Playwright `storageState` file *is* the access: it holds the cookies
   * and the local storage of a signed-in account. It therefore enters as a
   * file name and is opened by the browser itself at the last possible
   * moment; nothing in this process ever reads it, so no log line, no error
   * message and no artifact can carry it out. `auth/` is git-ignored for
   * the same reason (`CONTRIBUTING.md`), and the credentials that produce
   * the file belong in a secret store, not in any file of this repository.
   */
  storageStatePath?: string
}

export type SessionResult = {
  captureDirectory: string
  timestampsPath: string
}

/**
 * The capture settings `src/capture.ts` is able to honour, as opposed to the
 * settings a device may ask for.
 *
 * The capture *area* is no longer on this list: `captureScreencast` records
 * whatever rectangle it is handed, and `validateCaptureManifest` checks the
 * delivered frames against that same rectangle. Nor is the strategy, since
 * M3: both of them produce their frames through the same screencast, and
 * they differ in what the page under it contains, not in how it is filmed.
 * What remains fixed is the JPEG quality and the frame rate the capture and
 * render stages share.
 */
export function assertCaptureSupported(
  capture: CaptureSettings,
  label: string,
): void {
  const mismatches: string[] = []
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
  if (mismatches.length === 0) return
  throw new Error(`${label} cannot be recorded yet: ${mismatches.join('; ')}.`)
}

/**
 * The second gate, next to `assertCaptureSupported`: a framed recording has
 * to know the application before the browser starts.
 *
 * Here rather than inside the browser leg for the reason the whole pipeline
 * checks what it can up front — this is knowable at second zero, and finding
 * it out after a browser launch costs the launch for nothing.
 */
export function requireAppUrl(
  device: ResolvedDevice,
  appUrl: string | undefined,
): void {
  if (device.capture.strategy === 'framed-scale') framedAppUrl(device, appUrl)
}

/** The same demand, phrased as the value the framed leg needs. */
function framedAppUrl(
  device: ResolvedDevice,
  appUrl: string | undefined,
): string {
  if (appUrl !== undefined) return appUrl
  throw new Error(
    `"${device.preset ?? device.playwrightName}" is recorded through the framed strategy, ` +
      'which needs to know the application up front — its shell is served from the ' +
      "application's own origin. Export the address from the recording script: " +
      "`export const url = 'https://app.example.com/'`.",
  )
}

/**
 * Drives the script against the page the screencast is attached to.
 *
 * `record()`'s public entry point cannot be used here: its default runtime
 * opens its own browser, which would leave the capture pointed at a page
 * nothing happens on.
 */
function capturedPageRuntime(recordPage: RecordPage): RecordRuntime {
  return {
    async run(_options, script) {
      await script(recordPage)
    },
  }
}

/**
 * The browser context a device is recorded in.
 *
 * Under the direct strategy the context *is* the device, with one field
 * replaced: the viewport becomes the recorded area, because the screencast
 * records the page's layout size and the device profile's own would decide
 * the video's resolution.
 *
 * Under the framed strategy three more fields have to go, and each for its
 * own reason. `deviceScaleFactor` is dropped to 1 because the shell is
 * already at video resolution and a density on top of it would raster pixels
 * nothing reads. `isMobile` is dropped because it makes the *shell* honour a
 * viewport meta tag it does not carry, which lays the shell out at 980 CSS
 * pixels instead of the recorded width — the application inside the frame
 * still gets a mobile layout, because the frame is the device's own width and
 * that is what a layout responds to. What stays is the part that makes the
 * application behave like a phone: the user agent and `hasTouch`.
 */
export function contextOptionsFor(
  device: ResolvedDevice,
  captureArea: { height: number; width: number },
  storageStatePath?: string,
  fakeMedia = false,
): BrowserContextOptions {
  // The saved session is the one option here that does not come from the
  // device: it says *who* is being filmed, not *on what*. It is passed
  // through as a file name — Playwright opens it — so this process never
  // holds a cookie of it.
  const session = {
    ...(storageStatePath === undefined
      ? {}
      : { storageState: storageStatePath }),
    ...(fakeMedia ? { permissions: [...FAKE_MEDIA_PERMISSIONS] } : {}),
  }
  if (device.capture.strategy === 'screencast') {
    return { ...device.device, ...session, viewport: captureArea }
  }
  return {
    ...device.device,
    ...session,
    deviceScaleFactor: 1,
    isMobile: false,
    viewport: captureArea,
  }
}

/**
 * Opens the document the recording is driven against, and says how many
 * picture pixels one of its own pixels is worth.
 */
async function openSurface(
  context: BrowserContext,
  page: Page,
  device: ResolvedDevice,
  appUrl: string | undefined,
  allowFramingOfApp: boolean,
): Promise<{ app: Frame; scale: number }> {
  if (device.capture.strategy === 'screencast') {
    return { app: page.mainFrame(), scale: 1 }
  }
  const geometry = framedGeometry(device.capture, device.device)
  return {
    app: await openFramedSurface(
      context,
      page,
      framedAppUrl(device, appUrl),
      geometry,
      { allowFramingOfApp },
    ),
    scale: geometry.scale,
  }
}

export async function recordSession(
  request: SessionRequest,
): Promise<SessionResult> {
  // Hardware GL, always. Without these flags headless Chromium rasterizes in
  // SwiftShader even on a machine with a working GPU, and a page with photos
  // and gradients then paints a scroll at ~20 fps and at under half its
  // scripted pace. Every duration and frame-count check still passes; the
  // clip just judders (featurecast#150). `assertHardwareRenderer` below turns
  // that silent fallback into a failure.
  const launchArgs = [
    ...HARDWARE_GL_LAUNCH_ARGS,
    ...(request.fakeMedia === true ? FAKE_MEDIA_LAUNCH_ARGS : []),
  ]
  const { browser, provenance } = await launchChromium(
    { args: launchArgs, headless: true },
    resolveBrowserRequest(process.env),
  )
  // The screencast delivers CSS pixels and ignores `deviceScaleFactor`
  // (measured, M3), so the viewport — not the device profile's own — is what
  // decides the recorded resolution. One rectangle, read once: the context
  // lays the page out at it and the screencast records at it, so the two
  // cannot drift.
  const captureArea = {
    height: request.capture.height,
    width: request.capture.width,
  }
  try {
    const context = await browser.newContext(
      contextOptionsFor(
        request.device,
        captureArea,
        request.storageStatePath,
        request.fakeMedia === true,
      ),
    )
    try {
      // Before the first page, not after it. An init script only reaches
      // documents that are opened afterwards, and the whole point of hiding
      // a surface this way is that it is gone *before* the page's own
      // scripts run — a node removed after the first paint has already been
      // on screen, and the screencast would have it.
      if (request.hideSelectors !== undefined) {
        await hideOverlay(context, request.hideSelectors)
      }
      if (request.fixedTime !== undefined) {
        await pinClockAndRandomness(context, request.fixedTime)
      }
      const page = await context.newPage()
      // On the blank page, before anything is filmed: a software renderer is
      // a reason not to record at all, so the check costs no capture time.
      const renderer = await detectRenderer(page, launchArgs)
      assertHardwareRenderer(renderer)
      const { app, scale } = await openSurface(
        context,
        page,
        request.device,
        request.appUrl,
        request.allowFramingOfApp === true,
      )
      // Before the capture, not inside it. `captureScreencast` starts
      // recording the moment it is called, so anything that must not appear
      // in the video has to be finished by now.
      if (request.prepare !== undefined) await request.prepare(app)
      const runInteractions = createRecorder(
        capturedPageRuntime(
          recordPageFor(app, page, {
            cdp: await context.newCDPSession(page),
            hasTouch: request.device.device.hasTouch,
            scale,
          }),
        ),
      )
      const capture = await captureScreencast(
        page,
        request.outputDirectory,
        captureArea,
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
      await writeBrowserProvenance(request.outputDirectory, {
        ...provenance,
        renderer,
      })
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
