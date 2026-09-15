import type { Frame } from 'playwright'

import {
  ONLYDASH_GUEST_BENCHMARK_URL,
  warmUpOnlyDash,
} from '../src/m1-benchmark.js'
import type { Demo, RecordPage } from '../src/record.js'

/**
 * The recording M3 is accepted on: the same real application as
 * `demo/m4-acceptance.ts`, at a phone's width, in portrait.
 *
 * It is deliberately the same application and nearly the same journey. M3's
 * question is not "can we film something else" — it is whether a mobile
 * layout can be filmed sharply at 1080x1920, and the honest way to answer
 * that is to change one thing, the device, and look at what comes out.
 *
 * What is different is only what a phone makes different: the sidebar lives
 * behind a menu button, so the navigation that reveals the grid is a tap on
 * that button first (handled inside `warmUpOnlyDash`, which decides on
 * visibility rather than on the device), and the interactions are the ones a
 * thumb performs — taps and a vertical scroll, no hover.
 */

/**
 * The application, named up front. A framed capture serves its shell from
 * the application's own origin, which has to be known before the first
 * frame; see `src/framed.ts`.
 */
export const url = ONLYDASH_GUEST_BENCHMARK_URL

export const prepare = async (app: Frame): Promise<void> => {
  await warmUpOnlyDash(app, ONLYDASH_GUEST_BENCHMARK_URL)
}

const DARK_MODE_BUTTON = 'role=button[name="Switch to dark mode"]'
const MENU_BUTTON = 'role=button[name=/toggle menu/i]'
const CLOSE_DRAWER = 'aside [data-testid="CloseIcon"]'

export default async function m3Acceptance(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  // Arrive, and let the first frames show the application at rest.
  await demo.hold(800)

  // A tap whose effect is unmistakable: the whole screen changes colour. On
  // a phone the control lives inside the drawer, so the shot is three
  // deliberate taps — open, press, close — which is closer to what a real
  // feature video of a mobile application looks like than a single press on
  // a lone control. `demo.click` is a tap here: the wrapper reads the
  // device, so the script does not have to.
  await demo.point(MENU_BUTTON)
  await demo.click(MENU_BUTTON)
  await demo.hold(900)
  await demo.point(DARK_MODE_BUTTON)
  await demo.click(DARK_MODE_BUTTON)
  await demo.hold(1000)
  await demo.click(CLOSE_DRAWER)
  await demo.hold(1000)

  // And a scroll through the grid, which is where a portrait format either
  // shows a dense application or shows empty table.
  await demo.scroll(0, 700)
  await demo.hold(900)
  await demo.scroll(0, 500)
  await demo.hold(1000)
  await page.waitForTimeout(300)
}
