import { describe, expect, it } from 'vitest'

import { planBands } from '../../src/render/bands.js'

const DEFAULTS = [
  { width: 1920, height: 1080 },
  { width: 900, height: 1600 },
  { width: 1080, height: 1080 },
]

function covered(plan: ReturnType<typeof planBands>, formats: number[]) {
  const rows = formats.map((height) => new Array<number>(height).fill(0))
  for (const thread of plan) {
    for (const band of thread) {
      for (let row = band.rowStart; row < band.rowEnd; row += 1) {
        const format = rows[band.format]
        if (format === undefined) throw new Error('unknown format')
        format[row] = (format[row] ?? 0) + 1
      }
    }
  }
  return rows
}

describe('cutting the frame work between threads', () => {
  for (const threads of [1, 2, 3, 5, 6, 8]) {
    it(`${String(threads)} threads: every row is done exactly once`, () => {
      const plan = planBands(DEFAULTS, threads)
      expect(plan).toHaveLength(threads)
      for (const format of covered(
        plan,
        DEFAULTS.map((output) => output.height),
      )) {
        expect(format.every((count) => count === 1)).toBe(true)
      }
    })
  }

  it('shares the work out by row width, not by row count', () => {
    // A 1920-wide landscape row is nearly twice the work of a 1080-wide square
    // one. Counting rows would hand one thread twice the frame and leave the
    // others waiting for it.
    const plan = planBands(DEFAULTS, 4)
    const weights = plan.map((thread) =>
      thread.reduce((sum, band) => {
        const width = DEFAULTS[band.format]?.width ?? 0
        return sum + (band.rowEnd - band.rowStart) * width
      }, 0),
    )
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    for (const weight of weights) {
      expect(Math.abs(weight - total / 4) / (total / 4)).toBeLessThan(0.02)
    }
  })

  it('is the same plan every time it is asked', () => {
    expect(planBands(DEFAULTS, 5)).toEqual(planBands(DEFAULTS, 5))
  })

  it('refuses a thread count that is not a thread count', () => {
    expect(() => planBands(DEFAULTS, 0)).toThrow(/positive/)
  })
})
