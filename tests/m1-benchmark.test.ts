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

  // measureScrollable calls `evaluate(fn, { axis, selector })`;
  // assertTableIsDense calls `evaluate(fn)` with no second argument. The
  // presence of that argument is what distinguishes them here.
  const evaluate = vi
    .fn()
    .mockImplementation(
      async (_function_: unknown, argument?: { axis: 'x' | 'y' }) => {
        if (argument) {
          const current = argument.axis === 'x' ? gridCurrentX : gridCurrentY
          return { current, range: gridRange }
        }
        const title = currentUrl.split('/').pop() ?? ''
        return recordsByPath[title] ?? -1
      },
    )

  const page = {
    evaluate,
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
    demo,
    demoClick,
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
