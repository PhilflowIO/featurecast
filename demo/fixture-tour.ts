import type { Frame } from 'playwright'

import { startFixtureServer } from '../src/fixture-server.js'
import { warmUpBenchApp } from '../src/m1-benchmark.js'
import type { Demo, RecordPage } from '../src/record.js'

/**
 * One script, four device classes: `desktop`, `tablet`, `iphone`, `android`.
 *
 * ```
 * pnpm featurecast run demo/fixture-tour.ts \
 *   --devices desktop,iphone,android,tablet
 * ```
 *
 * ## Why this did not exist before
 *
 * It was never the device layer that stopped it (#77). The previous
 * acceptance script tapped a menu button that the application it filmed only
 * showed at a phone's width, so `desktop` and `tablet` failed on a control
 * that was not there — a fact about somebody else's layout, arriving as a
 * pipeline failure. The bench corpus shows the same five controls at every
 * width, which is what makes a single journey honest rather than lucky.
 *
 * ## The rule this script follows
 *
 * **Touch nothing that exists at one width only.** Every element below is
 * present and hit-testable at 393 CSS pixels and at 1920 alike, which is
 * proven independently in `tests/fixture-page.browser.test.ts` rather than
 * assumed here.
 *
 * ## Why the pointer is parked before every scroll
 *
 * Chromium binds a wheel to the element under the pointer and does not hand
 * the remainder to an ancestor. The corpus deliberately has a scroll
 * container inside another one, so a wheel delivered over the navigation
 * strip — where the previous tap left the pointer — reaches a container with
 * nothing to scroll and the shot is dead. Pointing at the grid first costs a
 * paced travel the video shows anyway, and it is the same instruction on a
 * phone, where it becomes the finger arriving before it swipes.
 */

/**
 * The application, served from the repository on a port this run is given.
 * A touch profile is recorded through the framed strategy, whose shell comes
 * from the application's own origin — so this has to be a real origin and is
 * why the corpus has a server at all (`src/fixture-server.ts`).
 */
const fixture = await startFixtureServer()
export const url = fixture.origin

export const prepare = async (app: Frame): Promise<void> => {
  await warmUpBenchApp(app, url)
}

const DARK_MODE_BUTTON = 'role=button[name="Switch to dark mode"]'
const SEARCH_BOX = 'role=searchbox[name="Search records"]'
const TASKS_LINK = 'nav a[title="tasks"]'
const GRID = '#gridscroller'

export default async function fixtureTour(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  // Arrive, and let the first frames show the application at rest.
  await demo.hold(700)

  // The colour of the whole picture changes. If a device's camera is framed
  // wrongly, this is the shot where it is obvious at any zoom level.
  await demo.point(DARK_MODE_BUTTON)
  await demo.click(DARK_MODE_BUTTON)
  await demo.hold(900)

  // A second press that replaces the content rather than recolouring it.
  await demo.point(TASKS_LINK)
  await demo.click(TASKS_LINK)
  await demo.hold(800)

  // Down the grid, then across it. Sideways is the one that matters: it is
  // where the historical smoothness finding sat, and it is the direction a
  // sticky first column makes expensive.
  await demo.point(GRID)
  await demo.scroll(0, 600)
  await demo.hold(700)
  await demo.scroll(700, 0)
  await demo.hold(700)
  await demo.scroll(-700, 0)
  await demo.hold(600)

  // A small target in a dense surround — the framing case a lone button on an
  // empty page cannot produce.
  await demo.point(SEARCH_BOX)
  await demo.click(SEARCH_BOX)
  await demo.type(SEARCH_BOX, 'Web')
  await demo.hold(1000)
  await page.waitForTimeout(300)
}
