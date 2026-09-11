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
 * Derived from pythonlearner1025/Screen-Studio-Effects src/auto-zoom.ts
 * (`detectSilenceZones`) at commit
 * bcaa05c2a39e7ccb4d747bba936f93f15350bc0a. See THIRD-PARTY.md.
 */

/** A pointer sample on the renderer's millisecond clock. */
export type PointerSample = { timeMs: number; x: number; y: number }

/** A stretch of time in which the pointer is effectively standing still. */
export type RestZone = { endMs: number; startMs: number }

export type RestOptions = {
  /** Shortest stretch that counts as rest rather than a pause between moves. */
  minRestMs?: number
  /** Displacement between neighbouring samples below which nothing happened. */
  thresholdPx?: number
}

/**
 * Finds the stretches where the pointer is at rest.
 *
 * Upstream hard-wires a 2px threshold and takes its timestamps in nanoseconds;
 * both are arguments here, and time is the millisecond clock the whole
 * renderer uses. The algorithm is unchanged: walk neighbouring samples, open a
 * zone when the step falls below the threshold, close it when it rises again,
 * and discard zones shorter than the minimum.
 */
export function detectRestZones(
  samples: readonly PointerSample[],
  options: RestOptions = {},
): RestZone[] {
  const thresholdPx = options.thresholdPx ?? 2
  const minRestMs = options.minRestMs ?? 400
  if (samples.length < 2) return []

  const zones: RestZone[] = []
  let restStart: number | null = null

  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index]
    const previous = samples[index - 1]
    if (current === undefined || previous === undefined) {
      throw new Error('unreachable: pointer sample index out of bounds')
    }
    const dx = current.x - previous.x
    const dy = current.y - previous.y
    const distance = Math.sqrt(dx * dx + dy * dy)

    if (distance < thresholdPx) {
      restStart ??= previous.timeMs
      continue
    }
    if (restStart !== null) {
      if (current.timeMs - restStart >= minRestMs) {
        zones.push({ startMs: restStart, endMs: current.timeMs })
      }
      restStart = null
    }
  }

  if (restStart !== null) {
    const last = samples[samples.length - 1]
    if (last !== undefined && last.timeMs - restStart >= minRestMs) {
      zones.push({ startMs: restStart, endMs: last.timeMs })
    }
  }

  return zones
}

/** The rest zone covering `timeMs`, or the first one starting right after it. */
export function restZoneAt(
  zones: readonly RestZone[],
  timeMs: number,
  toleranceMs = 0,
): RestZone | undefined {
  return zones.find(
    (zone) => zone.endMs > timeMs && zone.startMs <= timeMs + toleranceMs,
  )
}
