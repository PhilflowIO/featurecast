import { describe, expect, it, vi } from 'vitest'

import {
  runOnlyDashBenchmark,
  runOnlyDashMotion,
  warmUpOnlyDash,
} from '../src/m1-benchmark.js'

type RoleCall = { name?: string; role: string }

// Scroll metrics are consumed in call order: nav-down, nav-up, grid-right,
// grid-left, matching the fixed sequence in runOnlyDashMotion.
const SCROLL_RESPONSES = [
  { current: 0, range: 900, x: 140, y: 400 },
  { current: 900, range: 900, x: 140, y: 400 },
  { current: 0, range: 1_100, x: 800, y: 300 },
  { current: 1_100, range: 1_100, x: 800, y: 300 },
]

function createPage() {
  const roleCalls: RoleCall[] = []
  const waitForTimeoutCalls: number[] = []
  const click = vi.fn().mockResolvedValue(undefined)
  const waitFor = vi.fn().mockResolvedValue(undefined)
  const fill = vi.fn().mockResolvedValue(undefined)
  const pressSequentially = vi.fn().mockResolvedValue(undefined)
  const locator = { click, fill, pressSequentially, waitFor }
  const getByRole = vi
    .fn()
    .mockImplementation((role: string, options?: { name?: string }) => {
      roleCalls.push({ name: options?.name, role })
      return { ...locator, first: () => locator }
    })
  let evaluateCallIndex = 0
  const evaluate = vi.fn().mockImplementation(async () => {
    const response =
      SCROLL_RESPONSES[evaluateCallIndex] ?? SCROLL_RESPONSES.at(-1)
    evaluateCallIndex += 1
    return response
  })
  const page = {
    evaluate,
    getByRole,
    goto: vi.fn().mockResolvedValue(undefined),
    mouse: {
      move: vi.fn().mockResolvedValue(undefined),
      wheel: vi.fn().mockResolvedValue(undefined),
    },
    waitForTimeout: vi.fn().mockImplementation(async (ms: number) => {
      waitForTimeoutCalls.push(ms)
    }),
  }
  return {
    click,
    evaluate,
    fill,
    page,
    pressSequentially,
    roleCalls,
    waitFor,
    waitForTimeoutCalls,
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
    // No scrolling or other motion belongs in the unrecorded warm-up.
    expect(page.mouse.wheel).not.toHaveBeenCalled()
  })
})

describe('runOnlyDashMotion', () => {
  it('measures the live scrollable range instead of assuming a fixed delta', async () => {
    const { page } = createPage()

    await runOnlyDashMotion(page as never)

    expect(page.evaluate).toHaveBeenCalledTimes(4)
    // Every wheel tick moves the mouse to the element's measured center
    // first, then scrolls a delta derived from range/steps — not a
    // hardcoded pixel constant.
    expect(page.mouse.move).toHaveBeenCalledWith(140, 400)
    expect(page.mouse.move).toHaveBeenCalledWith(800, 300)
  })

  it('keeps scrolling all the way to the end of each pass instead of sitting clamped', async () => {
    const { page } = createPage()

    await runOnlyDashMotion(page as never)

    // 4500ms / 60ms ticks ~= 75 ticks per pass, 4 passes (nav down/up, grid
    // right/left); a fixed-delta design that clamps early would issue the
    // same call count but most ticks would be visually inert. Here every
    // tick's delta is derived from measured range/steps, so none are.
    expect(page.mouse.wheel).toHaveBeenCalledTimes(75 * 4)
    const [firstWheelX, firstWheelY] = page.mouse.wheel.mock.calls[0] as [
      number,
      number,
    ]
    expect(Math.abs(firstWheelX) + Math.abs(firstWheelY)).toBeGreaterThan(0)
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

  it('spends the large majority of its scripted time on continuous scroll motion', async () => {
    const { page, waitForTimeoutCalls } = createPage()

    await runOnlyDashMotion(page as never)

    // waitForTimeoutCalls already contains every pause, including the 268
    // 60ms scroll ticks; isolate the non-scroll (settle) pauses by their
    // distinct duration to measure motion share.
    const totalMs = waitForTimeoutCalls.reduce((total, ms) => total + ms, 0)
    const staticWaits = waitForTimeoutCalls
      .filter((ms) => ms !== 60)
      .reduce((total, ms) => total + ms, 0)
    expect(totalMs).toBeGreaterThanOrEqual(20_000)
    // Static (non-scroll) pauses are the small remainder, not the bulk.
    expect(staticWaits / totalMs).toBeLessThan(0.15)
  })
})

describe('runOnlyDashBenchmark', () => {
  it('warms up before starting the recorded motion', async () => {
    const { page, roleCalls } = createPage()

    await runOnlyDashBenchmark(page as never, 'https://app.onlydash.io/')

    expect(page.goto).toHaveBeenCalledWith('https://app.onlydash.io/', {
      waitUntil: 'domcontentloaded',
    })
    expect(roleCalls).toContainEqual({
      name: 'Switch to dark mode',
      role: 'button',
    })
  })
})
