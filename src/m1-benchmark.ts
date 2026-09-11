import type { Page } from 'playwright'

export const ONLYDASH_GUEST_BENCHMARK_URL = 'https://app.onlydash.io/'
const DEFAULT_OUTPUT_DIRECTORY = 'artifacts/m1-capture'

export function resolveM1CaptureArguments(arguments_: readonly string[]): {
  outputDirectory: string
  url: string
} {
  const [
    url = ONLYDASH_GUEST_BENCHMARK_URL,
    outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  ] = arguments_
  return { outputDirectory, url }
}

type ScrollableMetrics = {
  current: number
  range: number
  x: number
  y: number
}

/** Measures a scrollable element's remaining range and viewport center live. */
async function measureScrollable(
  page: Page,
  selector: string,
  axis: 'x' | 'y',
): Promise<ScrollableMetrics> {
  return page.evaluate(
    ({ axis: axisArgument, selector: selectorArgument }) => {
      const element = document.querySelector(selectorArgument)
      if (!(element instanceof HTMLElement)) {
        throw new Error(`scrollable element not found: ${selectorArgument}`)
      }
      const rect = element.getBoundingClientRect()
      return {
        current: axisArgument === 'y' ? element.scrollTop : element.scrollLeft,
        range:
          axisArgument === 'y'
            ? element.scrollHeight - element.clientHeight
            : element.scrollWidth - element.clientWidth,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      }
    },
    { axis, selector },
  )
}

/**
 * Scrolls `selector` toward one edge with many small wheel ticks spread
 * over `durationMs`, instead of a fixed delta guessed in advance.
 *
 * A fixed delta was the root cause of a real defect: a 220px delta against
 * OnlyDash's table sidebar (scrollable range ~900px, and not starting at
 * the top — it auto-scrolls to the selected table on load) blew past the
 * bottom in 2-4 ticks, then spent the remaining 8-10 scheduled ticks
 * sitting at the clamped edge doing nothing — visually static time counted
 * as "scrolling" in the script's own accounting. Measuring the live
 * scrollable range and dividing it across the tick count guarantees the
 * element is still moving on the very last tick.
 */
async function continuousScrollToEdge(
  page: Page,
  selector: string,
  axis: 'x' | 'y',
  direction: 1 | -1,
  durationMs: number,
  tickMs: number,
): Promise<void> {
  const steps = Math.max(1, Math.round(durationMs / tickMs))
  const { current, range, x, y } = await measureScrollable(page, selector, axis)
  const target = direction > 0 ? range : 0
  const distance = Math.abs(target - current)
  if (distance <= 0) {
    return
  }
  const perTick = Math.max(4, Math.round(distance / steps)) * direction

  await page.mouse.move(x, y)
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(
      axis === 'x' ? perTick : 0,
      axis === 'y' ? perTick : 0,
    )
    await page.waitForTimeout(tickMs)
  }
}

/**
 * Signs into OnlyDash's public guest sandbox and lands on the dense
 * Projects data grid. Deliberately run *before* `captureScreencast` starts:
 * capturing this sequence produced ~0.9s of blank white frames at the head
 * of a real recording (the auth screen and the post-login "Connect Your
 * Account" upsell are not the content M1 is meant to show), and M1's
 * acceptance criterion is 20s of the actual dense UI, not 20s that includes
 * a loading screen.
 *
 * Verified live 2026-09-11 with Playwright MCP against a cleared session:
 * guest sign-in needs no credentials, "Demo, changes are not saved"/"Writes
 * are simulated" confirms nothing written is persisted, and sign-in lands
 * on a "Connect Your Account" upsell over the Projects collection —
 * clicking the Projects sidebar entry again is what actually reveals the
 * grid.
 */
export async function warmUpOnlyDash(
  page: Page,
  url = ONLYDASH_GUEST_BENCHMARK_URL,
): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Continue as Guest' }).click()
  await page.getByRole('link', { name: 'Projects' }).click()
  await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor()
  await page.getByRole('grid').waitFor()
  // Lets the grid's own data-fetch settle and any mount transition finish
  // before the first frame is captured. Not recorded, so a generous wait
  // costs nothing.
  await page.waitForTimeout(600)
}

/**
 * The recorded ~20s of motion: dark-mode toggle, two full-range scroll
 * passes over the 43-entry table sidebar, expanding a related record, a
 * live search filter, and two full-range horizontal scroll passes over the
 * data grid. `continuousScrollToEdge` accounts for the large majority of
 * the wall-clock time and is genuinely continuous motion throughout (see
 * its doc comment); the remaining pauses are short settle times after a
 * click, not idle padding.
 *
 * Two toolbar affordances were tried against the live app and dropped
 * after they broke real runs: "Expand all related records" stays disabled
 * until a relation is browsed first, and the "Priority" column header
 * unmounts once the grid is scrolled horizontally (virtualized).
 */
export async function runOnlyDashMotion(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await page.waitForTimeout(400)

  await continuousScrollToEdge(page, 'nav', 'y', 1, 4_500, 60)
  await continuousScrollToEdge(page, 'nav', 'y', -1, 4_500, 60)

  await page.getByRole('button', { name: 'Expand Owner' }).first().click()
  await page.waitForTimeout(500)

  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.click()
  await search.pressSequentially('Web', { delay: 120 })
  await page.waitForTimeout(400)
  await search.fill('')
  await page.waitForTimeout(400)

  await continuousScrollToEdge(
    page,
    '.MuiDataGrid-virtualScroller',
    'x',
    1,
    4_500,
    60,
  )
  await continuousScrollToEdge(
    page,
    '.MuiDataGrid-virtualScroller',
    'x',
    -1,
    4_500,
    60,
  )

  await page.waitForTimeout(800)
}

/** Full OnlyDash benchmark: warm up unrecorded, then run the recorded motion. */
export async function runOnlyDashBenchmark(
  page: Page,
  url = ONLYDASH_GUEST_BENCHMARK_URL,
): Promise<void> {
  await warmUpOnlyDash(page, url)
  await runOnlyDashMotion(page)
}
