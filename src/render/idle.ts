/**
 * Idle trimming.
 *
 * The signal is the capture's own frame timestamps, not a motion estimate over
 * the pixels and emphatically not the browser's animation ticks: `captureScreencast`
 * already folds byte-identical consecutive frames into their predecessor's dwell
 * time (`droppedDuplicateFrameCount` in `src/capture.ts`), so a long gap between
 * two surviving frames *is* a stretch in which the picture did not change. A
 * rAF tick that repaints nothing produces no frame and therefore no gap of its
 * own — which is the trap this avoids.
 *
 * The result is a piecewise-linear, strictly monotonic map from recording time
 * to output time. Both the frames and the events are put through that one map,
 * so they cannot drift apart: there is only one clock, and trimming bends it
 * for everybody at once.
 */

export type IdleOptions = {
  /** A still stretch is kept, but only this long. */
  compressToMs?: number
  /** Stretches at least this long are candidates for trimming. */
  thresholdMs?: number
  /**
   * Moments that must not be trimmed near, in milliseconds — interactions,
   * typically. A still stretch within this distance of one is left alone so
   * the pause that lets a click land is not the thing that gets cut.
   */
  protectMs?: number
}

export type TimeMapping = {
  /** Strictly increasing pairs (recording ms, output ms). */
  knots: ReadonlyArray<{ outputMs: number; sourceMs: number }>
  /** Total output length in milliseconds. */
  outputDurationMs: number
  /** Milliseconds of stillness removed. */
  removedMs: number
  /** The trimmed stretches, in recording time. */
  trimmed: ReadonlyArray<{ endMs: number; startMs: number }>
}

export const DEFAULT_IDLE: Required<IdleOptions> = {
  compressToMs: 250,
  protectMs: 250,
  thresholdMs: 600,
}

/**
 * Builds the recording-time to output-time map.
 *
 * `frameTimesMs` are the capture's frame timestamps relative to the session
 * start, in order. `protectedTimesMs` are moments that must stay untouched.
 */
export function buildTimeMapping(
  frameTimesMs: readonly number[],
  sessionDurationMs: number,
  protectedTimesMs: readonly number[] = [],
  options: IdleOptions = {},
): TimeMapping {
  const { compressToMs, protectMs, thresholdMs } = {
    ...DEFAULT_IDLE,
    ...options,
  }
  if (compressToMs < 0 || thresholdMs <= 0) {
    throw new Error(
      'Idle trimming needs a positive threshold and a non-negative hold',
    )
  }

  const trimmed: Array<{ endMs: number; startMs: number }> = []
  const protectedTimes = [...protectedTimesMs].sort((a, b) => a - b)
  const isProtected = (startMs: number, endMs: number): boolean =>
    protectedTimes.some(
      (time) => time >= startMs - protectMs && time <= endMs + protectMs,
    )

  const boundaries = [...frameTimesMs, sessionDurationMs]
  for (let index = 1; index < boundaries.length; index += 1) {
    const endMs = boundaries[index]
    const startMs = boundaries[index - 1]
    if (endMs === undefined || startMs === undefined) {
      throw new Error('unreachable: frame time index out of bounds')
    }
    if (endMs - startMs < thresholdMs) continue
    if (isProtected(startMs, endMs)) continue
    trimmed.push({ startMs, endMs })
  }

  const knots: Array<{ outputMs: number; sourceMs: number }> = [
    { sourceMs: 0, outputMs: 0 },
  ]
  let removedMs = 0
  for (const gap of trimmed) {
    const held = Math.min(compressToMs, gap.endMs - gap.startMs)
    knots.push({ sourceMs: gap.startMs, outputMs: gap.startMs - removedMs })
    removedMs += gap.endMs - gap.startMs - held
    knots.push({ sourceMs: gap.endMs, outputMs: gap.endMs - removedMs })
  }
  knots.push({
    sourceMs: sessionDurationMs,
    outputMs: sessionDurationMs - removedMs,
  })

  return {
    knots,
    outputDurationMs: sessionDurationMs - removedMs,
    removedMs,
    trimmed,
  }
}

/** Maps one recording-time moment onto the output timeline. */
export function mapTime(mapping: TimeMapping, sourceMs: number): number {
  const { knots } = mapping
  const first = knots[0]
  const last = knots[knots.length - 1]
  if (first === undefined || last === undefined) {
    throw new Error('unreachable: a time mapping always has knots')
  }
  if (sourceMs <= first.sourceMs) return first.outputMs
  if (sourceMs >= last.sourceMs) {
    return last.outputMs + (sourceMs - last.sourceMs)
  }
  for (let index = 1; index < knots.length; index += 1) {
    const right = knots[index]
    const left = knots[index - 1]
    if (right === undefined || left === undefined) {
      throw new Error('unreachable: knot index out of bounds')
    }
    if (sourceMs > right.sourceMs) continue
    const span = right.sourceMs - left.sourceMs
    if (span <= 0) return right.outputMs
    const t = (sourceMs - left.sourceMs) / span
    return left.outputMs + (right.outputMs - left.outputMs) * t
  }
  return last.outputMs
}
