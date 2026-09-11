/**
 * Copyright (c) 2026 Ben Howdle
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
 * Derived from benhowdle89/matinee src/motion.ts at
 * e5c9608a36aa46b5815cc0eee117dc3114db5536. See THIRD-PARTY.md.
 */

export type MotionPoint = { x: number; y: number }

type Traits = {
  curvature: number
  curvatureJitter: number
  overshoot: number
  overshootMax: number
  tremor: number
}

type Path = {
  approach: MotionPoint
  c1: MotionPoint
  c2: MotionPoint
  distance: number
  p0: MotionPoint
  p3: MotionPoint
}

const CONFIDENT_TRAITS: Traits = {
  curvature: 0.12,
  curvatureJitter: 0.4,
  overshoot: 0.035,
  overshootMax: 22,
  tremor: 0.35,
}
const SETTLE_FRACTION = 0.26
const OVERSHOOT_RAMP_START = 0.55

/** M2's acceptance contract: no two consecutive pointer samples may differ by more. */
export const MAX_POINTER_STEP_PX = 20
// Deliberately not inflated: the analytic estimate below is only a starting
// guess (it ignores the settle window, the Bézier's non-uniform parametric
// speed, and rounding), but the guarantee loop that follows already corrects
// any shortfall by growing the sample count until the cap actually holds. A
// margin here would just add latency to every move for a guarantee the loop
// provides for free — see the property test in tests/motion.test.ts.
/** Safety valve for the growth loop; never expected to be hit in practice. */
const MAX_GROWTH_ITERATIONS = 100
/**
 * Sample-count growth factor used when a rendered curve still breaks the cap.
 * Deliberately gentle: a coarse factor overshoots the true minimum sample
 * count (verified during development: 1.3x landed ~27% above it on a 1500px
 * move), which directly inflates move duration for no benefit.
 */
const GROWTH_FACTOR = 1.08

/**
 * Generates deterministic, human-like pointer samples at the requested fps.
 * The 20px inter-sample cap (`MAX_POINTER_STEP_PX`) is a hard guarantee, not
 * a probability: the sample count starts at an analytic estimate and is then
 * deterministically grown — same seed, same distance, same result — until the
 * actually rendered, rounded curve satisfies it.
 */
export function generateMotionPoints(
  from: MotionPoint,
  to: MotionPoint,
  seed: number,
  fps: number,
): MotionPoint[] {
  const path = buildPath(from, to, CONFIDENT_TRAITS, createRng(seed))
  if (path.distance < 0.5) return []

  const phase = createRng(seed ^ 0x9e3779b9)() * Math.PI * 2
  const naturalSamples = Math.ceil((travelDuration(path.distance) / 1000) * fps)
  let samples = Math.max(
    1,
    naturalSamples,
    minimumJerkBoundSamples(path.distance),
  )
  let points = renderSamples(path, samples, phase, to)

  let guard = 0
  while (
    maxConsecutiveStep(points, from) > MAX_POINTER_STEP_PX &&
    guard < MAX_GROWTH_ITERATIONS
  ) {
    samples = Math.ceil(samples * GROWTH_FACTOR) + 1
    points = renderSamples(path, samples, phase, to)
    guard += 1
  }
  if (maxConsecutiveStep(points, from) > MAX_POINTER_STEP_PX) {
    throw new Error(
      `Unable to keep pointer motion under ${MAX_POINTER_STEP_PX}px per ` +
        `sample after ${String(guard)} growth iterations (distance ` +
        `${String(path.distance)}px, seed ${String(seed)})`,
    )
  }
  return points
}

function renderSamples(
  path: Path,
  samples: number,
  phase: number,
  to: MotionPoint,
): MotionPoint[] {
  const points: MotionPoint[] = []
  for (let index = 1; index <= samples; index += 1) {
    if (index === samples) {
      points.push({ ...to })
      continue
    }
    const point = sampleMotion(path, index / samples, CONFIDENT_TRAITS, phase)
    points.push({ x: Math.round(point.x), y: Math.round(point.y) })
  }
  return points
}

/**
 * Max step across the *whole* rendered sequence, including the seam from the
 * real starting point to the first generated sample. That seam is easy to
 * miss (an earlier version of this function started at index 1 and only
 * ever compared samples against each other) — the pointer's actual first
 * hop, from wherever it currently is, is just as real a jump as any two
 * samples later in the curve, and tremor has no fade-in near the start to
 * make it safe to skip.
 */
function maxConsecutiveStep(points: MotionPoint[], from: MotionPoint): number {
  let max = 0
  let previous = from
  for (const current of points) {
    const step = Math.hypot(current.x - previous.x, current.y - previous.y)
    if (step > max) max = step
    previous = current
  }
  return max
}

