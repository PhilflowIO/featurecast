import type { ElementHandle, Frame, Page } from 'playwright'

import type { MotionWindow } from './cadence.js'
import type { Demo } from './record.js'
import type { WheelPoint } from './wheel-target.js'

import { chooseWheelPoint } from './wheel-target.js'

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

/**
 * How long every scroll range on the page must stay unchanged before a
 * scroll target may be chosen. Measured live on the AI box (RTX 3090):
 * after a table switch OnlyDash's DataGrid root starts at the height the
 * previous view left behind and then grows by exactly 1px per rendered
 * frame (~24fps while it grows, because every step re-lays-out the whole
 * grid) until it fits every row — 27s for `tasks` after the Projects view.
 * While it grows, scroll range drains from the grid's own
 * `.MuiDataGrid-virtualScroller` into the page's `main` container (their
 * sum stays ~590px for `tasks`), so "the element with the largest range"
 * is decided by how far that growth has got at the instant of asking. A
 * 1px step every ~40ms changes the signature well inside 500ms, so this
 * window cannot mistake a growing layout for a settled one.
 */
export const SCROLL_GEOMETRY_STABLE_MS = 500
const SCROLL_GEOMETRY_SAMPLE_MS = 50
/** Upper bound for one settle wait; the longest growth measured was 27s. */
export const SCROLL_GEOMETRY_TIMEOUT_MS = 45_000

/**
 * Resolves once the scroll range of every scrollable element on the page
 * (every `overflow: auto|scroll` element with a non-zero range, plus the
 * document's own scrolling element) has stayed identical for `stableMs`,
 * sampled in-page every 50ms; throws if that never happens within
 * `timeoutMs`. Returns how long the wait took, for the run's report.
 *
 * This is what makes scroll-target selection deterministic: choosing
 * during a layout transient picks whichever nested scroller currently
 * holds more of the range (see `SCROLL_GEOMETRY_STABLE_MS`), and scrolling
 * during it also runs against a main thread saturated by the growth
 * itself (measured: 22-24 rAF ticks/s, 54ms median wheel round trip, a
 * 503px `demo.scroll` taking 2.7s instead of ~0.8s).
 */
export async function waitForStableScrollGeometry(
  page: Pick<Page, 'evaluate'>,
  stableMs = SCROLL_GEOMETRY_STABLE_MS,
  timeoutMs = SCROLL_GEOMETRY_TIMEOUT_MS,
): Promise<number> {
  // A raw source string for the same `__name` reason as
  // `findLargestScrollElement` below; all three numbers are this module's
  // own finite constants or a caller's number, never user text.
  const outcome = (await page.evaluate(`
    new Promise(function (resolve) {
      var stableMs = ${String(stableMs)};
      var sampleMs = ${String(SCROLL_GEOMETRY_SAMPLE_MS)};
      var timeoutMs = ${String(timeoutMs)};
      var ids = new WeakMap();
      var nextId = 0;
      var start = Date.now();
      var lastSignature = null;
      var lastChange = start;
      function idOf(element) {
        if (!ids.has(element)) ids.set(element, nextId++);
        return ids.get(element);
      }
      function signature() {
        var root = document.scrollingElement || document.documentElement;
        var parts = ['root:' + (root.scrollHeight - root.clientHeight) + 'x' + (root.scrollWidth - root.clientWidth)];
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var element = all[i];
          var rangeY = element.scrollHeight - element.clientHeight;
          var rangeX = element.scrollWidth - element.clientWidth;
          if (rangeY <= 0 && rangeX <= 0) continue;
          var style = getComputedStyle(element);
          var scrollable = /auto|scroll/;
          if (!scrollable.test(style.overflowY) && !scrollable.test(style.overflowX)) continue;
          parts.push(idOf(element) + ':' + rangeY + 'x' + rangeX);
        }
        return parts.join('|');
      }
      function sample() {
        var now = Date.now();
        var current = signature();
        if (current !== lastSignature) {
          lastSignature = current;
          lastChange = now;
        }
        if (now - lastChange >= stableMs) {
          resolve({ elapsedMs: now - start, settled: true });
          return;
        }
        if (now - start >= timeoutMs) {
          resolve({ elapsedMs: now - start, settled: false });
          return;
        }
        setTimeout(sample, sampleMs);
      }
      sample();
    })
  `)) as { elapsedMs: number; settled: boolean }
  if (!outcome.settled) {
    throw new Error(
      `waitForStableScrollGeometry: scroll ranges still changing after ${String(outcome.elapsedMs)}ms (needed ${String(stableMs)}ms unchanged)`,
    )
  }
  return outcome.elapsedMs
}

