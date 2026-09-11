import type { Page } from 'playwright'

import type { MotionWindow } from './cadence.js'
import type { Demo } from './record.js'

export const ONLYDASH_GUEST_BENCHMARK_URL = 'https://app.onlydash.io/'
const DEFAULT_OUTPUT_DIRECTORY = 'artifacts/m1-capture'

/**
 * Measured live against all 43 OnlyDash tables at the real 2560x1600
 * capture viewport: only these hold >=10 records (`tasks` 19, `invoices`
 * 17, `users` 13, `expenses` 13) — everything else, including most of a
 * previous version's 16-table rotation, holds 0-2. A 2-row table on a
 * ~70% empty dark background held for a full second is not the dense UI
 * M1 asks for, no matter how many distinct such tables a script visits.
 * `tasks` and `invoices` are additionally the only tables with a
 * meaningfully scrollable grid at this viewport (528px/369px vertical
 * range; every other table measured <=71px) — real within-table motion,
 * not just a sequence of static screenshots.
 */
const DENSE_TABLES = ['tasks', 'invoices', 'users', 'expenses'] as const
const MIN_TABLE_RECORDS = 10

/**
 * Below this, a scroll is not worth claiming as a motion window (see
 * `scrollContainerToEdge`). 150, not 200: measured live, `tasks`'
 * horizontal range is 180px — real, visible column-scroll — and a 200px
 * floor made that scroll unreachable for no reason.
 */
const MIN_MEANINGFUL_SCROLL_PX = 150

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

type ScrollableMetrics = { current: number; range: number }

/** Measures a scrollable element's remaining range live. */
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
      return {
        current: axisArgument === 'y' ? element.scrollTop : element.scrollLeft,
        range:
          axisArgument === 'y'
            ? element.scrollHeight - element.clientHeight
            : element.scrollWidth - element.clientWidth,
      }
    },
    { axis, selector },
  )
}

/**
 * Positions the mouse over `selector` with a single `boundingBox()` read
 * and jump, instead of `demo.point`'s verified-hit-test-and-settle
 * machinery. That machinery exists for precise click targeting (wait for
 * geometry to stop moving, verify the exact pixel actually hits the
 * element) and is the wrong tool for hovering a scroll container: measured
 * live against `.MuiDataGrid-virtualScroller`, its 80ms-stability window
 * never closed within a 10s `settleTimeoutMs` because MUI's row
 * virtualization keeps recalculating the scroller's own geometry while
 * scrolling — `demo.point` doesn't just fail to help here, it inflates the
 * claimed motion window with several seconds of static waiting BEFORE any
 * real scrolling starts, which is exactly the frozen-motion-window problem
 * this benchmark is supposed to avoid. The cursor is not rendered in the
 * capture (PLAN.md renders it in a later post-processing stage from
 * `events.jsonl`), so an instant jump has no visual cost; only the actual
 * wheel pacing (`demo.scroll`, still 60Hz) needs to go through the wrapper.
 */
