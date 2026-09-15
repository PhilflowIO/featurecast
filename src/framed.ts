import type { BrowserContext, Frame, Page } from 'playwright'

import type { CaptureSettings, DeviceDescriptor } from './devices.js'

/**
 * The framed capture strategy: film a mobile layout at video resolution.
 *
 * ## The problem this solves
 *
 * The screencast reads the compositor surface and sizes it in CSS pixels, so
 * a device profile's pixel density never reaches the recording — measured
 * three ways (artifacts/m3-spike/report.json): an iPhone 15 Pro profile at
 * density 3 delivers 393x659 frames; `Emulation.setDeviceMetricsOverride`'s
 * `scale` field, documented as "scale to apply to resulting view image",
 * changes the layout height and nothing else (393x699); and a browser
 * launched with `--force-device-scale-factor` cannot be given a 393px-wide
 * window at all, because Chromium enforces a minimum window width.
 *
 * So the recorded width is the *layout* width, and a mobile layout is 393
 * CSS pixels wide. The two cannot both be true of the same document — which
 * is the whole trick: they are two documents. The page the screencast
 * records is 1080 wide; the app inside it is laid out at 393 and drawn
 * through a CSS transform. A transformed layer re-rasterises at its
 * effective scale, so 16px body text arrives as 44px of sharp glyph rather
 * than a magnified 16px bitmap (artifacts/m3-spike/e-framed-text.jpg).
 *
 * ## Why the shell is served from the app's own origin
 *
 * The obvious spelling — build the wrapper with `page.setContent` and point
 * an iframe at the app — fails, and fails silently: the wrapper document has
 * an opaque origin, which makes the app third-party inside it, and a
 * third-party document has no storage. OnlyDash threw
 * `SecurityError: Failed to read the 'localStorage' property` and rendered
 * an empty page; the recording would have been a blank rectangle at the
 * correct resolution. Disabling web security hides that, at the price of a
 * browser that no longer behaves like the one users have.
 *
 * Serving the shell from the app's own origin removes the cause instead. The
 * shell is a route fulfilled at `<app-origin>/__featurecast_frame__`, so
 * parent and frame are same-origin: the app's storage is first-party again,
 * `X-Frame-Options: SAMEORIGIN` is satisfied (OnlyDash sends exactly that),
 * and `frame-ancestors 'self'` is satisfied too. Nothing has to be stripped
 * and no security flag has to be lowered.
 *
 * ## The one conversion
 *
 * Two coordinate spaces exist: the picture (1080x1920, what the video shows)
 * and the app's own layout (393 wide). Playwright reports element boxes in
 * main-frame coordinates and takes input there, so both are already the
 * picture's — every number `src/record.ts` computes is about the picture,
 * which is what its constants are written about. Wheel deltas are the
 * exception: a wheel event scrolls the app's document in *its* pixels, and
 * the transform then magnifies that travel by the scale factor. They are
 * divided by the scale on the way in; see `framedRecordPage`.
 */

/** Where the shell is served from, on the application's own origin. */
export const FRAMED_SHELL_PATH = '/__featurecast_frame__'

export type FramedGeometry = {
  /** The iframe's CSS size — the app's own viewport. */
  inner: { height: number; width: number }
  /** Picture pixels per app pixel. */
  scale: number
}

/**
 * How large the app's viewport is, given the recorded area and the profile.
 *
 * The width is the device's, unchanged — that is the entire point, and the
 * reason a mobile layout appears at all. The height is whatever fills the
 * recorded area at the resulting scale, which is usually a little taller
 * than the profile's own viewport (699 rather than 659 for an iPhone 15
 * Pro). That is deliberate: the alternative is a letterboxed strip of
 * background above and below a phone-shaped picture, and the output format
 * is the frame, not a phone mock-up inside it.
 */
export function framedGeometry(
  capture: Pick<CaptureSettings, 'height' | 'width'>,
  device: Pick<DeviceDescriptor, 'viewport'>,
): FramedGeometry {
  const scale = capture.width / device.viewport.width
  return {
    // Not rounded. A rounded height multiplied back by the scale misses the
    // recorded height by up to a pixel, which is a row of shell background
    // along the bottom edge of every frame; CSS takes fractions.
    inner: { height: capture.height / scale, width: device.viewport.width },
    scale,
  }
}

/** The shell URL for an application URL: same origin, reserved path. */
export function framedShellUrl(appUrl: string): string {
  return new URL(FRAMED_SHELL_PATH, appUrl).href
}

/**
 * The shell document.
 *
 * `overflow:hidden` on the shell matters: the scaled stage is larger than
 * the shell's own layout box in the flow, and a scrollbar on the *shell*
 * would be recorded as a stripe down the side of the video.
 */
export function framedShellHtml(
  appUrl: string,
  geometry: FramedGeometry,
): string {
  const { inner, scale } = geometry
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>featurecast</title><style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #ffffff; }
  #featurecast-stage {
    position: absolute; left: 0; top: 0;
    width: ${String(inner.width)}px; height: ${String(inner.height)}px;
    transform: scale(${String(scale)}); transform-origin: top left;
  }
  #featurecast-app { display: block; border: 0; width: ${String(inner.width)}px; height: ${String(inner.height)}px; }
</style></head>
<body><div id="featurecast-stage"><iframe id="featurecast-app" src="${appUrl}"></iframe></div></body></html>`
}

/**
 * Opens the shell and hands back the frame the application lives in.
 *
 * The route is registered on the context rather than the page so it survives
 * a navigation the app performs itself, and it is matched on the exact shell
 * URL so nothing else the app loads is intercepted — this is not a proxy.
 */
export async function openFramedSurface(
  context: BrowserContext,
  page: Page,
  appUrl: string,
  geometry: FramedGeometry,
): Promise<Frame> {
  const shellUrl = framedShellUrl(appUrl)
  const html = framedShellHtml(appUrl, geometry)
  await context.route(shellUrl, async (route) => {
    await route.fulfill({
      body: html,
      contentType: 'text/html; charset=utf-8',
      status: 200,
    })
  })
  await page.goto(shellUrl, { waitUntil: 'domcontentloaded' })
  const element = await page.waitForSelector('#featurecast-app')
  const frame = await element.contentFrame()
  if (frame === null) {
    throw new Error(
      `The shell at ${shellUrl} loaded but its frame never attached. ` +
        `Check that ${appUrl} is reachable from the recording browser.`,
    )
  }
  await frame.waitForLoadState('domcontentloaded')
  return frame
}