/**
 * Analytic lower bound on sample count: a minimum-jerk profile peaks at 1.875x
 * its *travel-window* average velocity, and travel only covers
 * (1 - SETTLE_FRACTION) of total progress (the rest is the overshoot
 * settle). So the peak real-world speed is
 * `1.875 * distance / (1 - SETTLE_FRACTION)` per unit of overall progress;
 * solve for the smallest sample count that keeps that under budget. This is
 * a starting estimate for the growth loop above, not the guarantee itself —
 * it still ignores overshoot/tremor/rounding, which the loop corrects for.
 */
function minimumJerkBoundSamples(distance: number): number {
  if (distance <= 0) return 1
  const peakSpeedPerProgress =
    (1.875 * distance) / (1 - SETTLE_FRACTION) / MAX_POINTER_STEP_PX
  return Math.ceil(peakSpeedPerProgress)
}

function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000
  }
}

function buildPath(
  from: MotionPoint,
  to: MotionPoint,
  traits: Traits,
  random: () => number,
): Path {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance < 0.5) {
    return {
      approach: { x: 0, y: 0 },
      c1: { ...from },
      c2: { ...to },
      distance: 0,
      p0: { ...from },
      p3: { ...to },
    }
  }

  const normal = { x: -dy / distance, y: dx / distance }
  const jitter = 1 + (random() * 2 - 1) * traits.curvatureJitter
  const bow =
    Math.min(distance * traits.curvature * jitter, 160) *
    (random() < 0.5 ? -1 : 1)
  const between = (min: number, max: number) => min + random() * (max - min)
  const c1 = {
    x: from.x + dx * between(0.2, 0.38) + normal.x * bow * between(0.7, 1.1),
    y: from.y + dy * between(0.2, 0.38) + normal.y * bow * between(0.7, 1.1),
  }
  const c2 = {
    x: from.x + dx * between(0.62, 0.82) + normal.x * bow * between(0.55, 1),
    y: from.y + dy * between(0.62, 0.82) + normal.y * bow * between(0.55, 1),
  }
  const approachLength = Math.hypot(to.x - c2.x, to.y - c2.y) || 1
  return {
    approach: {
      x: (to.x - c2.x) / approachLength,
      y: (to.y - c2.y) / approachLength,
    },
    c1,
    c2,
    distance,
    p0: { ...from },
    p3: { ...to },
  }
}

function sampleMotion(
  path: Path,
  progress: number,
  traits: Traits,
  phase: number,
): MotionPoint {
  const clamped = clamp01(progress)
  const travel = clamp01(clamped / (1 - SETTLE_FRACTION))
  const base = bezierAt(path, minimumJerk(travel))
  const overshoot =
    Math.min(path.distance * traits.overshoot, traits.overshootMax) *
    overshootEnvelope(clamped)
  const tremorFade = 1 - clamp01((clamped - 0.85) / 0.15)
  const tremor = tremorAt(clamped * 10, traits.tremor * tremorFade, phase)
  return {
    x: base.x + path.approach.x * overshoot + tremor.x,
    y: base.y + path.approach.y * overshoot + tremor.y,
  }
}

function minimumJerk(progress: number): number {
  const value = clamp01(progress)
  return value * value * value * (10 - 15 * value + 6 * value * value)
}

function overshootEnvelope(progress: number): number {
  const value = clamp01(progress)
  const handoff = 1 - SETTLE_FRACTION
  if (value <= handoff) {
    return minimumJerk(
      (value - OVERSHOOT_RAMP_START) / (handoff - OVERSHOOT_RAMP_START),
    )
  }
  return 1 - minimumJerk((value - handoff) / SETTLE_FRACTION)
}

function bezierAt(path: Path, progress: number): MotionPoint {
  const inverse = 1 - progress
  return {
    x:
      inverse ** 3 * path.p0.x +
      3 * inverse ** 2 * progress * path.c1.x +
      3 * inverse * progress ** 2 * path.c2.x +
      progress ** 3 * path.p3.x,
    y:
      inverse ** 3 * path.p0.y +
      3 * inverse ** 2 * progress * path.c1.y +
      3 * inverse * progress ** 2 * path.c2.y +
      progress ** 3 * path.p3.y,
  }
}

function tremorAt(time: number, amplitude: number, phase: number): MotionPoint {
  return {
    x:
      (Math.sin(time * 11.7 + phase) * 0.6 +
        Math.sin(time * 27.3 + phase * 1.7) * 0.4) *
      amplitude,
    y:
      (Math.sin(time * 13.1 + phase * 2.3) * 0.6 +
        Math.sin(time * 31.9 + phase) * 0.4) *
      amplitude,
  }
}

function travelDuration(distance: number): number {
  return clamp(160 + Math.sqrt(distance) * 24, 220, 1500)
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}
