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
 * third-party document has no storage. The recorded application threw
 * `SecurityError: Failed to read the 'localStorage' property` and rendered
 * an empty page; the recording would have been a blank rectangle at the
 * correct resolution. Disabling web security hides that, at the price of a
 * browser that no longer behaves like the one users have.
 *
 * Serving the shell from the app's own origin removes the cause instead. The
 * shell is a route fulfilled at `<app-origin>/__featurecast_frame__`, so
 * parent and frame are same-origin: the app's storage is first-party again,
 * and an application that allows same-origin framing — `X-Frame-Options:
 * SAMEORIGIN`, `frame-ancestors 'self'` — is satisfied as it is. For such an
 * application nothing is stripped and nothing is lowered.
 *
 * ## An application that forbids framing altogether
 *
 * Some applications send `X-Frame-Options: DENY` or `frame-ancestors 'none'`
 * (Raven does both, the CSP as report-only). Those refuse every frame, the
 * same-origin shell included: the frame commits Chromium's error page
 * (`net::ERR_BLOCKED_BY_RESPONSE`) and there is no application to film. The
 * header is right for the product and is not changed there; a recording
 * script that films such an application says so with
 * `export const allowFramingOfApp = true`, and then — and only then — this
 * module relaxes it inside the recording browser.
 *
 * That *is* a lowered security header, so exactly what is relaxed:
 *
 * - only the response to a document navigation of the one frame the shell
 *   holds (`#featurecast-app`), on the application's own origin — not a
 *   subresource, not a frame the application opens itself, not another
 *   origin, not the shell;
 * - in that response only the framing headers: `X-Frame-Options` becomes
 *   `SAMEORIGIN`, and a `frame-ancestors` directive in either CSP header
 *   becomes `frame-ancestors 'self'`. Every other CSP directive, every other
 *   header, the status and the content stay what the server sent
 *   (`relaxFramingHeaders`). The one mechanical exception: the document is
 *   handed back decoded, so the headers describing its compression go
 *   (`framedDocumentHeaders`). Cookies are set by the browser's own network
 *   stack from the original response, exactly as without this.
 *
 * Why that is safe: the framing headers protect a *person* from clickjacking
 * — a foreign page overlaying the application and steering their clicks. The
 * recording browser has no person in it; it is a headless Chromium started
 * for one recording, whose only other page is the shell featurecast itself
 * wrote, on the application's own origin. The relaxation is an interception
 * on that page and ends with it: nothing reaches the application, its server, or any
 * browser a user has. `'self'` rather than dropping the directive, so even
 * inside the recording the application may be framed by its own origin and
 * by nothing else.
 *
 * What is still not done, deliberately: no `--disable-web-security`, no
 * change to cookies or CORS. The application keeps behaving like the one
 * users have, which is the reason this module exists.
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

/** The headers that decide whether a document may be framed at all. */
const FRAMING_CSP_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
] as const

/**
 * A CSP header value with every `frame-ancestors` directive replaced by
 * `frame-ancestors 'self'`, and every other byte left as the server wrote it.
 *
 * A header value may carry several policies, separated by commas (that is
 * also how two CSP headers of one response arrive once they are folded into
 * one), and each policy is a list of directives separated by semicolons.
 * Neither separator can occur inside a source expression, so splitting on
 * them is the grammar, not a guess. The directive is matched by name, case
 * insensitively, because the name is; its leading whitespace is kept so a
 * value without the directive comes back identical, not merely equivalent.
 */
export function relaxFrameAncestors(policy: string): string {
  return policy
    .split(',')
    .map((single) =>
      single
        .split(';')
        .map((directive) => {
          const match = /^(\s*)frame-ancestors(?:\s|$)/i.exec(directive)
          if (match === null) return directive
          return `${match[1] ?? ''}frame-ancestors 'self'`
        })
        .join(';'),
    )
    .join(',')
}

/** One response header, the shape the debugging protocol uses. */
export type HeaderEntry = { name: string; value: string }

/**
 * The response headers of the framed application document, with framing
 * allowed for its own origin and nothing else changed.
 *
 * `X-Frame-Options` becomes `SAMEORIGIN` rather than disappearing: the shell
 * is same-origin, so that is all the frame needs, and it keeps the recording
 * browser refusing any other framer. Both CSP headers are rewritten, the
 * report-only one included — it blocks nothing, but left alone it would file
 * a violation report with the application's own endpoint for every
 * recording, which is noise in someone else's monitoring.
 *
 * A list rather than a map, because a response may repeat a header (two CSP
 * headers are legal and both are enforced), and each is rewritten where it
 * stands. Names are matched case-insensitively and written back as they came.
 */
export function relaxFramingHeaders(
  headers: readonly HeaderEntry[],
): HeaderEntry[] {
  return headers.map(({ name, value }) => {
    const lower = name.toLowerCase()
    if (lower === 'x-frame-options') return { name, value: 'SAMEORIGIN' }
    if ((FRAMING_CSP_HEADERS as readonly string[]).includes(lower)) {
      return { name, value: relaxFrameAncestors(value) }
    }
    return { name, value }
  })
}

/**
 * The headers that describe the body *as it travelled*, which stop being true
 * once the body is handed back decoded.
 *
 * `Fetch.getResponseBody` returns the content, not the bytes on the wire: a
 * gzip or brotli document comes back already unpacked. Delivered with its
 * original `Content-Encoding` it would claim to be compressed when it is not;
 * with its original `Content-Length` it would claim the compressed size.
 * Chromium works out the length of a fulfilled body itself.
 */
const TRANSFER_HEADERS: readonly string[] = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
]

