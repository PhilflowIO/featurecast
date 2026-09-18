import type { Demo, RecordPage } from '../src/record.js'
import {
  RAVEN_FIXED_TIME,
  RAVEN_HIDE_SELECTORS,
  RAVEN_URL,
  vorbereiten,
} from './raven-common.js'

/**
 * Raven's public landing page, signed out: the hero at full width, then a slow
 * scroll down through the first sections. Length is about 15-20 seconds.
 *
 * NO SESSION, ON PURPOSE. This script exports no `storageStatePath`. The
 * landing page is what a stranger sees, and a signed-in visitor would get a
 * different navigation bar with an account entry in it. That account entry is
 * the one place a real address could enter the frame. Without a session there
 * is no account to show.
 *
 * WHY THE SCROLL IS MEASURED IN SCREENS AND NOT IN PIXELS. The same script
 * films `desktop-wide` and `iphone`. A fixed 900 px is almost a whole screen on
 * the phone and less than one on the desktop, so one of the two would either
 * skip a section or stall in the middle of one. Each step is a fraction of the
 * viewport the page reports at run time. On a touch device `demo.scroll` is a
 * swipe (see `src/record.ts`), so the same call works on both devices.
 *
 * WHY THERE IS NO HORIZONTAL SCROLL. Every scroll is vertical only. A
 * sideways move loses capture yield and shows nothing the vertical pass does
 * not already show.
 *
 * The hide list is the shared one. The landing page has neither the room card
 * nor a cookie notice today. It still gets the list, because one list for
 * every Raven recording is the only kind that nobody forgets to extend.
 *
 * INVOCATION::
 *
 *     tools/gpu-box/record.sh demo/raven-startseite.ts --devices desktop-wide
 *
 * Record it on the GPU host (`tools/gpu-box/record.sh`, see
 * docs/RECORDING-SCRIPTS.md). This page's photos and gradients are expensive
 * to paint: before featurecast#150 every recording painted in software, the
 * scroll ran at about 20 frames per second and took 21.8 s instead of 9.3 s,
 * and the clip juddered. The renderer keeps wall time and trims only idle
 * stretches, so a slow scroll is not compressed away.
 *
 * THE PHONE DOES NOT WORK AGAINST RAVEN YET. `iphone` films through the framed
 * shell (`src/framed.ts`), which puts the application into an iframe on its
 * own origin and relies on `X-Frame-Options: SAMEORIGIN`. Raven sends
 * `X-Frame-Options: DENY` and `frame-ancestors 'none'`, so Chromium refuses
 * the frame (`net::ERR_BLOCKED_BY_RESPONSE`). `devices` still names the phone,
 * because that is the clip this script is for. Until the framed capture can
 * film an application that forbids framing, pass `--devices desktop-wide`.
 */

/** The application that is filmed. Required for the phone: see `src/framed.ts`. */
export const url = RAVEN_URL

/** The landing page is filmed on the desktop and on the phone. */
export const devices = ['desktop-wide', 'iphone']

/** The shared list; see `raven-common.ts`. */
export const hideSelectors = RAVEN_HIDE_SELECTORS

/** A fixed clock, so nothing time-dependent moves between two runs. */
export const fixedTime = RAVEN_FIXED_TIME

/**
 * The page is loaded before the camera rolls, so the clip opens on the hero
 * and not on a white page (see `vorbereiten`). The headline, not the section:
 * the section box exists before the web font has laid it out.
 */
export const prepare = vorbereiten('/', '#hero h1')

/**
 * Scroll pace in px/s. It is slower than the default 700 because the viewer
 * reads the sections as they pass instead of skipping them.
 */
const TEMPO = 450

export default async function startseite(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  // `prepare` has opened the page and seen the headline. Long enough for the hero card's entrance to finish AND be read. The first
  // trial run held 2.8 s and the video left the hero while the headline was
  // still arriving.
  await demo.hold(3500)

  const hoehe = page.viewportSize()?.height ?? 900
  // Three steps of 0.85 screens each: past the partner strip into "Die erste
  // Meeting-Plattform, die dich versteht", through the agent demo, into the
  // chapter band "Nichts geht raus, bevor du es freigibst". Each step is
  // followed by a hold long enough to read one headline. Script time is about
  // 18 s. The video only matches that on a machine that paints at the capture
  // rate; see the invocation note above.
  for (const halt of [1800, 1800, 2400]) {
    await demo.scroll(0, Math.round(hoehe * 0.85), {
      speedPxPerSecond: TEMPO,
    })
    await demo.hold(halt)
  }
}
