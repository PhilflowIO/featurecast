import type { Frame } from 'playwright'

import {
  ONLYDASH_GUEST_BENCHMARK_URL,
  warmUpOnlyDash,
} from '../src/m1-benchmark.js'
import type { Demo, RecordPage } from '../src/record.js'

/**
 * The recording M4 is accepted on: a real, dense application, interacted with
 * the way a feature video interacts with one.
 *
 * `demo/feature-xy.ts` cannot serve here. It is a `data:` URL with four
 * elements, which is exactly right for proving the command runs without an
 * account — and exactly wrong for judging whether the camera, the pointer and
 * the pacing look good. A zoom onto a lone button on a white page says nothing
 * about a zoom onto a row in a dense grid.
 *
 * **Everything that is not the demo happens in `prepare`.** Guest sign-in and
 * the navigation that actually reveals the grid run against the same page the
 * capture attaches to, but before it starts, so the video opens on the screen
 * the video is about. Without that split a recording of any real application
 * opens on its login form — and worse, records the pointer travelling across
 * it, because `demo`'s clicks are paced and drawn.
 *
 * The interactions are deliberately few and deliberately slow. This is not the
 * M1 benchmark, which drives as much motion as it can to measure cadence; it
 * is what a person would film: arrive, point at the thing, press it, let the
 * result land, look further down the page.
 */
/** The application this script films; see `LoadedScript.url`. */
export const url = ONLYDASH_GUEST_BENCHMARK_URL

export const prepare = async (app: Frame): Promise<void> => {
  await warmUpOnlyDash(app, ONLYDASH_GUEST_BENCHMARK_URL)
}

const DARK_MODE_BUTTON = 'role=button[name="Switch to dark mode"]'
const SEARCH_BOX = 'role=searchbox[name="Search records"]'

export default async function m4Acceptance(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  // Arrive, and let the first frames show the application at rest.
  await demo.hold(700)

  // A click whose effect is unmistakable at any zoom level: the whole page
  // changes colour. If the camera is framing the wrong element, this is the
  // shot where it is obvious.
  await demo.point(DARK_MODE_BUTTON)
  await demo.click(DARK_MODE_BUTTON)
  await demo.hold(1100)

  // Typing into a real filter: a small target in a dense surround, which is
  // the framing case a lone button cannot produce.
  await demo.click(SEARCH_BOX)
  await demo.type(SEARCH_BOX, 'Web')
  await demo.hold(1200)

  // And a scroll, so the idle trimmer and the pull-out both have something to
  // do between two shots.
  await demo.scroll(0, 420)
  await demo.hold(900)
  await page.waitForTimeout(300)
}
