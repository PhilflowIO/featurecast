# M3 — portrait: what was measured and what won

Date: 2026-09-15. All runs on the AI box (RTX 3090, GPU1, container
`featurecast-box:1`, patched Chromium 153.0.8010.12), against the real, dense
interface of the recorded application.

The question from ticket 4: a 1080×1920 video of a real mobile interface, body
text legible at normal size, no mouse pointer in the picture.

## The cause, in one sentence

The capture reads the browser's drawing surface and measures it in **CSS
pixels**. A mobile layout is 393 CSS pixels wide. So an untreated mobile
capture is 393 pixels wide — not because the device pixel ratio was missing,
but because layout width and capture width are the same number.

**That names the solution too:** the two numbers must not belong to the same
document. There are two. The document that is captured is 1080 wide; the
application inside it is 393 wide and is drawn scaled up by a CSS transform. A
transformed layer is re-rasterised at its effective scale — 16-pixel text
arrives as a sharp 44-pixel letter, not as an enlarged 16-pixel image.

## Five routes, four measurements, one winner

| Route                                                                                       | Measured                                                                                                                                                     | Verdict                                |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| **Frame trick** (route 1 in the ticket) — application in a 393 px wide frame, scaled by CSS | 1080×1920, razor sharp, 30.6 frames/s against the real application, 59 against a light page                                                                  | **won**                                |
| **Screenshot capture** (route 2) — `Page.captureScreenshot` with `clip.scale`               | 1080×1811, equally sharp — but **8.8 frames/s** as soon as anything on the page moves (116 ms per frame, p95 122 ms)                                         | rejected: not video                    |
| **Upscaling in the render** (route 3)                                                       | not measured                                                                                                                                                 | rejected: soft, and moot after route 1 |
| **`Emulation.setDeviceMetricsOverride` with `scale`** — not named in the ticket             | delivers 393×699 instead of 1080×1920: the field changes the layout height and nothing else                                                                  | rejected: no effect                    |
| **`--force-device-scale-factor`** — not named in the ticket                                 | the pixel ratio becomes real (DPR 2.75), but the CSS window cannot be shrunk to 393: Chromium enforces a minimum window width (393 requested → 502 received) | rejected: unreachable                  |

The number that disposes of route 2 deserves a sentence of its own: the first
measurement gave 30 frames/s and looked usable — but it ran against a
**static** page on which `scrollBy` went nowhere. As soon as something really
changes per frame, it is 8.8. A screenshot forces a full pass with read-back
every time; the capture, by contrast, has its frames delivered to it by the
drawing machinery.

## The pitfall on the frame route, and why it is no longer one

The obvious way of writing it — build the shell with `setContent`, point the
frame at the application — **fails silently**. The shell then has no real
origin, the application is third-party content inside it, and third-party
content has no storage. The filmed application threw
`SecurityError: Failed to read the 'localStorage' property` and drew an empty
area: a video at the correct resolution that shows nothing. With web security
switched off, the message disappears and the problem stays.

The shell is therefore **served from the application's own origin** — an
intercepted address under `<origin>/__featurecast_frame__`. Shell and frame are
then same-origin: the application's storage is first-party content again,
`X-Frame-Options: SAMEORIGIN` (which is exactly what the filmed application
sends) is satisfied, and so is `frame-ancestors 'self'`. Nothing has to be
removed and no security level lowered.

## The capture area is the output area — unlike on desktop

Desktop captures with a 1.33× reserve, so that M4 can cut several formats out
of the same material and the zoom spring can travel around. For portrait the
same reserve was measured and **rejected**: the same capture of the same
application delivered 30.6 frames/s at 1080×1920 and **14.8 at 1440×2560**.
Halving the frame rate of a social video in order to buy zoom headroom is the
wrong trade — and a phone-shaped frame has no margin to travel into anyway.

What that costs, said openly: a zoom into a mobile capture cuts into a 1:1
sampled image and goes soft, where the desktop presets have reserve.

> **Superseded 2026-09-18 (#149).** The halving was not the capture area. The
> phone path presented at 30 Hz at every size because the swipe awaited each
> touch acknowledgement (#116, fixed in #142). With that fixed, 1620×2880
> presents at 16.70 ms median and 97.0 % yield, the same as 1080×1920, and the
> touch presets now record 1.5× their output. The measurement above stands as
> what was seen; its explanation does not. See [DEVICES.md](DEVICES.md).

## To watch

**The two stills from this section have been removed from version control**,
because they showed the interface of the filmed third-party application. The
first was a crop at original size out of the finished video: 16-pixel body
text of the application, drawn at 1080 pixels of width — the visual evidence
for the sharpness claim above. The second showed the finished portrait video
in dark mode after three taps. The measured statements stand unchanged; their
visual evidence will be supplied from our own measuring corpus.

The finished video and the direct comparison with the rejected attempt (on the
left the 9:16 crop out of the desktop capture, on the right the real portrait)
are at `artifacts/m3-acceptance/iphone/output.mp4` and
`artifacts/m3-vergleich/vorher-nachher.mp4`.

## What that means in the code

- `src/framed.ts` — the shell, its geometry and the argument behind it.
- `src/surface.ts` — the seam between "the filmed document" and "the captured
  page". Element boxes and input coordinates are already supplied by Playwright
  in frame space; **wheel deltas are the only conversion**, because a wheel
  event scrolls the document in the document's own pixels and the transform
  then magnifies that distance.
- `src/devices.ts` — the eight touch presets no longer carry an undecided
  capture. The state "open (M3)" and the `screenshot` and `render-upscale`
  strategies are gone; what was measured and rejected is recorded here and not
  as a dead branch in the code.
- `demo/m3-acceptance.ts` — the same application and almost the same journey as
  the M4 acceptance, on a phone.

Two bugs in the wrapper came to light along the way, both visible only on a
real phone and both fixed at the root:

- **`demo.click` clicked with the mouse on touch devices.** The drawer behind
  the menu button never opened, because it listens for a tap. Now the wrapper
  decides from the device — and writes `tap` instead of `click` into the event
  log, which is what the render stage already keys the ripple to instead of the
  arrow. That makes PLAN.md keep its promise that the same script drives
  desktop and mobile.
- **The recorder mixed two coordinate systems.** `boundingBox()` answers in the
  frame, `getBoundingClientRect()` and `elementFromPoint()` answer in the
  document — as long as both are the same document, that goes unnoticed. Inside
  the frame the first run tapped at 35.28 instead of at 97.76. Both in-page
  measurements now convert themselves: the application reads its own seat in
  the frame through `window.frameElement`, which is only possible because the
  shell is same-origin. Without a frame the conversion is the identity, so the
  desktop path is unchanged.
- Incidentally: on a touch device the real mouse pointer is no longer moved at
  all. The travel stays in the log and is drawn — but a phone shows no hover
  states, and a mouse travelling across the screen would have triggered them.

## Left open

- **WebKit is still unchecked.** The iPhone and iPad profiles run under WebKit
  according to the registry; everything measured was under Chromium with the
  iPhone profile. The frame route is not Chromium-specific, but that is not
  proven.
- **30.6 frames/s is this application's number**, not the route's: the same
  shell with a light page inside it delivered 59. What another application's
  real frame rate is, only its own capture can say.
