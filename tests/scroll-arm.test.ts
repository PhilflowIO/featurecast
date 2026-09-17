import { describe, expect, it } from 'vitest'

import {
  legacyWheelPackets,
  pacedSideways,
  scrollArm,
  SIDEWAYS_PX,
  unpacedSideways,
} from '../demo/scroll-arm.js'
import { MAX_SCROLL_STEP_PX } from '../src/record.js'
import type { Demo, RecordPage } from '../src/record.js'

/**
 * A page and a wrapper that record what was asked of them and do nothing.
 *
 * The question these tests answer is not "did the grid move" — a browser
 * answers that, and `tests/record.browser.test.ts` already asks it. It is
 * whether the two arms are different *procedures*, because a comparison whose
 * two halves secretly do the same thing is a lie told with a straight face.
 */
function recorder(): {
  calls: string[]
  demo: Demo
  page: RecordPage
} {
  const calls: string[] = []
  const page = {
    mouse: {
      wheel: async (deltaX: number, deltaY: number) => {
        calls.push(`wheel ${deltaX.toFixed(2)},${deltaY.toFixed(2)}`)
        return Promise.resolve()
      },
    },
  } as unknown as RecordPage
  const demo = {
    hold: async (milliseconds: number) => {
      calls.push(`hold ${String(milliseconds)}`)
      return Promise.resolve()
    },
    point: async (target: unknown) => {
      calls.push(`point ${String(target)}`)
      return Promise.resolve()
    },
    scroll: async (deltaX: number, deltaY: number) => {
      calls.push(`scroll ${String(deltaX)},${String(deltaY)}`)
      return Promise.resolve()
    },
  } as unknown as Demo
  return { calls, demo, page }
}

describe('the two scroll arms', () => {
  it('differ only in how the sideways travel is delivered', async () => {
    const paced = recorder()
    const unpaced = recorder()
    await scrollArm(pacedSideways)(paced.page, paced.demo)
    await scrollArm(unpacedSideways)(unpaced.page, unpaced.demo)

    const shared = (calls: string[]): string[] =>
      calls.filter(
        (call) => !call.startsWith('scroll') && !call.startsWith('wheel'),
      )
    // Same page, same pointer travel, same holds — everything but the scroll.
    expect(shared(paced.calls)).toEqual(shared(unpaced.calls))
    expect(shared(paced.calls)).toEqual([
      'hold 400',
      'point #gridscroller',
      'hold 1400',
    ])
  })

  it('sends the paced arm through the wrapper, which owns the cadence', async () => {
    const { calls, demo, page } = recorder()
    await scrollArm(pacedSideways)(page, demo)
    expect(calls).toContain(`scroll ${String(SIDEWAYS_PX)},0`)
    // Not one raw wheel: the moment this arm reaches past the wrapper it stops
    // being the thing the right-hand caption claims it is.
    expect(calls.filter((call) => call.startsWith('wheel'))).toEqual([])
  })

  it('sends the unpaced arm as raw packets, never through the wrapper', async () => {
    const { calls, demo, page } = recorder()
    await scrollArm(unpacedSideways)(page, demo)
    const wheels = calls.filter((call) => call.startsWith('wheel'))
    expect(wheels).toHaveLength(18)
    expect(calls.filter((call) => call.startsWith('scroll'))).toEqual([])
  })

  it('moves the whole distance either way, so only the delivery differs', () => {
    const packets = legacyWheelPackets(SIDEWAYS_PX)
    const total = packets.reduce((sum, packet) => sum + packet, 0)
    expect(total).toBeCloseTo(SIDEWAYS_PX, 6)
  })

  it('is a procedure the shipped one refuses: every packet is over the cap', () => {
    // This is the whole claim of the comparison, stated as a number. The
    // shipped path may not put more than MAX_SCROLL_STEP_PX on screen between
    // two frames; the removed one puts 38.9 px in every packet and sends all
    // eighteen as fast as they will go.
    for (const packet of legacyWheelPackets(SIDEWAYS_PX)) {
      expect(Math.abs(packet)).toBeGreaterThan(MAX_SCROLL_STEP_PX)
    }
    expect(legacyWheelPackets(525)).toHaveLength(14)
  })

  it('refuses a packet size that carries nothing', () => {
    expect(() => legacyWheelPackets(700, 0)).toThrow(/has to carry something/)
  })
})