/**
 * Finds the element with the largest actual scroll range on `axis`, among
 * every `overflow: auto|scroll` element plus the document's own scrolling
 * element — instead of a hard-coded selector.
 *
 * A hard-coded `.MuiDataGrid-virtualScroller` selector was the root cause
 * of the dead-scroll-pass bug across several earlier rounds of this
 * benchmark: measured live, that element's own vertical range depends on
 * MUI's row-virtualization layout timing and was observed anywhere from 2px
 * (once its layout has settled — indistinguishable, to this benchmark, from
 * "there is genuinely nothing to scroll") to 500+px (right after a table
 * switch, before it settles) for the exact same table and viewport. The
 * element that actually carries the page's real scroll at 2560x1600 turned
 * out to be the *page's own* scroll container
 * (`main.flex-1.overflow-auto.min-w-0` in OnlyDash's current layout, not
 * hard-coded here either, since a future layout change would silently make
 * that selector wrong too) — this function measures ranges directly instead
 * of trusting either selector to still be the right one.
 */
async function findLargestScrollElement(
  page: Page,
  axis: 'x' | 'y',
): Promise<ElementHandle<Element>> {
  // A raw source string, not a compiled closure: `tsx`/esbuild injects a
  // `__name(fn, "range")` call for the named local function below (to
  // preserve `Function.prototype.name` across its own bundling), and that
  // helper does not exist in the standalone browser-side realm
  // `evaluateHandle` runs a closure's `toString()` in — see the identical
  // issue and fix in `src/paint-rate.ts`'s doc comment. `axis` is
  // interpolated directly (not passed as an `arg`) since Playwright's
  // string-expression form of `evaluate`/`evaluateHandle` does not thread
  // an `arg` through the way the closure form does; it is one of exactly
  // two literal values, never user input.
  const handle = await page.evaluateHandle(`
    (function () {
      var axis = ${JSON.stringify(axis)};
      function range(element) {
        return axis === 'y'
          ? element.scrollHeight - element.clientHeight
          : element.scrollWidth - element.clientWidth;
      }
      var best = document.scrollingElement || document.documentElement;
      var bestRange = range(best);
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var element = all[i];
        var style = getComputedStyle(element);
        var overflow = axis === 'y' ? style.overflowY : style.overflowX;
        if (overflow !== 'auto' && overflow !== 'scroll') continue;
        var elementRange = range(element);
        if (elementRange > bestRange) {
          bestRange = elementRange;
          best = element;
        }
      }
      return best;
    })();
  `)
  const element = handle.asElement()
  if (element === null) {
    throw new Error(
      `findLargestScrollElement: evaluateHandle did not return an Element for axis ${axis}`,
    )
  }
  return element
}

/** Measures a scrollable element's remaining range live, plus a short description for the run report. */
async function measureScrollable(
  element: ElementHandle<Element>,
  axis: 'x' | 'y',
): Promise<ScrollableMetrics & { description: string }> {
  return element.evaluate((node, axisArgument: 'x' | 'y') => {
    const classes = String(node.className).split(' ').slice(0, 2).join('.')
    return {
      current: axisArgument === 'y' ? node.scrollTop : node.scrollLeft,
      description: `${node.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`,
      range:
        axisArgument === 'y'
          ? node.scrollHeight - node.clientHeight
          : node.scrollWidth - node.clientWidth,
    }
  }, axis)
}

/**
 * Hit-tests every candidate wheel point against the live DOM in a single round
 * trip and reports, per point, whether a wheel delivered there would reach
 * `target`: the element painting at that point must be `target` or one of its
 * descendants, and no element between the two may itself be scrollable on
 * `axis`. "Scrollable" is decided exactly as `findLargestScrollElement` decides
 * it above — `overflow` on `auto`/`scroll` *and* a non-zero own range on that
 * axis — so a point is only rejected for an element that could really swallow
 * the gesture, not for every `overflow: auto` wrapper.
 *
 * A closure, not a raw source string, and with no named function anywhere
 * inside it: `tsx`/esbuild wraps *named* functions in an injected `__name(...)`
 * call that does not exist in the browser realm the payload's source text is
 * run in (see the doc comment on `findLargestScrollElement`, the same pattern
 * in `src/record.ts`'s `hitTestPoints`, and `tests/tsx-pipeline.test.ts`, which
 * is the guard against it). Inline arrow callbacks are anonymous and survive,
 * and the closure form is what threads `arg` through.
 */
