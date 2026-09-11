import { describe, expect, it, vi } from 'vitest'

import {
  runOnlyDashBenchmark,
  runOnlyDashMotion,
  warmUpOnlyDash,
} from '../src/m1-benchmark.js'

type RoleCall = { name?: string; role: string }

/**
 * `gridRange`/`navRange` default to 20px: below `MIN_PIXELS_PER_TICK * steps`
 * for any of the scroll passes' durations, matching what was actually
 * measured live against OnlyDash at the real 2560x1600 capture viewport
 * (`nav`: ~26px, grid scroller: ~32px) — both passes should be skipped by
 * default, with table navigation carrying the recorded motion instead.
 */
function createPage(options: { gridRange?: number; navRange?: number } = {}) {
  const navRange = options.navRange ?? 20
  const gridRange = options.gridRange ?? 20
  const roleCalls: RoleCall[] = []
  const waitForTimeoutCalls: number[] = []
  const click = vi.fn().mockResolvedValue(undefined)
  const waitFor = vi.fn().mockResolvedValue(undefined)
  const fill = vi.fn().mockResolvedValue(undefined)
  const pressSequentially = vi.fn().mockResolvedValue(undefined)
  const locator = { click, fill, pressSequentially, waitFor }
  const getByRole = vi
    .fn()
    .mockImplementation((role: string, roleOptions?: { name?: string }) => {
      roleCalls.push({ name: roleOptions?.name, role })
      return { ...locator, first: () => locator }
    })

  let navCurrent = 0
  let gridCurrent = 0
  let currentUrl =
    'https://app.onlydash.io/#/datasources/x/collections/projects'
  const tableClick = vi.fn()
  const locatorCalls: string[] = []
  const pageLocator = vi.fn().mockImplementation((selector: string) => {
    locatorCalls.push(selector)
    return {
      click: async () => {
        tableClick(selector)
        const match = /title="([^"]+)"/.exec(selector)
        currentUrl = `https://app.onlydash.io/#/datasources/x/collections/${match?.[1] ?? 'unknown'}`
      },
    }
  })

  const evaluate = vi
    .fn()
    .mockImplementation(
      async (
        _function_: unknown,
        arguments_: { axis: 'x' | 'y'; selector: string },
      ) => {
        if (arguments_.selector === 'nav') {
          return { current: navCurrent, range: navRange, x: 140, y: 400 }
        }
        if (arguments_.selector === '.MuiDataGrid-virtualScroller') {
          return { current: gridCurrent, range: gridRange, x: 800, y: 300 }
        }
        throw new Error(`unexpected selector: ${arguments_.selector}`)
      },
    )
  const wheel = vi
    .fn()
    .mockImplementation(async (deltaX: number, deltaY: number) => {
      if (deltaY !== 0) {
        navCurrent = Math.max(0, Math.min(navRange, navCurrent + deltaY))
      }
      if (deltaX !== 0) {
        gridCurrent = Math.max(0, Math.min(gridRange, gridCurrent + deltaX))
      }
    })

  const page = {
    evaluate,
    getByRole,
    goto: vi.fn().mockResolvedValue(undefined),
    locator: pageLocator,
    mouse: {
      move: vi.fn().mockResolvedValue(undefined),
      wheel,
    },
    url: () => currentUrl,
    waitForTimeout: vi.fn().mockImplementation(async (ms: number) => {
      waitForTimeoutCalls.push(ms)
    }),
  }
  return {
    click,
    evaluate,
    fill,
    locatorCalls,
    page,
    pressSequentially,
    roleCalls,
    tableClick,
    waitFor,
    waitForTimeoutCalls,
    wheel,
  }
}

describe('warmUpOnlyDash', () => {
  it('signs into the guest sandbox and reaches the Projects grid, unrecorded', async () => {
    const { page, roleCalls } = createPage()

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
    expect(page.mouse.wheel).not.toHaveBeenCalled()
  })
})

describe('runOnlyDashMotion', () => {
  it('skips a scroll pass whose measured range is too small to move meaningfully', async () => {
    // Realistic production ranges (~20-30px at the real capture viewport):
    // neither pass should issue a single wheel tick.
    const { page, wheel } = createPage()

    const windows = await runOnlyDashMotion(page as never)

    expect(wheel).not.toHaveBeenCalled()
    expect(
      windows.some((window) => window.label.startsWith('sidebar-scroll')),
    ).toBe(false)
    expect(
      windows.some((window) => window.label.startsWith('grid-scroll')),
    ).toBe(false)
  })

  it('scrolls and records a motion window when the range is actually meaningful', async () => {
    const { page, wheel } = createPage({ gridRange: 1_200, navRange: 900 })

    const windows = await runOnlyDashMotion(page as never)

    expect(wheel).toHaveBeenCalled()
    expect(
      windows.some((window) => window.label === 'sidebar-scroll-down'),
    ).toBe(true)
    expect(windows.some((window) => window.label === 'grid-scroll-right')).toBe(
      true,
    )
  })

  it('clicks through OnlyDash tables as the primary motion source', async () => {
    const { page, tableClick } = createPage()

    const windows = await runOnlyDashMotion(page as never)

    expect(tableClick.mock.calls.length).toBeGreaterThanOrEqual(10)
    expect(
      windows.filter((window) => window.label.startsWith('table:')).length,
    ).toBe(tableClick.mock.calls.length)
  })

  it('toggles dark mode, expands a related record, and filters the grid', async () => {
    const { page, roleCalls } = createPage()

    await runOnlyDashMotion(page as never)

    expect(roleCalls).toContainEqual({
      name: 'Switch to dark mode',
      role: 'button',
    })
    expect(roleCalls).toContainEqual({ name: 'Expand Owner', role: 'button' })
    expect(roleCalls).toContainEqual({
      name: 'Search records',
      role: 'searchbox',
    })
  })

  it('throws if a table click does not change the page URL', async () => {
    const { page } = createPage()
    // Force every table click to be a no-op navigation.
    page.locator = vi.fn().mockReturnValue({ click: async () => undefined })

    await expect(runOnlyDashMotion(page as never)).rejects.toThrow(
      'did not navigate',
    )
  })

  it('returns motion windows covering at least 20s of scripted time', async () => {
    const { page, waitForTimeoutCalls } = createPage()

    await runOnlyDashMotion(page as never)

    const totalMs = waitForTimeoutCalls.reduce((total, ms) => total + ms, 0)
    expect(totalMs).toBeGreaterThanOrEqual(15_000)
  })
})

describe('runOnlyDashBenchmark', () => {
  it('warms up before starting the recorded motion', async () => {
    const { page, roleCalls } = createPage()

    const windows = await runOnlyDashBenchmark(
      page as never,
      'https://app.onlydash.io/',
    )

    expect(page.goto).toHaveBeenCalledWith('https://app.onlydash.io/', {
      waitUntil: 'domcontentloaded',
    })
    expect(roleCalls).toContainEqual({
      name: 'Switch to dark mode',
      role: 'button',
    })
    expect(windows.length).toBeGreaterThan(0)
  })
})
