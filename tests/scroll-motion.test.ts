import { describe, expect, it } from 'vitest'

import {
  computeScrollPositions,
  DEFAULT_SCROLL_SPEED_PX_PER_SECOND,
  MAX_SCROLL_STEP_PX,
} from '../src/record.js'

/**
 * Mirrors `maxConsecutiveStep` in tests/motion.test.ts: includes the seam
 * from the scroll's own zero to the first generated sample, not just gaps
 * between samples.
 */
function maxConsecutiveScrollStep(
  positions: { x: number; y: number }[],
): number {
  let max = 0
  let previous = { x: 0, y: 0 }
  for (const current of positions) {
    const step = Math.hypot(current.x - previous.x, current.y - previous.y)
    if (step > max) max = step
    previous = current
  }
  return max
}

/**
 * P1 (issue #15) acceptance: a property test over many distances and
 * speeds proving `computeScrollPositions`'s hard per-step cap actually
 * holds on the rendered, rounded output — not just on the analytic
 * estimate — and that the total scrolled distance is always exact.
 */
describe('computeScrollPositions', () => {
  const distances: [number, number][] = [
    [0, 0],
    [1, 0],
    [0, 3],
    [10, 20],
    [120, 0],
    [0, 240],
    [300, -150],
    [-525, 0],
    [0, 525],
    [640, 480],
    [1600, 900],
    [-2000, 3000],
    [3717, -128],
    [7, 7],
    [33.5, 12.25],
  ]
  const speeds = [
    50,
    200,
    DEFAULT_SCROLL_SPEED_PX_PER_SECOND,
    900,
    2500,
    10_000,
  ]

  it('never exceeds the per-60Hz-step cap across distances and speeds', () => {
    let checked = 0
    for (const [deltaX, deltaY] of distances) {
      for (const speed of speeds) {
        const positions = computeScrollPositions(deltaX, deltaY, speed, 60)
        checked += 1
        expect(maxConsecutiveScrollStep(positions)).toBeLessThanOrEqual(
          MAX_SCROLL_STEP_PX,
        )
      }
    }
    expect(checked).toBe(distances.length * speeds.length)
  })

  it('always scrolls the exact requested distance, never a rounded approximation', () => {
    for (const [deltaX, deltaY] of distances) {
      for (const speed of speeds) {
        const positions = computeScrollPositions(deltaX, deltaY, speed, 60)
        const totalX = positions.reduce(
          (sum, position, index) =>
            sum + (position.x - (positions[index - 1]?.x ?? 0)),
          0,
        )
        const totalY = positions.reduce(
          (sum, position, index) =>
            sum + (position.y - (positions[index - 1]?.y ?? 0)),
          0,
        )
        expect(totalX).toBeCloseTo(deltaX, 9)
        expect(totalY).toBeCloseTo(deltaY, 9)
        // The final cumulative target is the exact requested delta, not a
        // rounded approximation of it.
        expect(positions.at(-1)).toEqual({ x: deltaX, y: deltaY })
      }
    }
  })

  it('is deterministic: the same inputs always render the same positions', () => {
    for (const [deltaX, deltaY] of distances) {
      for (const speed of speeds) {
        const first = computeScrollPositions(deltaX, deltaY, speed, 60)
        const second = computeScrollPositions(deltaX, deltaY, speed, 60)
        expect(second).toEqual(first)
      }
    }
  })

  it('regresses issue #15: a 525px scroll no longer collapses into ~14 giant jumps', () => {
    const positions = computeScrollPositions(
      0,
      525,
      DEFAULT_SCROLL_SPEED_PX_PER_SECOND,
      60,
    )
    // The old MAX_WHEEL_STEP_PX=40 packet-splitter produced
    // ceil(525/40) = 14 steps at ~37.5px each in 0.23s. The new
    // distance-over-time pacing at the default 700px/s must produce
    // meaningfully more, smaller steps over a realistic ~0.75s.
    expect(positions.length).toBeGreaterThan(14)
    expect(maxConsecutiveScrollStep(positions)).toBeLessThan(37.5)
  })
})