async function probeWheelPoints(
  target: ElementHandle<Element>,
  axis: 'x' | 'y',
  points: readonly WheelPoint[],
): Promise<boolean[]> {
  const clear = await target.evaluate(
    (node, argument) =>
      argument.points.map((point) => {
        const hit = document.elementFromPoint(point.x, point.y)
        if (hit === null) return false
        if (hit !== node && !node.contains(hit)) return false
        let current: Element | null = hit
        while (current !== null && current !== node) {
          const style = getComputedStyle(current)
          const overflow =
            argument.axis === 'y' ? style.overflowY : style.overflowX
          const range =
            argument.axis === 'y'
              ? current.scrollHeight - current.clientHeight
              : current.scrollWidth - current.clientWidth
          if ((overflow === 'auto' || overflow === 'scroll') && range > 0) {
            return false
          }
          current = current.parentElement
        }
        return true
      }),
    { axis, points: points.map((point) => ({ x: point.x, y: point.y })) },
  )
  return clear as boolean[]
}

/**
 * Scrolls the element with the largest live scroll range on `axis` toward
 * one edge, through the merged `demo.scroll` wrapper (60Hz-paced,
 * `src/record.ts`) instead of a hand-rolled wheel loop: a hand-rolled
 * `await page.waitForTimeout(60)`-per-tick loop measured a 69.79ms median
 * interval on `grid-scroll-right` (1.9% of gaps <=20ms) — ~14fps of visible
 * motion, not smooth scrolling, because each tick paid the real cost of a
 * JS-side timer plus its own event-loop turnaround on top of the nominal
 * 60ms. `demo.scroll` paces against absolute deadlines and lets Chromium
 * coalesce delivery, and is already proven at 60Hz on a 105k-move sweep.
 *
 * Measures the live scrollable range first (not a fixed delta) and skips
 * (records no window) if it is below `MIN_MEANINGFUL_SCROLL_PX` — real
 * ranges for the sidebar (~26px) and most grids (~2-71px) at this viewport
 * are not worth claiming as motion. Otherwise records a motion window that
 * spans only the `demo.scroll` call and names the scrolled element, then
 * asserts that the position actually changed. Callers must have waited for
 * `waitForStableScrollGeometry` first, or the discovered element depends on
 * layout timing.
 *
 * The window carries the distance this pass was commanded to travel
 * (`travelPx` = |delta|) plus the scroll offsets before and after it
 * (`scrollStartPx`/`scrollEndPx`) — not just the element's full scroll
 * range. A pass only travels the full range when it starts at the opposite
 * edge, and `invoices:scroll-up` does not: the container sits ~85px below
 * `range` when that window opens, because the preceding pass left it there
 * (#47). Reporting `range` as the expected path therefore overstated it by
 * ~20% and made the path-length check in tools/smoothness fail a window
 * that had in fact moved exactly as far as it was told to (#31). Keeping
 * both offsets in the window means a future shortfall between them shows
 * up as a number instead of as a mystery.
 *
 * Where the pointer goes before the wheel starts is not cosmetic: Chromium
 * binds a wheel gesture to the element under the pointer, so the center of the
 * container — where OnlyDash's grid keeps its own 2px-range virtual scroller —
 * swallowed most of the commanded distance (#47, numbers in
 * `chooseWheelPoint`). The point is chosen by hit-testing candidates across the
 * target's visible area and taking the first that reaches the target with no
 * other scrollable element in between; if none does, this throws instead of
 * scrolling from a point that cannot work.
 *
 * Hovers the target with a single `boundingBox()` read and jump, not
 * `demo.point`'s verified-hit-test-and-settle machinery: `demo.point`'s
 * 80ms-stability window never closed within a 10s `settleTimeoutMs` against
 * a MUI grid's virtualized scroller, which keeps recalculating its own
 * geometry while scrolling — inflating the claimed motion window with
 * several seconds of static waiting *before* any real scrolling starts, the
 * exact frozen-motion-window problem this benchmark exists to avoid. The
 * cursor is not rendered into this capture (PLAN.md renders it later, from
 * `events.jsonl`), so an instant jump has no visual cost; only the actual
 * wheel pacing (`demo.scroll`, still 60Hz) needs to go through the wrapper.
 */
