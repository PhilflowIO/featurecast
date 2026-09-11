/**
 * Copyright (c) 2025 Blitz
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Derived from pythonlearner1025/Screen-Studio-Effects src/spring.ts and the
 * `springEase`/`springEaseOut` pair in src/zoom.ts, at commit
 * bcaa05c2a39e7ccb4d747bba936f93f15350bc0a. See THIRD-PARTY.md.
 */

/**
 * A damped harmonic oscillator, described the way the upstream repo does:
 * `tension` is the spring stiffness k, `mass` the inertia m, `friction` the
 * damping c. Natural frequency is sqrt(k/m); damping ratio is c/(2*sqrt(k*m)).
 */
export type SpringConfig = {
  friction: number
  mass: number
  tension: number
}

/**
 * How far from critical damping a spring may sit before it is treated as
 * genuinely under- or overdamped. Both branches divide by terms that vanish at
 * zeta = 1, so the critically damped closed form covers a small band instead.
 */
const CRITICAL_EPSILON = 0.01

/**
 * Exact analytical solution of a 1D spring-mass-damper ODE.
 *
 * Given a displacement from the target and a velocity, returns
 * `[displacement, velocity]` after `t` seconds. This is a closed form, not an
 * integration step: evaluating it once at t = 1s and evaluating it sixty times
 * at t = 1/60s give the same answer, which is what makes every curve built on
 * it frame-rate independent and reproducible. That property is the whole
 * reason this file was adopted rather than written; do not replace it with an
 * Euler/RK4 loop.
 */
export function solveSpring1d(
  displacement: number,
  velocity: number,
  t: number,
  omega0: number,
  zeta: number,
): [number, number] {
  if (zeta < 1 - CRITICAL_EPSILON) {
    // Underdamped: oscillatory decay around the target.
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta)
    const decay = Math.exp(-zeta * omega0 * t)
    const cosT = Math.cos(omegaD * t)
    const sinT = Math.sin(omegaD * t)
    const a = displacement
    const b = (velocity + displacement * zeta * omega0) / Math.max(omegaD, 1e-4)
    return [
      decay * (a * cosT + b * sinT),
      decay *
        ((b * omegaD - a * zeta * omega0) * cosT -
          (a * omegaD + b * zeta * omega0) * sinT),
    ]
  }

  if (zeta > 1 + CRITICAL_EPSILON) {
    // Overdamped: two real exponential roots, no oscillation.
    const sq = Math.sqrt(zeta * zeta - 1)
    const s1 = -omega0 * (zeta - sq)
    const s2 = -omega0 * (zeta + sq)
    const denom = s1 - s2
    if (Math.abs(denom) < 1e-10) {
      const sAvg = 0.5 * (s1 + s2)
      const decay = Math.exp(sAvg * t)
      const rate = velocity - displacement * sAvg
      return [
        decay * (displacement + rate * t),
        decay * (rate + sAvg * (displacement + rate * t)),
      ]
    }
    const c1 = (velocity - displacement * s2) / denom
    const c2 = displacement - c1
    const e1 = Math.exp(s1 * t)
    const e2 = Math.exp(s2 * t)
    return [c1 * e1 + c2 * e2, c1 * s1 * e1 + c2 * s2 * e2]
  }

  // Critically damped: fastest settling without overshoot.
  const decay = Math.exp(-omega0 * t)
  const a = displacement
  const b = velocity + displacement * omega0
  return [decay * (a + b * t), decay * (b - omega0 * (a + b * t))]
}

/** Natural frequency and damping ratio of a spring configuration. */
export function springTerms(config: SpringConfig): {
  omega0: number
  zeta: number
} {
  const mass = Math.max(config.mass, 0.001)
  const tension = Math.max(config.tension, 1e-9)
  return {
    omega0: Math.sqrt(tension / mass),
    zeta: config.friction / (2 * Math.sqrt(tension * mass)),
  }
}

/**
 * Normalised spring easing: 0 at progress 0, approaching 1 as progress grows.
 *
 * Upstream hard-wires one stiffness/damping/mass triple into `springEase` and
 * a second, silently scaled copy of it into `springEaseOut` (`omega0 * 0.9`,
 * `zeta * 1.15`). Here the triple is an argument, so a look change is a
 * parameter and not an edit. Progress is a unitless 0..1 ratio, so the curve
 * itself carries no frame rate and no duration — the caller decides how much
 * wall time one unit of progress is worth.
 */
export function springEase(progress: number, config: SpringConfig): number {
  if (progress <= 0) return 0
  if (progress >= 1) return 1
  const { omega0, zeta } = springTerms(config)
  const [displacement] = solveSpring1d(-1, 0, progress, omega0, zeta)
  return 1 + displacement
}

/**
 * The softer counterpart used when a zoom releases back to the resting frame.
 * Upstream derives it from the entry spring by scaling frequency down and
 * damping up; the same derivation is kept, with both factors exposed.
 */
export function relaxSpring(
  config: SpringConfig,
  frequencyFactor = 0.9,
  dampingFactor = 1.15,
): SpringConfig {
  const { omega0, zeta } = springTerms(config)
  const omegaOut = omega0 * frequencyFactor
  const zetaOut = zeta * dampingFactor
  // Re-express the scaled (omega0, zeta) pair as a tension/mass/friction
  // triple so callers keep a single spring vocabulary. Mass is held fixed.
  const mass = Math.max(config.mass, 0.001)
  return {
    mass,
    tension: omegaOut * omegaOut * mass,
    friction: zetaOut * 2 * Math.sqrt(omegaOut * omegaOut * mass * mass),
  }
}