/**
 * The headers a relaxed document is delivered with: the framing headers
 * relaxed, the transfer headers dropped (see `TRANSFER_HEADERS`), and
 * everything else exactly as the server sent it.
 */
export function framedDocumentHeaders(
  headers: readonly HeaderEntry[],
): HeaderEntry[] {
  return relaxFramingHeaders(headers).filter(
    ({ name }) => !TRANSFER_HEADERS.includes(name.toLowerCase()),
  )
}

/** The part of `Fetch.requestPaused` this module reads. */
type PausedResponse = {
  frameId: string
  requestId: string
  responseHeaders?: HeaderEntry[]
  responseStatusCode?: number
  responseStatusText?: string
}

export type FramedSurfaceOptions = {
  /**
   * Relax the framing headers of the application document inside the
   * recording browser; see "An application that forbids framing altogether"
   * in this module's header. Off unless a recording script asks for it.
   */
  allowFramingOfApp?: boolean
}

/**
 * Lets the shell's frame hold an application that forbids framing, for this
 * page only.
 *
 * ## Why the debugging protocol and not `page.route`
 *
 * Two measured reasons (2026-09-18, Chromium 154 / Playwright 1.63):
 *
 * - Playwright does not route the hops of a redirect — it continues them
 *   itself. An application whose front door redirects (Raven's `/meetings`
 *   answers 307 to `/login`) would get its first response relaxed and the
 *   document it actually lands on refused. `route.fetch` following the
 *   redirect instead would put the landing page's content under the first
 *   address, which the application's own router then reads.
 * - `Fetch.continueResponse` with rewritten headers is not enough either: the
 *   frame still reported "violates … frame-ancestors 'none'". Chromium
 *   parses the CSP before that override, so only a *fulfilled* response is
 *   judged by the headers it is handed.
 *
 * So the interception sits at the response stage, where every hop of a
 * redirect is paused on its own, and it is narrowed by the protocol itself to
 * documents on the application's origin — a subresource is never paused.
 * Among those it touches only the shell's own frame, identified by its place
 * (a direct child of the shell's main frame), not its name, which the
 * application could change. A frame the application opens itself is a
 * grandchild and stays refused if the application forbids it. A redirect is
 * passed on unchanged: framing is judged on the document that commits, not
 * on the hops to it. Everything else is continued untouched.
 *
 * The session is its own, next to Playwright's: Playwright intercepts at the
 * request stage (the shell route), this one at the response stage, and each
 * continues what it paused.
 */
async function allowFramingOfAppDocument(
  context: BrowserContext,
  page: Page,
  appOrigin: string,
): Promise<void> {
  const cdp = await context.newCDPSession(page)
  const parents = new Map<string, string>()
  cdp.on('Page.frameAttached', (event) => {
    parents.set(event.frameId, event.parentFrameId)
  })
  await cdp.send('Page.enable')
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const shellFrameId = frameTree.frame.id

  const handle = async (event: PausedResponse): Promise<void> => {
    const status = event.responseStatusCode ?? 0
    const isAppFrame = parents.get(event.frameId) === shellFrameId
    const isRedirect = status >= 300 && status < 400
    if (!isAppFrame || isRedirect || event.responseHeaders === undefined) {
      await cdp.send('Fetch.continueResponse', { requestId: event.requestId })
      return
    }
    const { base64Encoded, body } = await cdp.send('Fetch.getResponseBody', {
      requestId: event.requestId,
    })
    await cdp.send('Fetch.fulfillRequest', {
      body: base64Encoded ? body : Buffer.from(body).toString('base64'),
      requestId: event.requestId,
      responseCode: status,
      responseHeaders: framedDocumentHeaders(event.responseHeaders),
      ...(event.responseStatusText === undefined ||
      event.responseStatusText === ''
        ? {}
        : { responsePhrase: event.responseStatusText }),
    })
  }

  cdp.on('Fetch.requestPaused', (event) => {
    handle(event).catch(async () => {
      // Never leave a document paused: a request nobody continues is a
      // frame that never loads and a recording that times out with no
      // mention of why. Continued unchanged, the frame fails the way it
      // would have without this route, which the check after loading names.
      await cdp
        .send('Fetch.continueRequest', { requestId: event.requestId })
        .catch(() => undefined)
    })
  })
  await cdp.send('Fetch.enable', {
    patterns: [
      {
        requestStage: 'Response',
        resourceType: 'Document',
        urlPattern: `${appOrigin}/*`,
      },
    ],
  })
}

/**
 * Opens the shell and hands back the frame the application lives in.
 *
 * The route is registered on the context rather than the page so it survives
 * a navigation the app performs itself, and it is matched on the exact shell
 * URL so nothing else the app loads is intercepted — this is not a proxy.
 * `allowFramingOfApp` adds a second interception, scoped as
 * `allowFramingOfAppDocument` says.
 */
export async function openFramedSurface(
  context: BrowserContext,
  page: Page,
  appUrl: string,
  geometry: FramedGeometry,
  options: FramedSurfaceOptions = {},
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
  if (options.allowFramingOfApp === true) {
    await allowFramingOfAppDocument(context, page, new URL(appUrl).origin)
  }
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
  if (frame.url().startsWith('chrome-error:')) {
    // The frame committed Chromium's error page instead of the application.
    // Filmed, that is a grey rectangle with a sad face at the correct
    // resolution; the likeliest cause is named rather than left to be found.
    throw new Error(
      `${appUrl} did not load inside the framed shell. If the application ` +
        "forbids framing (X-Frame-Options: DENY or frame-ancestors 'none'), " +
        'the recording script can allow it inside the recording browser: ' +
        '`export const allowFramingOfApp = true` (see src/framed.ts).',
    )
  }
  return frame
}