async function scrollContainerToEdge(
  windows: MotionWindow[],
  page: Page,
  demo: Demo,
  axis: 'x' | 'y',
  direction: 1 | -1,
  label: string,
): Promise<void> {
  // Discovery, measurement and pointer placement all happen before the
  // motion window opens: measured on the AI box, they took 30-50ms on a
  // settled page and 190-260ms while the grid was still growing, all of it
  // static time that a window wrapped around the whole pass counted as
  // "motion" (inflating its repeated-frame share and deflating its paint
  // rate). The window covers the scroll itself and nothing else.
  const target = await findLargestScrollElement(page, axis)
  const { current, description, range } = await measureScrollable(target, axis)
  const scrollTarget = direction > 0 ? range : 0
  const delta = scrollTarget - current
  if (Math.abs(delta) < MIN_MEANINGFUL_SCROLL_PX) {
    return
  }
  const box = await target.boundingBox()
  if (box === null) {
    throw new Error('scrollContainerToEdge: scroll target has no bounding box')
  }
  const point = await chooseWheelPoint(
    box,
    page.viewportSize(),
    (candidates) => probeWheelPoints(target, axis, candidates),
    { axis, description },
  )
  await page.mouse.move(point.x, point.y)
  const start = Date.now()
  await demo.scroll(axis === 'x' ? delta : 0, axis === 'y' ? delta : 0)
  const end = Date.now()

  // Measured after the window closed, so the read costs the window nothing.
  const after = await measureScrollable(target, axis)
  windows.push({
    end,
    label,
    scrollEndPx: after.current,
    scrollStartPx: current,
    start,
    target: `${description} (${axis} range ${String(range)}px)`,
    travelPx: Math.abs(delta),
  })

  if (after.current === current) {
    throw new Error(
      `scrollContainerToEdge: (${axis}) did not move despite a measured ${String(Math.abs(delta))}px range`,
    )
  }
}

/**
 * Runs `action` and records a `[start, end]` window (absolute
 * `Date.now()`-domain ms, the same clock `capture.ts` uses for
 * `session.startedAt`/`endedAt`) if it reports it produced motion.
 * `action` returning `void` counts as motion unconditionally (a click or
 * type always visibly changes something); returning `false` (as the
 * search-filter pass does) means no window is recorded. Scroll passes do not
 * go through here: `scrollContainerToEdge` records its own, narrower window
 * around the scroll alone.
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
async function waitForLoadingToClear(page: Frame | Page): Promise<void> {
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
  app: Frame | Page,
  url = ONLYDASH_GUEST_BENCHMARK_URL,
): Promise<void> {
  await app.goto(url, { waitUntil: 'domcontentloaded' })
  await app.getByRole('button', { name: 'Continue as Guest' }).click()
  // At a phone's width OnlyDash puts its sidebar behind a menu button, so
  // the Projects link the desktop flow clicks is present but not reachable.
  // Opening the menu first is the same journey a person on a phone makes.
  //
  // It is a question about the layout, not about the device — writing it as
  // `if (device.isMobile)` would put a fact about a layout in a place that
  // cannot see the layout. And it is a *wait*, not a bare visibility check,
  // because a check asked the instant after sign-in races the mount and
  // answers "no" on a phone too. The cost of the wait is up to five seconds
  // on a wide viewport, spent outside the capture, where it buys the
  // difference between a reliable warm-up and an occasional one.
  const menu = app.getByRole('button', { name: /toggle menu/i })
  const behindAMenu = await menu
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  if (behindAMenu) await menu.click()
  await app.getByRole('link', { exact: true, name: 'Projects' }).click()
  // The drawer does not close itself when a link inside it is followed: the
  // grid is behind it, present and hidden. Measured — without this the
  // warm-up waits out its timeout on a `role="grid"` that resolves 59 times
  // and is hidden every time. It is closed by its own close control rather
  // than by the button that opened it, because the open drawer covers that
  // button and intercepts the click.
  if (behindAMenu) {
    await app.locator('aside [data-testid="CloseIcon"]').first().click()
  }
  await app.getByRole('heading', { name: 'Projects', level: 1 }).waitFor()
  await app.getByRole('grid').waitFor()
  await waitForLoadingToClear(app)
  // Lets any remaining mount transition finish before the first frame is
  // captured. Not recorded, so a generous wait costs nothing.
  await app.waitForTimeout(600)
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
      // Also outside every motion window: the grid may still be growing
      // into its final height (see `SCROLL_GEOMETRY_STABLE_MS`), and no
      // scroll target is chosen until it has stopped.
      await waitForStableScrollGeometry(page)
      await scrollContainerToEdge(
        windows,
        page,
        demo,
        'y',
        1,
        `${title}:scroll-down:${String(cycle)}`,
      )
      await scrollContainerToEdge(
        windows,
        page,
        demo,
        'y',
        -1,
        `${title}:scroll-up:${String(cycle)}`,
      )
      await scrollContainerToEdge(
        windows,
        page,
        demo,
        'x',
        1,
        `${title}:scroll-right:${String(cycle)}`,
      )
      await scrollContainerToEdge(
        windows,
        page,
        demo,
        'x',
        -1,
        `${title}:scroll-left:${String(cycle)}`,
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
