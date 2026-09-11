import { describe, expect, it, vi } from 'vitest'

import type { Demo } from '../src/record.js'

import {
  runOnlyDashBenchmark,
  runOnlyDashMotion,
  warmUpOnlyDash,
} from '../src/m1-benchmark.js'

type RoleCall = { name?: string; role: string }

/**
 * `gridRange` defaults to 20px, below the 200px meaningful-scroll floor —
 * matching what was actually measured live against OnlyDash's `expenses`
 * and `users` tables at the real 2560x1600 capture viewport (`users`:
 * 71px; `expenses`: 2px). Pass a larger value to simulate `tasks`
 * (528px) or `invoices` (369px).
 */
function createHarness(options: { gridRange?: number } = {}) {
  const gridRange = options.gridRange ?? 20
  const roleCalls: RoleCall[] = []
  const waitForTimeoutCalls: number[] = []
  let currentUrl =
    'https://app.onlydash.io/#/datasources/x/collections/projects'
  let gridCurrentX = 0
  let gridCurrentY = 0
  let recordsByPath: Record<string, number> = {
    expenses: 13,
    invoices: 17,
    tasks: 19,
    users: 13,
  }

  const loadingLocator = {
    first: () => loadingLocator,
    waitFor: vi.fn().mockRejectedValue(new Error('timed out')),
  }
  const genericLocator = {
    boundingBox: vi
      .fn()
      .mockResolvedValue({ height: 800, width: 2000, x: 0, y: 0 }),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
  }
  const tableLinkClick = vi.fn()
  let navigatesOnClick = true
  const getByRole = vi
    .fn()
    .mockImplementation((role: string, options_?: { name?: string }) => {
      roleCalls.push({ name: options_?.name, role })
      const roleLocator = {
        click: vi.fn().mockResolvedValue(undefined),
        first: () => roleLocator,
        waitFor: vi.fn().mockResolvedValue(undefined),
      }
      return roleLocator
    })
  const getByText = vi.fn().mockReturnValue(loadingLocator)
  // `switchToTable` and the dark-mode/expand-owner/search-box clicks all go
  // through `page.locator(selector).click()` now (see m1-benchmark.ts's
  // doc comments on why they avoid `demo.click`'s travel cost), so this
  // mock has to branch on the selector to know which behavior to return.
  const locator = vi.fn().mockImplementation((selector: string) => {
    const tableLinkMatch = /title="([^"]+)"/.exec(selector)
    if (tableLinkMatch) {
      return {
        click: vi.fn().mockImplementation(async () => {
          tableLinkClick(selector)
          if (navigatesOnClick) {
            currentUrl = `https://app.onlydash.io/#/datasources/x/collections/${tableLinkMatch[1]}`
          }
        }),
      }
    }
    return genericLocator
  })

  // assertTableIsDense is the only caller left of plain `page.evaluate(fn)`
  // (no arguments) — scroll-target discovery and measurement now go through
  // `evaluateHandle`/the returned handle's own `.evaluate()` below.
  // `waitForStableScrollGeometry` is the one caller that sends a raw source
  // string; it gets a settle outcome (scriptable via `setGeometrySettles`).
  let geometrySettles = true
  const callOrder: string[] = []
  const evaluate = vi.fn().mockImplementation(async (argument: unknown) => {
    if (typeof argument === 'string') {
      callOrder.push('settle')
      return { elapsedMs: 500, settled: geometrySettles }
    }
    const title = currentUrl.split('/').pop() ?? ''
    return recordsByPath[title] ?? -1
  })

  // `findLargestScrollElement` (page.evaluateHandle) returns a single fake
  // scroll-target handle regardless of axis, and that handle's own
  // `.evaluate(fn, axis)` (called by `measureScrollable`) reports
  // `gridCurrentX`/`gridCurrentY` against the fixed `gridRange` — the same
  // scriptable state the old direct `page.evaluate(fn, { axis })` mock used,
  // just reached through the handle now that the real code discovers a
  // scroll target instead of trusting a hard-coded selector.
  const scrollElementHandle = {
    asElement: () => scrollElementHandle,
    boundingBox: vi
      .fn()
      .mockResolvedValue({ height: 800, width: 2000, x: 0, y: 0 }),
    evaluate: vi
      .fn()
      .mockImplementation(async (_function_: unknown, axis: 'x' | 'y') => {
        const current = axis === 'x' ? gridCurrentX : gridCurrentY
        return { current, description: 'main.flex-1', range: gridRange }
      }),
  }
  const evaluateHandle = vi.fn().mockImplementation(async () => {
    callOrder.push('discover')
    return scrollElementHandle
  })

  const page = {
    evaluate,
    evaluateHandle,
    getByRole,
    getByText,
    goto: vi.fn().mockResolvedValue(undefined),
    locator,
    mouse: { move: vi.fn().mockResolvedValue(undefined) },
    url: () => currentUrl,
    waitForTimeout: vi.fn().mockImplementation(async (ms: number) => {
      waitForTimeoutCalls.push(ms)
    }),
  }

  const demoClick = vi.fn().mockImplementation(async (target: string) => {
    const match = /title="([^"]+)"/.exec(target)
    if (match) {
      currentUrl = `https://app.onlydash.io/#/datasources/x/collections/${match[1]}`
    }
  })
  const demoType = vi.fn().mockResolvedValue(undefined)
  const demoPoint = vi.fn().mockResolvedValue(undefined)
  const demoScroll = vi
    .fn()
    .mockImplementation(async (deltaX: number, deltaY: number) => {
      gridCurrentX += deltaX
      gridCurrentY += deltaY
    })
  const demo: Demo = {
    click: demoClick,
    hold: vi.fn().mockResolvedValue(undefined),
    point: demoPoint,
    scroll: demoScroll,
    tap: vi.fn().mockResolvedValue(undefined),
    type: demoType,
  }

  return {
    callOrder,
    demo,
    demoClick,
    setGeometrySettles: (settles: boolean) => {
      geometrySettles = settles
    },
    demoPoint,
    demoScroll,
    demoType,
    disableTableNavigation: () => {
      navigatesOnClick = false
    },
    page,
    roleCalls,
    setRecordsByPath: (next: Record<string, number>) => {
      recordsByPath = next
    },
    tableLinkClick,
    waitForTimeoutCalls,
  }
}

