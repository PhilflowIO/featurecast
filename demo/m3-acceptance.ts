import type { Frame } from 'playwright'

import { startFixtureServer } from '../src/fixture-server.js'
import { warmUpBenchApp } from '../src/m1-benchmark.js'
import type { Demo, RecordPage } from '../src/record.js'

/**
 * The recording M3 is accepted on: the bench corpus at a phone's width, in
 * portrait.
 *
 * It is deliberately the same application as `demo/m4-acceptance.ts` and
 * nearly the same journey. M3's question is not "can we film something else"
 * — it is whether a mobile layout can be filmed sharply at 1080x1920, and the
 * honest way to answer that is to change one thing, the device, and look at
 * what comes out.
 *
 * What is different is only what a phone makes different: the interactions
 * are the ones a thumb performs — taps and swipes, no hover. The controls
 * themselves are the same ones the desktop script uses, because the corpus
 * shows the same controls at every width (#77); there is no menu to open
 * first, and therefore no journey that only exists below a certain width.
 */

/**
 * The application, named up front and served from the repository. A framed
 * capture serves its shell from the application's own origin, which has to
 * exist and be known before the first frame; see `src/framed.ts` and
 * `src/fixture-server.ts`.
 */
const fixture = await startFixtureServer()
export const url = fixture.origin

export const prepare = async (app: Frame): Promise<void> => {
  await warmUpBenchApp(app, url)
}

const DARK_MODE_BUTTON = 'role=button[name="Switch to dark mode"]'
const TASKS_LINK = 'nav a[title="tasks"]'

export default async function m3Acceptance(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  // Arrive, and let the first frames show the application at rest.
  await demo.hold(800)

  // A tap whose effect is unmistakable: the whole screen changes colour.
  // `demo.click` is a tap here — the wrapper reads the device, so the script
  // does not have to.
  await demo.point(DARK_MODE_BUTTON)
  await demo.click(DARK_MODE_BUTTON)
  await demo.hold(1000)

  // A second tap that changes the whole content area, not just its colour.
  await demo.point(TASKS_LINK)
  await demo.click(TASKS_LINK)
  await demo.hold(900)

  // Then the two scrolls, in the order that matters: down through the grid,
  // which is where a portrait format either shows a dense application or
  // shows empty table — and sideways, which is where the historical
  // smoothness finding sat.
  await demo.scroll(0, 700)
  await demo.hold(800)
  await demo.scroll(900, 0)
  await demo.hold(1000)
  await page.waitForTimeout(300)
}
