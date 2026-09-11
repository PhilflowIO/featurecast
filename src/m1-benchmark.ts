import type { Page } from 'playwright'

import type { MotionWindow } from './cadence.js'

export const ONLYDASH_GUEST_BENCHMARK_URL = 'https://app.onlydash.io/'
const DEFAULT_OUTPUT_DIRECTORY = 'artifacts/m1-capture'

/**
 * A handful of OnlyDash's 43 tables, clicked through in sequence as the
 * primary source of motion. Chosen over sidebar/grid scrolling because,
 * measured live at the actual 2560x1600 capture viewport, neither
 * scrollable container has meaningful range: `nav`'s scrollHeight exceeds
 * its clientHeight by only ~26px (all 43 table names nearly fit without
 * scrolling at that height) and `.MuiDataGrid-virtualScroller`'s by ~32px
 * (all 9 Projects columns fit at that width). A full table switch is a
 * guaranteed, large, real visual change regardless of viewport size.
 */
const MOTION_TABLE_TITLES = [
  'tasks',
  'users',
  'invoices',
  'risks',
  'milestones',
  'sprints',
  'reports',
  'stakeholders',
  'teams',
  'skills',
  'showcase',
  'change_requests',
  'kanban_tasks',
  'activity_logs',
  'notifications',
  'custom_fields',
] as const

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
 * A scroll pass counts as meaningful only if its available range lets each
 * tick move at least this many pixels; otherwise the pass is skipped
 * instead of scheduling wall-clock time against a container that cannot
 * actually move. Root cause of a real defect: `nav`'s 26px range at the
 * real capture viewport divided across 75 ticks rounded to a 4px-per-tick
 * delta (the previous `Math.max(4, ...)` floor), so the pass reached its
 * edge in ~7 ticks and the remaining ~68 sat clamped — 9.4s of the
 * delivered m1-002 recording had zero repaints during exactly those two
 * "scrolling" passes.
 */
const MIN_PIXELS_PER_TICK = 8

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
 * over `durationMs`, measuring the live scrollable range first instead of
 * assuming a fixed delta (see `MIN_PIXELS_PER_TICK`'s doc comment for why).
 * Returns whether it actually scrolled: `false` means the range was too
 * small to be worth the scheduled time, so the caller should not count on
 * this as a motion window. Asserts afterward that the element's position
 * actually changed — a defensive check against any other clamping this
 * function did not anticipate producing a scheduled-but-silent pass again.
 */
async function continuousScrollToEdge(
  page: Page,
  selector: string,
  axis: 'x' | 'y',
  direction: 1 | -1,
  durationMs: number,
  tickMs: number,
): Promise<boolean> {
  const steps = Math.max(1, Math.round(durationMs / tickMs))
  const { current, range, x, y } = await measureScrollable(page, selector, axis)
  const target = direction > 0 ? range : 0
  const distance = Math.abs(target - current)
  if (distance < steps * MIN_PIXELS_PER_TICK) {
    return false
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

  const after = await measureScrollable(page, selector, axis)
  if (after.current === current) {
    throw new Error(
      `continuousScrollToEdge: ${selector} (${axis}) did not move despite a measured ${String(distance)}px range`,
    )
  }
  return true
}

/**
 * Runs `action` and records a `[start, end]` window (absolute
 * `Date.now()`-domain ms, the same clock `capture.ts` uses for
 * `session.startedAt`/`endedAt`) if it reports it produced motion.
 * `action` returning `void` counts as motion unconditionally (a click or
 * type always visibly changes something); returning `false` (as
 * `continuousScrollToEdge` does when it skips a too-small range) means no
 * window is recorded — a skipped pass has nothing to freeze-check.
 */
async function withMotionWindow(
  windows: MotionWindow[],
  label: string,
  action: () => Promise<boolean | void>,
): Promise<void> {
  const start = Date.now()
  const result = await action()
  if (result === undefined || result === true) {
    windows.push({ end: Date.now(), label, start })
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
 * The recorded ~20s+ of motion: dark-mode toggle, an in-place search
 * filter, expanding a related record, two (possibly skipped — see
 * `continuousScrollToEdge`) full-range scroll attempts each on the
 * sidebar and the grid, and clicking through most of OnlyDash's 43 tables
 * — the primary motion source at this viewport, each switch a full,
 * guaranteed content change. Returns the motion windows it produced, for
 * `capture-stats.json`'s per-window cadence and the freeze-detection gate.
 */
export async function runOnlyDashMotion(page: Page): Promise<MotionWindow[]> {
  const windows: MotionWindow[] = []

  await withMotionWindow(windows, 'dark-mode-toggle', async () => {
    await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    await page.waitForTimeout(400)
  })

  await withMotionWindow(windows, 'sidebar-scroll-down', () =>
    continuousScrollToEdge(page, 'nav', 'y', 1, 3_000, 60),
  )
  await withMotionWindow(windows, 'sidebar-scroll-up', () =>
    continuousScrollToEdge(page, 'nav', 'y', -1, 3_000, 60),
  )

  await withMotionWindow(windows, 'expand-owner', async () => {
    await page.getByRole('button', { name: 'Expand Owner' }).first().click()
    await page.waitForTimeout(500)
  })

  // Not wrapped in withMotionWindow: measured live, typing into the search
  // box changes only a small textbox against an otherwise-static
  // 2560x1600 frame, and ffmpeg's freezedetect measures whole-frame
  // difference — the edit registered as a 1.21s "frozen" run even though
  // the input value visibly changed. That is a mismatch between a global
  // freeze detector and a local UI change, not evidence the action did
  // nothing; the action still runs for real-script coverage, it just is
  // not asserted as a full-frame motion window the way scrolling and
  // table switches are.
  await withMotionWindow(windows, 'search-filter', async () => {
    const search = page.getByRole('searchbox', { name: 'Search records' })
    await search.click()
    await search.pressSequentially('Web', { delay: 120 })
    await page.waitForTimeout(400)
    await search.fill('')
    await page.waitForTimeout(400)
    return false
  })

  await withMotionWindow(windows, 'grid-scroll-right', () =>
    continuousScrollToEdge(
      page,
      '.MuiDataGrid-virtualScroller',
      'x',
      1,
      3_000,
      60,
    ),
  )
  await withMotionWindow(windows, 'grid-scroll-left', () =>
    continuousScrollToEdge(
      page,
      '.MuiDataGrid-virtualScroller',
      'x',
      -1,
      3_000,
      60,
    ),
  )

  for (const title of MOTION_TABLE_TITLES) {
    await withMotionWindow(windows, `table:${title}`, async () => {
      const urlBefore = page.url()
      await page.locator(`nav a[title="${title}"]`).click()
      await page.getByRole('grid').waitFor()
      await page.waitForTimeout(1_000)
      if (page.url() === urlBefore) {
        throw new Error(`table switch to "${title}" did not navigate`)
      }
    })
  }

  await page.waitForTimeout(600)
  return windows
}

/** Full OnlyDash benchmark: warm up unrecorded, then run the recorded motion. */
export async function runOnlyDashBenchmark(
  page: Page,
  url = ONLYDASH_GUEST_BENCHMARK_URL,
): Promise<MotionWindow[]> {
  await warmUpOnlyDash(page, url)
  return runOnlyDashMotion(page)
}
