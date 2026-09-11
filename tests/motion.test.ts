import { describe, expect, it } from 'vitest'

import { generateMotionPoints, MAX_POINTER_STEP_PX } from '../src/motion.js'

function maxConsecutiveStep(points: { x: number; y: number }[]): number {
  let max = 0
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    const step = Math.hypot(current.x - previous.x, current.y - previous.y)
    if (step > max) max = step
  }
  return max
}

/**
 * P1-1 hardening: the analytic sample-count estimate in motion.ts is only a
 * starting guess (it ignores the settle window, the Bézier's non-uniform
 * parametric speed, and rounding). This property test proves the actual
 * guarantee — a deterministic growth loop that keeps growing the sample
 * count until the rendered, rounded curve itself respects the cap — holds
 * across many seeds, distances, and both curated capture viewports, not just
 * the handful of cases spot-checked during development.
 */
describe('generateMotionPoints', () => {
  const viewports = [
    { height: 720, width: 1280 },
    { height: 1600, width: 2560 },
  ]
  const seeds = Array.from({ length: 200 }, (_, index) => index * 97 + 1)

  it('never exceeds the 20px inter-sample cap across seeds, distances, and viewports', () => {
    let checked = 0
    for (const viewport of viewports) {
      const corners: Array<{ x: number; y: number }> = [
        { x: 0, y: 0 },
        { x: viewport.width, y: 0 },
        { x: 0, y: viewport.height },
        { x: viewport.width, y: viewport.height },
        {
          x: Math.round(viewport.width / 2),
          y: Math.round(viewport.height / 2),
        },
      ]
      const shortMoves: Array<
        [{ x: number; y: number }, { x: number; y: number }]
      > = [
        [corners[4]!, { x: corners[4]!.x + 1, y: corners[4]!.y }],
        [corners[4]!, { x: corners[4]!.x + 3, y: corners[4]!.y + 2 }],
        [corners[4]!, { x: corners[4]!.x + 8, y: corners[4]!.y - 5 }],
      ]
      const longMoves: Array<
        [{ x: number; y: number }, { x: number; y: number }]
      > = [
        [corners[0]!, corners[3]!], // full diagonal, e.g. 2500px+
        [corners[1]!, corners[2]!], // the other diagonal
        [corners[0]!, corners[1]!], // full width
        [corners[0]!, corners[2]!], // full height
      ]

      for (const [from, to] of [...shortMoves, ...longMoves]) {
        for (const seed of seeds) {
          const points = generateMotionPoints(from, to, seed, 60)
          checked += 1
          expect(maxConsecutiveStep(points)).toBeLessThanOrEqual(
            MAX_POINTER_STEP_PX,
          )
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  it('is deterministic: the same seed and endpoints always render the same curve', () => {
    const from = { x: 12, y: 34 }
    const to = { x: 987, y: 654 }
    for (const seed of [0, 1, 42, 18032, 0xffffffff]) {
      const first = generateMotionPoints(from, to, seed, 60)
      const second = generateMotionPoints(from, to, seed, 60)
      expect(second).toEqual(first)
    }
  })

  it('reproduces the reported seed 18032 case within the cap', () => {
    const points = generateMotionPoints(
      { x: 0, y: 0 },
      { x: 400, y: 150 },
      18032,
      60,
    )
    expect(maxConsecutiveStep(points)).toBeLessThanOrEqual(MAX_POINTER_STEP_PX)
  })
})
