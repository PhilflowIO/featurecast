import { describe, expect, it, vi } from 'vitest'

import { runOnlyDashBenchmark } from '../src/m1-benchmark.js'

type RoleCall = { name?: string; role: string }

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
  const page = {
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
    fill,
    page,
    pressSequentially,
    roleCalls,
    waitFor,
    waitForTimeoutCalls,
  }
}

describe('runOnlyDashBenchmark', () => {
  it('enters OnlyDash guest mode and reaches the Projects grid', async () => {
    const { click, page, roleCalls, waitFor } = createPage()

    await runOnlyDashBenchmark(page as never, 'https://app.onlydash.io/')

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
    expect(click).toHaveBeenCalled()
    expect(waitFor).toHaveBeenCalled()
  })

  it('scrolls continuously instead of jumping in one wheel event', async () => {
    const { page } = createPage()

    await runOnlyDashBenchmark(page as never)

    // Sidebar down, sidebar up, grid scroll right, grid scroll left:
    // 12 + 12 + 10 + 10.
    expect(page.mouse.wheel).toHaveBeenCalledTimes(44)
  })

  it('toggles dark mode and expands a related record', async () => {
    const { click, page, roleCalls } = createPage()

    await runOnlyDashBenchmark(page as never)

    expect(roleCalls).toContainEqual({
      name: 'Switch to dark mode',
      role: 'button',
    })
    expect(roleCalls).toContainEqual({ name: 'Expand Owner', role: 'button' })
    expect(click.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('searches and clears the filter without networkidle waits', async () => {
    const { fill, page, pressSequentially, roleCalls } = createPage()

    await runOnlyDashBenchmark(page as never)

    expect(roleCalls).toContainEqual({
      name: 'Search records',
      role: 'searchbox',
    })
    expect(pressSequentially).toHaveBeenCalledWith('Web', { delay: 120 })
    expect(fill).toHaveBeenCalledWith('')
  })

  it('paces the script to run for roughly M1s required 20 seconds', async () => {
    const { page, waitForTimeoutCalls } = createPage()

    await runOnlyDashBenchmark(page as never)

    const totalPausedMs = waitForTimeoutCalls.reduce(
      (total, ms) => total + ms,
      0,
    )
    expect(totalPausedMs).toBeGreaterThanOrEqual(20_000)
  })
})