describe('warmUpOnlyDash', () => {
  it('signs into the guest sandbox and reaches the Projects grid, unrecorded', async () => {
    const { page, roleCalls } = createHarness()

    await warmUpOnlyDash(page as never, 'https://app.onlydash.io/')

    expect(page.goto).toHaveBeenCalledWith('https://app.onlydash.io/', {
      waitUntil: 'domcontentloaded',
    })
    expect(roleCalls).toContainEqual({
      name: 'Continue as Guest',
      role: 'button',
    })
    expect(roleCalls).toContainEqual({ name: 'Projects', role: 'link' })
    expect(roleCalls).toContainEqual({ name: 'Projects', role: 'heading' })
    expect(roleCalls).toContainEqual({ name: undefined, role: 'grid' })
  })
})

describe('runOnlyDashMotion', () => {
  it('drives typing and scroll pacing through the demo wrapper', async () => {
    const { demo, page } = createHarness({ gridRange: 600 })

    await runOnlyDashMotion(page as never, demo)

    // Clicks (table switches, dark mode, expand-owner) deliberately bypass
    // demo.click/demo.point — see their call sites' doc comments — because
    // demo's paced pointer travel is invisible in this capture and was
    // measured to dominate motion-window time with dead travel. The wheel
    // pacing (demo.scroll) and keystroke jitter (demo.type) have no such
    // cost and still go through the wrapper.
    expect(demo.scroll).toHaveBeenCalled()
    expect(demo.type).toHaveBeenCalled()
    expect(page.mouse.move).toHaveBeenCalled()
  })

  it('skips a scroll pass whose measured range is too small to move meaningfully', async () => {
    const { demo, page } = createHarness({ gridRange: 20 })

    const windows = await runOnlyDashMotion(page as never, demo)

    expect(demo.scroll).not.toHaveBeenCalled()
    expect(windows.some((window) => window.label.includes('scroll'))).toBe(
      false,
    )
  })

  it('scrolls and records a motion window when the range is actually meaningful', async () => {
    const { demo, page } = createHarness({ gridRange: 600 })

    const windows = await runOnlyDashMotion(page as never, demo)

    expect(demo.scroll).toHaveBeenCalled()
    expect(windows.some((window) => window.label.includes('scroll-down'))).toBe(
      true,
    )
  })

  it('waits for scroll geometry to settle before discovering any scroll target', async () => {
    const { callOrder, demo, page } = createHarness({ gridRange: 600 })

    await runOnlyDashMotion(page as never, demo)

    expect(callOrder[0]).toBe('settle')
    // Every table visit settles once, then discovers a target for each pass;
    // a discovery is never the first geometry read after a table switch.
    const settles = callOrder.filter((call) => call === 'settle').length
    expect(settles).toBe(8)
    for (const [index, call] of callOrder.entries()) {
      if (call === 'discover') {
        expect(callOrder.slice(0, index)).toContain('settle')
      }
    }
  })

  it('fails the run instead of choosing a scroll target on a layout that never settles', async () => {
    const { demo, page, setGeometrySettles } = createHarness({ gridRange: 600 })
    setGeometrySettles(false)

    await expect(runOnlyDashMotion(page as never, demo)).rejects.toThrow(
      'scroll ranges still changing',
    )
    expect(demo.scroll).not.toHaveBeenCalled()
  })

  it('names the scrolled element and opens each scroll window only after target discovery', async () => {
    const { demo, page } = createHarness({ gridRange: 600 })
    let clock = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 5))
    const discoveryTimes: number[] = []
    const discover = page.evaluateHandle
    page.evaluateHandle = vi
      .fn()
      .mockImplementation(async (...arguments_: unknown[]) => {
        discoveryTimes.push(Date.now())
        return discover(...arguments_)
      })
    try {
      const windows = await runOnlyDashMotion(page as never, demo)

      const scrollWindows = windows.filter((window) =>
        window.label.includes('scroll'),
      )
      expect(scrollWindows.length).toBeGreaterThan(0)
      for (const window of scrollWindows) {
        expect(window.target).toMatch(/^main\.flex-1 \((x|y) range 600px\)$/)
        const lastDiscovery = Math.max(
          ...discoveryTimes.filter((time) => time < window.end),
        )
        expect(window.start).toBeGreaterThan(lastDiscovery)
      }
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('only visits tables measured to hold at least the density floor', async () => {
    const { demo, page } = createHarness()

    const windows = await runOnlyDashMotion(page as never, demo)

    const tableWindows = windows.filter((window) =>
      window.label.startsWith('table:'),
    )
    expect(tableWindows.length).toBeGreaterThan(0)
    for (const window of tableWindows) {
      expect(
        ['tasks', 'invoices', 'users', 'expenses'].some((title) =>
          window.label.includes(title),
        ),
      ).toBe(true)
    }
  })

  it('throws if a selected table no longer meets the density floor', async () => {
    const { demo, page, setRecordsByPath } = createHarness()
    setRecordsByPath({ expenses: 1, invoices: 1, tasks: 1, users: 1 })

    await expect(runOnlyDashMotion(page as never, demo)).rejects.toThrow(
      'density floor',
    )
  })

  it('throws if a table click does not change the page URL', async () => {
    const { demo, disableTableNavigation, page } = createHarness()
    disableTableNavigation()

    await expect(runOnlyDashMotion(page as never, demo)).rejects.toThrow(
      'did not navigate',
    )
  })

  it('does not assert a motion window for the search filter', async () => {
    const { demo, page } = createHarness()

    const windows = await runOnlyDashMotion(page as never, demo)

    expect(demo.type).toHaveBeenCalled()
    expect(windows.some((window) => window.label === 'search-filter')).toBe(
      false,
    )
  })

  it('returns enough scripted time for M1s ~20s bar', async () => {
    const { demo, page, waitForTimeoutCalls } = createHarness({
      gridRange: 600,
    })

    await runOnlyDashMotion(page as never, demo)

    const totalMs = waitForTimeoutCalls.reduce((total, ms) => total + ms, 0)
    expect(totalMs).toBeGreaterThan(0)
  })
})

describe('runOnlyDashBenchmark', () => {
  it('warms up before starting the recorded motion', async () => {
    const { demo, page, roleCalls } = createHarness()

    const windows = await runOnlyDashBenchmark(
      page as never,
      demo,
      'https://app.onlydash.io/',
    )

    expect(page.goto).toHaveBeenCalledWith('https://app.onlydash.io/', {
      waitUntil: 'domcontentloaded',
    })
    expect(roleCalls).toContainEqual({ name: 'Projects', role: 'heading' })
    expect(windows.length).toBeGreaterThan(0)
  })
})
