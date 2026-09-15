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
 *
 * `gridStartY` is the vertical scroll offset the container already holds
 * when the first pass opens. It defaults to 0 (at the top edge, where
 * range and travelled distance coincide); a non-zero value reproduces what
 * the real `invoices` grid does — it sits ~85px away from the edge when a
 * pass starts, so that pass travels less than the full range (#47).
 *
 * `wheelBlocked` scripts the wheel-point probe: `'none'` clears every
 * candidate, `'inner'` reproduces what OnlyDash's grid actually does — its
 * own virtual scroller covers everything but the container's outer 40px, so
 * only points in that margin reach the container — and `'all'` leaves no
 * usable point at all. `viewport` shrinks the window around the fixed
 * 2000x800 container box, which is how a container reaching past the fold
 * gets reproduced.
 */
function createHarness(
  options: {
    gridRange?: number
    gridStartY?: number
    /** Whether the phone-width menu button is on screen. */
    menuVisible?: boolean
    viewport?: { height: number; width: number }
    wheelBlocked?: 'all' | 'inner' | 'none'
  } = {},
) {
  const gridRange = options.gridRange ?? 20
  const wheelBlocked = options.wheelBlocked ?? 'none'
  const viewport = options.viewport ?? { height: 1600, width: 2560 }
  const roleCalls: RoleCall[] = []
  const waitForTimeoutCalls: number[] = []
  let currentUrl =
    'https://app.onlydash.io/#/datasources/x/collections/projects'
  let gridCurrentX = 0
  let gridCurrentY = options.gridStartY ?? 0
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
  const wheelProbeBatches: {
    axis: 'x' | 'y'
    points: { x: number; y: number }[]
  }[] = []
  let navigatesOnClick = true
  const getByRole = vi
    .fn()
    .mockImplementation((role: string, options_?: { name?: string }) => {
      roleCalls.push({ name: options_?.name, role })
      // The menu button only exists at a phone's width, so waiting for it is
      // what fails on a wide viewport — which is exactly the branch the
      // warm-up reads.
      const isMenu = /menu/i.test(String(options_?.name))
      const present = !isMenu || (options.menuVisible ?? false)
      const roleLocator = {
        click: vi.fn().mockResolvedValue(undefined),
        first: () => roleLocator,
        waitFor: vi.fn().mockImplementation(async () => {
          if (!present) throw new Error('not visible')
        }),
      }
      return roleLocator
    })
  const getByText = vi.fn().mockReturnValue(loadingLocator)
  // `switchToTable` and the dark-mode/expand-owner/search-box clicks all go
  // through `page.locator(selector).click()` now (see m1-benchmark.ts's
  // doc comments on why they avoid `demo.click`'s travel cost), so this
  // mock has to branch on the selector to know which behavior to return.
  let drawerCloseClicks = 0
  const drawerCloseLocator = {
    click: vi.fn().mockImplementation(async () => {
      drawerCloseClicks += 1
    }),
    first: () => drawerCloseLocator,
  }
  const locator = vi.fn().mockImplementation((selector: string) => {
    if (selector.includes('CloseIcon')) return drawerCloseLocator
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
      .mockImplementation(
        async (
          _function_: unknown,
          argument:
            'x' | 'y' | { axis: 'x' | 'y'; points: { x: number; y: number }[] },
        ) => {
          // The handle carries two payloads now: `measureScrollable` passes a
          // bare axis, `probeWheelPoints` passes the candidate batch. The
          // wheel probe answers as the real DataGrid did in #47 — the grid's
          // own virtual scroller covers everything but the container's outer
          // 40px margin, so only points in that margin reach the container.
          if (typeof argument === 'object') {
            wheelProbeBatches.push({
              axis: argument.axis,
              points: argument.points,
            })
            return argument.points.map((point) => {
              if (wheelBlocked === 'all') return false
              if (wheelBlocked === 'none') return true
              return (
                point.x < 40 || point.x > 1960 || point.y < 40 || point.y > 760
              )
            })
          }
          const current = argument === 'x' ? gridCurrentX : gridCurrentY
          return { current, description: 'main.flex-1', range: gridRange }
        },
      ),
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
    viewportSize: () => viewport,
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
    /** Whether the warm-up used the drawer's own close control. */
    drawerClosed: () => drawerCloseClicks > 0,
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
    wheelProbeBatches,
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
    // It looks for the menu button on every viewport — but on a wide one it
    // is not there, and the warm-up carries on to the sidebar link instead of
    // failing. That is the branch this asserts: asked for, not required.
    const menuLookups = roleCalls.filter((call) =>
      /menu/i.test(String(call.name)),
    )
    expect(menuLookups).toHaveLength(1)
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

  it('delivers the wheel clear of the nested scroller, not at the container center', async () => {
    const { demo, page, wheelProbeBatches } = createHarness({
      gridRange: 600,
      wheelBlocked: 'inner',
    })

    await runOnlyDashMotion(page as never, demo)

    const moves = page.mouse.move.mock.calls as [number, number][]
    expect(moves.length).toBeGreaterThan(0)
    for (const [x, y] of moves) {
      // The center (1000, 400) sits on the grid's own virtual scroller,
      // which is where the commanded 454px became 91 (#47).
      expect([x, y]).not.toEqual([1000, 400])
      expect(x < 40 || x > 1960 || y < 40 || y > 760).toBe(true)
    }
    // Reachability: the center really was among the candidates the probe
    // was asked about, and really was rejected — so the assertions above
    // discriminate rather than passing vacuously.
    expect(wheelProbeBatches[0]?.points).toContainEqual({ x: 1000, y: 400 })
    expect(wheelProbeBatches[0]?.points.length).toBeGreaterThan(8)
    // The probe has to ask about the axis being driven: a horizontal pass
    // must not be cleared by a vertical-only reading of the same DOM.
    const axes = new Set(wheelProbeBatches.map((batch) => batch.axis))
    expect([...axes].sort()).toEqual(['x', 'y'])
  })

  it('keeps every candidate inside the window when the container runs past the fold', async () => {
    const { demo, page, wheelProbeBatches } = createHarness({
      gridRange: 600,
      viewport: { height: 600, width: 2560 },
    })

    await runOnlyDashMotion(page as never, demo)

    const probed = wheelProbeBatches.flatMap((batch) => batch.points)
    expect(probed.length).toBeGreaterThan(0)
    for (const point of probed) {
      expect(point.y).toBeLessThan(600)
    }
    // Reachability: the container is 800px tall, so without clipping the
    // bottom row of candidates would sit at y = 796 — below the fold,
    // where a wheel reaches nothing at all.
    expect(Math.max(...probed.map((point) => point.y))).toBeGreaterThan(500)
  })

  it('fails the run instead of scrolling from a point a nested scroller owns', async () => {
    const { demo, page } = createHarness({
      gridRange: 600,
      wheelBlocked: 'all',
    })

    await expect(runOnlyDashMotion(page as never, demo)).rejects.toThrow(
      /covered by another scrollable element/,
    )
    expect(demo.scroll).not.toHaveBeenCalled()
    expect(page.mouse.move).not.toHaveBeenCalled()
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

  it('records the distance a scroll pass travelled, not the container range', async () => {
    // The container starts 85px below the top edge, so the downward pass
    // covers 515 of the 600px range. Reporting 600 as its expected path is
    // exactly the 20% overstatement that made `invoices:scroll-up` fail the
    // path-length check in tools/smoothness while moving precisely as far
    // as it was told to (#31).
    const { demo, page } = createHarness({ gridRange: 600, gridStartY: 85 })

    const windows = await runOnlyDashMotion(page as never, demo)

    const down = windows.find(
      (window) => window.label === 'tasks:scroll-down:1',
    )
    expect(down).toBeDefined()
    expect(down?.travelPx).toBe(515)
    expect(down?.scrollStartPx).toBe(85)
    expect(down?.scrollEndPx).toBe(600)
    // Reachability: the two numbers really do differ in this scenario —
    // were they equal, the assertion above could not tell them apart.
    expect(down?.target).toContain('range 600px')
    expect(down?.travelPx).not.toBe(600)
  })

  it('keeps the before/after scroll offsets consistent with the travel it claims', async () => {
    const { demo, page } = createHarness({ gridRange: 600, gridStartY: 85 })

    const windows = await runOnlyDashMotion(page as never, demo)

    const scrollWindows = windows.filter((window) =>
      window.label.includes('scroll'),
    )
    expect(scrollWindows.length).toBeGreaterThan(0)
    for (const window of scrollWindows) {
      expect(typeof window.travelPx).toBe('number')
      expect(
        Math.abs(
          (window.scrollEndPx ?? Number.NaN) -
            (window.scrollStartPx ?? Number.NaN),
        ),
      ).toBe(window.travelPx)
    }
  })

  it('leaves non-scroll windows without a travel claim', async () => {
    // A click or a sort has no scroll path; claiming one would invent a
    // number the smoothness tool would then check against.
    const { demo, page } = createHarness({ gridRange: 600 })

    const windows = await runOnlyDashMotion(page as never, demo)

    const others = windows.filter((window) => !window.label.includes('scroll'))
    expect(others.length).toBeGreaterThan(0)
    for (const window of others) {
      expect(window.travelPx).toBeUndefined()
      expect(window.scrollStartPx).toBeUndefined()
      expect(window.scrollEndPx).toBeUndefined()
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
  it('opens the menu first when the sidebar is behind one, and closes it after', async () => {
    // At a phone's width OnlyDash hides its sidebar behind a menu button, so
    // the Projects link is present but not reachable — and following it does
    // not close the drawer, which then covers the grid the warm-up waits for.
    // Both facts are about the layout, not the device, which is why the
    // warm-up reads the button rather than a profile.
    const { drawerClosed, page, roleCalls } = createHarness({
      menuVisible: true,
    })

    await warmUpOnlyDash(page as never, 'https://app.onlydash.io/')

    const menuCall = roleCalls.findIndex((call) =>
      /menu/i.test(String(call.name)),
    )
    const projectsCall = roleCalls.findIndex(
      (call) => call.name === 'Projects' && call.role === 'link',
    )
    expect(menuCall).toBeGreaterThanOrEqual(0)
    expect(menuCall).toBeLessThan(projectsCall)
    expect(drawerClosed()).toBe(true)
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
