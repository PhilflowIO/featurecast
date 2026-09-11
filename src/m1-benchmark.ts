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

/**
 * Scrolls by repeatedly issuing small wheel deltas with a pause between each,
 * instead of one large jump. M1's acceptance criterion asks for continuous
 * scrolling, not a single instant scroll — a dashboard's virtualized rows and
 * sticky headers only look intentional in the recording when the motion is
 * gradual.
 */
async function continuousScroll(
  page: Page,
  point: { x: number; y: number },
  delta: { x: number; y: number },
  steps: number,
  pauseMs: number,
): Promise<void> {
  await page.mouse.move(point.x, point.y)
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.wheel(delta.x, delta.y)
    await page.waitForTimeout(pauseMs)
  }
}

/**
 * Exercises OnlyDash's public guest sandbox (verified 2026-09-11 with a live
 * Playwright MCP session: guest sign-in needs no credentials, and "Demo,
 * changes are not saved" confirms nothing written is persisted). Guest
 * sign-in lands on a "Connect Your Account" upsell over the Projects
 * collection; clicking the Projects sidebar entry again is what actually
 * reveals the 43-table sidebar and the project data grid used for the rest
 * of the recording.
 *
 * Every pause is a fixed `waitForTimeout` rather than `networkidle`, because
 * a live dashboard keeps background connections open and would otherwise
 * never settle. The scripted pauses alone total just over 20 seconds; real
 * navigation, click, and render time on top of that comfortably clears M1's
 * 20-second acceptance bar.
 *
 * Two toolbar affordances were tried live against the real app and dropped:
 * "Expand all related records" stays disabled until a relation is browsed
 * first, and the "Priority" column header scrolls out of the DOM once the
 * grid is scrolled horizontally (its virtualization unmounts it). Both
 * would make the recording flaky rather than more convincing.
 */
export async function runOnlyDashBenchmark(
  page: Page,
  url = ONLYDASH_GUEST_BENCHMARK_URL,
): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Continue as Guest' }).click()
  await page.getByRole('link', { name: 'Projects' }).click()
  await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor()
  await page.getByRole('grid').waitFor()
  await page.waitForTimeout(1_500)

  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await page.waitForTimeout(900)

  // Scroll the 43-entry table sidebar down, then back up.
  await continuousScroll(page, { x: 140, y: 420 }, { x: 0, y: 220 }, 12, 260)
  await continuousScroll(page, { x: 140, y: 420 }, { x: 0, y: -220 }, 12, 260)

  await page.getByRole('button', { name: 'Expand Owner' }).first().click()
  await page.waitForTimeout(1_200)

  const search = page.getByRole('searchbox', { name: 'Search records' })
  await search.click()
  await search.pressSequentially('Web', { delay: 120 })
  await page.waitForTimeout(700)
  await search.fill('')
  await page.waitForTimeout(500)

  // Scroll the data grid horizontally to reveal the trailing columns, then
  // back to the start.
  await continuousScroll(page, { x: 800, y: 320 }, { x: 160, y: 0 }, 10, 220)
  await continuousScroll(page, { x: 800, y: 320 }, { x: -160, y: 0 }, 10, 220)

  await page.waitForTimeout(5_000)
}
