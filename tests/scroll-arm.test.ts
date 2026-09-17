import { describe, expect, it } from 'vitest'

import {
  legacySlotDeltas,
  legacyWheelPackets,
  pacedTravelMs,
  pacedTravelSlots,
  packetSidewaysOver,
  pacedSideways,
  scrollArm,
  SIDEWAYS_PX,
  packetSideways,
} from '../demo/scroll-arm.js'
import {
  computeScrollPositions,
  DEFAULT_SCROLL_SPEED_PX_PER_SECOND,
  EVENT_LOG_FPS,
  MAX_SCROLL_STEP_PX,
} from '../src/record.js'
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
    await scrollArm(packetSideways)(unpaced.page, unpaced.demo)

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

  it('sends the packet arm as raw wheels, never through the wrapper', async () => {
    const { calls, demo, page } = recorder()
    await scrollArm(packetSideways)(page, demo)
    const wheels = calls.filter((call) => call.startsWith('wheel'))
    // One round trip per slot, of which eighteen carry pixels: see
    // `legacySlotDeltas` for why the empty ones are there.
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

describe('the two arms take the same time', () => {
  it('gives the legacy arm the shipped arm\u2019s slot count, not its own', () => {
    const deltas = legacySlotDeltas()
    expect(deltas).toHaveLength(pacedTravelSlots())
    expect(deltas.filter((delta) => delta !== 0)).toHaveLength(18)
  })

  it('reads the slot count out of the shipped planner rather than restating it', () => {
    // If the planner ever changes speed or grows its sample count to hold the
    // per-step cap, the legacy arm follows without anybody remembering to
    // edit a second number.
    expect(pacedTravelSlots()).toBe(
      computeScrollPositions(
        SIDEWAYS_PX,
        0,
        DEFAULT_SCROLL_SPEED_PX_PER_SECOND,
        EVENT_LOG_FPS,
      ).length,
    )
  })

  it('lands the last lump in the last slot, so both arms arrive together', () => {
    const deltas = legacySlotDeltas()
    expect(deltas.at(-1)).not.toBe(0)
  })

  it('spaces the lumps evenly through the slots', () => {
    const carrying = legacySlotDeltas()
      .map((delta, index) => (delta === 0 ? -1 : index))
      .filter((index) => index >= 0)
    const gaps = carrying.map((slot, index) =>
      index === 0 ? slot + 1 : slot - (carrying[index - 1] ?? 0),
    )
    for (const gap of gaps)
      expect(Math.abs(gap - (gaps[0] ?? 0))).toBeLessThanOrEqual(1)
  })

  it('still moves the whole distance, and still over the cap every lump', () => {
    // Holding the duration still must not quietly turn the left arm into the
    // right one: that would leave a comparison whose halves do the same thing.
    const deltas = legacySlotDeltas()
    expect(deltas.reduce((sum, delta) => sum + delta, 0)).toBeCloseTo(
      SIDEWAYS_PX,
      6,
    )
    for (const delta of deltas.filter((one) => one !== 0)) {
      expect(Math.abs(delta)).toBeGreaterThan(MAX_SCROLL_STEP_PX)
    }
  })

  it('sends only the lumps, and stretches them over the time it is given', async () => {
    const { calls, demo, page } = recorder()
    const started = Date.now()
    await scrollArm(packetSidewaysOver(1500))(page, demo)
    const elapsed = Date.now() - started
    expect(calls.filter((call) => call.startsWith('wheel'))).toHaveLength(18)
    expect(elapsed).toBeGreaterThanOrEqual(1500 * 0.9)
  })

  it('refuses a travel time that is not one', () => {
    expect(() => packetSidewaysOver(0)).toThrow(/positive travel time/)
    expect(() => packetSidewaysOver(Number.NaN)).toThrow(/positive travel time/)
  })

  it('refuses to spread packets that do not fit in the slots', () => {
    expect(() => legacySlotDeltas(700, 1)).toThrow(/do not fit in the/)
  })

  it('falls back to the planner\u2019s own travel time when given none', async () => {
    const { calls, demo, page } = recorder()
    const started = Date.now()
    await scrollArm(packetSideways)(page, demo)
    const elapsed = Date.now() - started
    expect(calls.filter((call) => call.startsWith('wheel'))).toHaveLength(18)
    expect(pacedTravelMs()).toBe((pacedTravelSlots() / EVENT_LOG_FPS) * 1000)
    // The holds in `scrollArm` are stubbed out, so the only time this can
    // have spent is the schedule's.
    expect(elapsed).toBeGreaterThanOrEqual(pacedTravelMs() * 0.9)
  })
})