async function hoverContainer(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox()
  if (box === null) {
    throw new Error(`hoverContainer: ${selector} has no bounding box`)
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

/**
 * Scrolls `selector` toward one edge through the merged `demo.scroll`
 * wrapper (60Hz-paced, `src/record.ts`) instead of a hand-rolled wheel
 * loop: a hand-rolled `await page.waitForTimeout(60)`-per-tick loop
 * measured a 69.79ms median interval on `grid-scroll-right` (1.9% of gaps
 * <=20ms) — ~14fps of visible motion, not smooth scrolling, because each
 * tick paid the real cost of a JS-side timer plus its own event-loop
 * turnaround on top of the nominal 60ms. `demo.scroll` paces against
 * absolute deadlines and lets Chromium coalesce delivery, and is already
 * proven at 60Hz on a 105k-move sweep.
 *
 * Measures the live scrollable range first (not a fixed delta) and skips
 * (returns false) if it is below `MIN_MEANINGFUL_SCROLL_PX` — real ranges
 * for the sidebar (~26px) and most grids (~2-71px) at this viewport are
 * not worth claiming as motion. Asserts afterward that the position
 * actually changed when it did attempt to scroll.
 */
async function scrollContainerToEdge(
  page: Page,
  demo: Demo,
  selector: string,
  axis: 'x' | 'y',
  direction: 1 | -1,
): Promise<boolean> {
  const { current, range } = await measureScrollable(page, selector, axis)
  const target = direction > 0 ? range : 0
  const delta = target - current
  if (Math.abs(delta) < MIN_MEANINGFUL_SCROLL_PX) {
    return false
  }
  await hoverContainer(page, selector)
  await demo.scroll(axis === 'x' ? delta : 0, axis === 'y' ? delta : 0)

  const after = await measureScrollable(page, selector, axis)
  if (after.current === current) {
    throw new Error(
      `scrollContainerToEdge: ${selector} (${axis}) did not move despite a measured ${String(Math.abs(delta))}px range`,
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
 * `scrollContainerToEdge` does when it skips a too-small range) means no
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

/** Waits (briefly, non-fatally) for a "Loading…" chart panel to clear before continuing. */
async function waitForLoadingToClear(page: Page): Promise<void> {
  await page
    .getByText(/Loading/i)
    .first()
    .waitFor({ state: 'hidden', timeout: 2_000 })
    .catch(() => undefined)
}

/**
 * Re-sorts the grid by clicking its first column header twice (ascending,
 * then descending) — a guaranteed row-reorder, independent of scroll
 * range. Added after a live probe found the grid's scroller grows to fit
 * all rows once the layout settles (`tasks`: 517px vertical range on
 * first visit, 2px on a second visit to the same table — the container
 * itself, not `demo.scroll` or the measurement, since a fresh measurement
 * runs every time). Scrolling is real motion when it is available (mostly
 * the first visit to a table); sorting is real motion always, so a later
 * cycle is not just a sequence of static holds once scroll range runs out.
 */
async function sortFirstColumn(
  windows: MotionWindow[],
  page: Page,
  label: string,
): Promise<void> {
  const header = page.getByRole('columnheader').first()
  await withMotionWindow(windows, `${label}:sort-asc`, async () => {
    await header.click()
    await page.waitForTimeout(400)
  })
  await withMotionWindow(windows, `${label}:sort-desc`, async () => {
    await header.click()
    await page.waitForTimeout(400)
  })
}

/**
 * Root-cause defense for the dense-UI requirement: rather than trusting
 * `DENSE_TABLES` to stay accurate forever (a demo dataset can change), read
 * the live "N records" heading and fail loudly if a table that was
 * selected for its density no longer has it.
 */
async function assertTableIsDense(page: Page, title: string): Promise<void> {
  const recordCount = await page.evaluate(() => {
    const heading = document.querySelector('main h1')
    const text = heading?.parentElement?.textContent ?? ''
    const match = /(\d+)\s*records?/.exec(text)
    return match ? Number(match[1]) : -1
  })
  if (recordCount < MIN_TABLE_RECORDS) {
    throw new Error(
      `table "${title}" has ${String(recordCount)} records, below the ${String(MIN_TABLE_RECORDS)}-record density floor`,
    )
  }
}

/**
 * Deliberately does *not* go through `demo.click`: `demo`'s pointer travel
 * is a real, paced 0.4-4s curve to the target (by design — that realism is
 * the point of the event log), but the cursor is not rendered into this
 * capture (PLAN.md renders it later, from `events.jsonl`, in a
 * post-processing stage this milestone doesn't build). Measured live: 12
 * table switches through `demo.click` each carried 2.5-6.5s of window
 * duration, almost entirely invisible travel time, and pushed the frozen
 * share of motion-window time past 55% — the exact defect this benchmark
 * exists to avoid. A plain `Locator.click()` (Playwright's own near-instant
 * click, no artificial curve) is used instead for the one interaction that
 * runs a dozen times per recording; `demo.click`/`demo.type` remain in use
 * for the few single-shot interactions (dark-mode toggle, expand-owner,
 * search) where the total travel-time cost is small.
 */
async function switchToTable(
  windows: MotionWindow[],
  page: Page,
  title: string,
  label: string,
): Promise<void> {
  await withMotionWindow(windows, label, async () => {
    const urlBefore = page.url()
    await page.locator(`nav a[title="${title}"]`).click()
    await page.getByRole('grid').waitFor()
    if (page.url() === urlBefore) {
      throw new Error(`table switch to "${title}" did not navigate`)
    }
  })
  await waitForLoadingToClear(page)
  await assertTableIsDense(page, title)
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
  await waitForLoadingToClear(page)
  // Lets any remaining mount transition finish before the first frame is
  // captured. Not recorded, so a generous wait costs nothing.
  await page.waitForTimeout(600)
}

/**
 * The recorded ~20s+ of motion, driven through the merged `demo` wrapper
 * (`src/record.ts`) for every click, type, and scroll: dark-mode toggle,
 * expanding a related record, an in-place search filter (real UI change,
 * not asserted as a motion window — see the comment at its call site), and
 * two passes through `DENSE_TABLES` — genuinely dense grids, scrolled
 * vertically and (for `tasks`, which is also wider than the viewport)
 * horizontally wherever the range is meaningful. Returns the motion
 * windows produced, for `capture-stats.json`'s per-window cadence and the
 * freeze-detection gate.
 *
 * `page` (not just `demo`) is threaded through for everything `demo`
 * cannot do: measuring scrollable range, waiting for a locator's role,
 * reading `page.url()`, and text-based "Loading…" polling — `Demo` is
 * purely an interaction API, not a DOM inspection one.
 */
export async function runOnlyDashMotion(
  page: Page,
  demo: Demo,
): Promise<MotionWindow[]> {
  const windows: MotionWindow[] = []

  // `role=` selector-engine strings, not `getByRole(...)` Locators:
  // Playwright's `Locator` doesn't structurally satisfy `demo`'s
  // `LocatorLike` (its `evaluate` overload set is too generic for a plain
  // callers-side interface).
  const DARK_MODE_BUTTON = 'role=button[name="Switch to dark mode"]'
  const EXPAND_OWNER_BUTTON = 'role=button[name="Expand Owner"] >> nth=0'
  const SEARCH_BOX = 'role=searchbox[name="Search records"]'

  // Plain `Locator.click()`, not `demo.click()`, for the same reason
  // `switchToTable` avoids it (see that function's doc comment): these
  // single-shot clicks measured 2.6-3.9s of mostly-invisible pointer
  // travel each through `demo.click`, almost entirely counted as frozen
  // motion-window time since the cursor isn't rendered into this capture.
  await withMotionWindow(windows, 'dark-mode-toggle', async () => {
    await page.locator(DARK_MODE_BUTTON).click()
    await page.waitForTimeout(400)
  })

  await withMotionWindow(windows, 'expand-owner', async () => {
    await page.locator(EXPAND_OWNER_BUTTON).click()
    await page.waitForTimeout(500)
  })

  // Not wrapped as an asserted motion window: measured live, typing into
  // the search box changes only a small textbox against an otherwise-static
  // 2560x1600 frame, and ffmpeg's freezedetect measures whole-frame
  // difference — the edit registered as a 1.21s "freeze" despite the input
  // value visibly changing. The action still runs for real-script coverage,
  // and does go through `demo.type` — its keystroke-jitter pacing has no
  // travel-time cost, unlike click/point.
  await withMotionWindow(windows, 'search-filter', async () => {
    await page.locator(SEARCH_BOX).click()
    await demo.type(SEARCH_BOX, 'Web')
    await page.waitForTimeout(400)
    await page.locator(SEARCH_BOX).fill('')
    await page.waitForTimeout(400)
    return false
  })

  for (const cycle of [1, 2]) {
    const windowsBeforeCycle = windows.length
    for (const title of DENSE_TABLES) {
      await switchToTable(
        windows,
        page,
        title,
        `table:${title}:${String(cycle)}`,
      )
      // Not part of any asserted motion window: this is dwell time so a
      // viewer actually sees the newly-loaded dense table, not scripted
      // "motion".
      await page.waitForTimeout(700)
      await withMotionWindow(
        windows,
        `${title}:scroll-down:${String(cycle)}`,
        () =>
          scrollContainerToEdge(
            page,
            demo,
            '.MuiDataGrid-virtualScroller',
            'y',
            1,
          ),
      )
      await withMotionWindow(
        windows,
        `${title}:scroll-up:${String(cycle)}`,
        () =>
          scrollContainerToEdge(
            page,
            demo,
            '.MuiDataGrid-virtualScroller',
            'y',
            -1,
          ),
      )
      await withMotionWindow(
        windows,
        `${title}:scroll-right:${String(cycle)}`,
        () =>
          scrollContainerToEdge(
            page,
            demo,
            '.MuiDataGrid-virtualScroller',
            'x',
            1,
          ),
      )
      await withMotionWindow(
        windows,
        `${title}:scroll-left:${String(cycle)}`,
        () =>
          scrollContainerToEdge(
            page,
            demo,
            '.MuiDataGrid-virtualScroller',
            'x',
            -1,
          ),
      )
      // Scrolling is real motion only while the grid's own scroll range
      // stays meaningful, which a live probe found shrinks to ~0 once its
      // layout settles on a repeat visit — not a scroll or measurement
      // bug, a real property of this content. Sorting is unconditional
      // motion regardless of scroll range, so a later cycle keeps
      // producing real, visible change instead of running out of
      // choreography into a sequence of static holds.
      await sortFirstColumn(windows, page, `${title}:${String(cycle)}`)
      await page.waitForTimeout(300)
    }
    if (windows.length === windowsBeforeCycle) {
      throw new Error(
        `runOnlyDashMotion: cycle ${String(cycle)} produced no motion windows at all across ${DENSE_TABLES.join(', ')}`,
      )
    }
  }

  await page.waitForTimeout(600)
  return windows
}

/** Full OnlyDash benchmark: warm up unrecorded, then run the recorded motion. */
export async function runOnlyDashBenchmark(
  page: Page,
  demo: Demo,
  url = ONLYDASH_GUEST_BENCHMARK_URL,
): Promise<MotionWindow[]> {
  await warmUpOnlyDash(page, url)
  return runOnlyDashMotion(page, demo)
}
