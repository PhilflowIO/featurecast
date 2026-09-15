import { describe, expect, it } from 'vitest'

import { tickToMilliseconds, toTimedEvents } from '../../src/render/clock.js'
import type { RecordEvent } from '../../src/record.js'

describe('tick to millisecond adapter', () => {
  it('reads 60 Hz slots as milliseconds', () => {
    expect(tickToMilliseconds(0)).toBe(0)
    expect(tickToMilliseconds(60)).toBe(1000)
    expect(tickToMilliseconds(30)).toBe(500)
  })

  it('rejects a negative or non-finite tick instead of producing a time', () => {
    expect(() => tickToMilliseconds(-1)).toThrow(/non-negative/)
    expect(() => tickToMilliseconds(Number.NaN)).toThrow(/non-negative/)
  })

  it('uses the log header frame rate, not a compiled-in constant', () => {
    const events: RecordEvent[] = [
      { type: 'header', version: 1, fps: 60, seed: 1 },
      { type: 'pointer', tick: 120, x: 1, y: 2 },
    ]
    expect(toTimedEvents(events)[0]?.timeMs).toBe(2000)
  })

  it('drops the header and offsets by the capture origin', () => {
    const events: RecordEvent[] = [
      { type: 'header', version: 1, fps: 60, seed: 1 },
      { type: 'pointer', tick: 60, x: 0, y: 0 },
    ]
    const timed = toTimedEvents(events, { originMs: 250 })
    expect(timed).toHaveLength(1)
    expect(timed[0]?.timeMs).toBe(1250)
  })

  it('scales the planned timebase when a measured drift is supplied', () => {
    const events: RecordEvent[] = [{ type: 'pointer', tick: 60, x: 0, y: 0 }]
    expect(toTimedEvents(events, { rateScale: 1.15 })[0]?.timeMs).toBeCloseTo(
      1150,
      9,
    )
    expect(() => toTimedEvents(events, { rateScale: 0 })).toThrow(/positive/)
  })
})
