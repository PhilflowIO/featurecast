import { describe, expect, it } from 'vitest'

import {
  relaxSpring,
  solveSpring1d,
  springEase,
  springTerms,
} from '../../src/render/spring.js'
import { DEFAULT_ZOOM_SPRING } from '../../src/render/zoom.js'

describe('analytic spring', () => {
  it('is frame-rate independent: one long step equals many short ones', () => {
    const { omega0, zeta } = springTerms(DEFAULT_ZOOM_SPRING)
    const direct = solveSpring1d(-1, 0, 0.5, omega0, zeta)

    let displacement = -1
    let velocity = 0
    const steps = 300
    for (let index = 0; index < steps; index += 1) {
      ;[displacement, velocity] = solveSpring1d(
        displacement,
        velocity,
        0.5 / steps,
        omega0,
        zeta,
      )
    }

    expect(displacement).toBeCloseTo(direct[0], 9)
    expect(velocity).toBeCloseTo(direct[1], 9)
  })

  it('starts at rest and lands exactly on the target', () => {
    expect(springEase(0, DEFAULT_ZOOM_SPRING)).toBe(0)
    expect(springEase(1, DEFAULT_ZOOM_SPRING)).toBe(1)
    expect(springEase(-5, DEFAULT_ZOOM_SPRING)).toBe(0)
    expect(springEase(42, DEFAULT_ZOOM_SPRING)).toBe(1)
  })

  it('creeps past the target only by a fraction of a thousandth', () => {
    // The default spring is underdamped, so it does go past its target before
    // the window closes. Measured peak: 1.000138 at progress 0.99965. That is
    // invisible, but it is not zero — which is why `cropAt` clamps the curve
    // rather than trusting its shape to keep the element inside the crop.
    let peak = 0
    for (let step = 0; step <= 10_000; step += 1) {
      const value = springEase(step / 10_000, DEFAULT_ZOOM_SPRING)
      expect(value).toBeGreaterThanOrEqual(0)
      peak = Math.max(peak, value)
    }
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThan(1.001)
  })

  it('rises monotonically until it reaches the target', () => {
    let previous = -1
    for (let step = 0; step <= 990; step += 1) {
      const value = springEase(step / 1000, DEFAULT_ZOOM_SPRING)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })

  it('relaxes into a slower, better damped spring', () => {
    const relaxed = relaxSpring(DEFAULT_ZOOM_SPRING)
    const original = springTerms(DEFAULT_ZOOM_SPRING)
    const derived = springTerms(relaxed)
    expect(derived.omega0).toBeCloseTo(original.omega0 * 0.9, 9)
    expect(derived.zeta).toBeCloseTo(original.zeta * 1.15, 9)
  })

  it('handles all three damping regimes without dividing by zero', () => {
    for (const friction of [1, 30, 40, 42.4, 200]) {
      const value = springEase(0.5, { friction, mass: 2.25, tension: 200 })
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})
