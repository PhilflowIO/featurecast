import { pointerTravelPx } from './cursor.js'
import type { PointerSample } from './rest.js'

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
 *
 * **The picture is not the whole truth, and the frame gap is not the unit.**
 * A page at rest while the pointer crosses it produces no new frames either, so
 * a long gap between two surviving frames can be a stretch in which nothing
 * happened *or* the stretch the pointer needed to get somewhere. Compressing
 * the second kind is what the owner watched and called a slideshow: 338px of
 * drawn pointer in one output frame, against the 20px the recorder guarantees
 * between two samples.
 *
 * Refusing any gap the pointer moves in would be the easy answer and the wrong
 * one. Measured on that recording, every gap over the threshold contains both:
 * one of them is 5.4 seconds long, and the pointer needs 2.0 of those to walk
 * its path — so "there is motion in here" would have trimmed nothing at all,
 * and a recording of a real application would never be shortened again.
 *
 * So the unit is the *intersection*: a stretch is trimmable where the picture
 * does not change **and** the pointer is standing still. The first comes from
 * the frame gaps, the second from the pointer path this module is handed. Both
 * are stretches of time; the answer is the overlap.
 *
 * **Stillness the script asked for is not idle.** A `demo.hold(ms)` is the
 * author asking for time on screen — a reading pause after an answer lands —
 * and it looks exactly like the waits trimming exists for: the picture holds,
 * the pointer rests. Neither signal can tell the two apart, but the event log
 * can, because it records every hold with its declared length. Those stretches
 * are handed in as `keptStretches` and taken out of every trimmable stretch
 * before anything is compressed. Only the declared length is kept: stillness
 * that runs past the end of a hold (the page still waiting for a network
 * answer, say) is idle again and trimmed like any other.
 *
 * Known limit, untested at runtime: the picture signal is byte-equality of
 * consecutive frames, and there is no floor under it. One changed pixel per frame — a
 * spinner in a corner, a blinking caret, a clock in the page — defeats the
 * capture's duplicate fold, every frame survives, no gap opens, and nothing is
 * ever trimmed on that page. The fix is a tolerance rather than equality, which
 * means measuring how much change is "nothing happened"; that measurement has
 * not been made, so the floor is deliberately absent rather than guessed.
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
  /**
   * How fast the drawn pointer may drift and still count as standing still, in
   * capture pixels per millisecond.
   *
   * Derived rather than chosen: one pixel per output frame at 60fps. Below it
   * the pointer does not visibly move between two frames, so the stretch is
   * still in the only sense a viewer can check. For comparison, the recorder's
   * own cap is 20px per sample, which is 1.2px/ms — twenty times this.
   *
   * It has to be a speed and not a distance. The log carries no samples at all
   * while a script holds, so the two samples bracketing a one-second pause sit
   * a full move's step apart; judged on distance that pause looks like motion,
   * and every long stillness bracketed by two moves would survive trimming.
   * Whether a scripted hold survives is decided explicitly instead, by
   * `keptStretches` — not as a side effect of this threshold.
   */
  pointerStillPxPerMs?: number
  /**
   * How fast the drawn pointer may move after compression, in capture pixels
   * per millisecond. The recorder's own cap, 20px between two samples at 60fps,
   * which is 1.2px/ms.
   *
   * Even a stretch that qualifies as still carries a little drift, and
   * compression multiplies it: squeezing eight seconds into 250ms is a factor
   * of 32, and drift the viewer could not see at recording speed becomes a jump
   * at playback speed. Measured, that alone still left 26px in one output frame
   * after the stillness rule was in place. So a stretch is held long enough for
   * whatever path it does contain, and `compressToMs` is a floor rather than
   * the answer.
   */
  maxPointerSpeedPxPerMs?: number
}

/** A stretch of recording time, in milliseconds since the session start. */
export type Stretch = { endMs: number; startMs: number }

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
  maxPointerSpeedPxPerMs: (20 * 60) / 1000,
  pointerStillPxPerMs: 60 / 1000,
  thresholdMs: 600,
}

/**
 * Builds the recording-time to output-time map.
 *
 * `frameTimesMs` are the capture's frame timestamps relative to the session
 * start, in order. `protectedTimesMs` are moments that must stay untouched.
 * `pointerSamples` is the path the drawn pointer takes, on the same clock: a
 * stretch the pointer moves through is not still, however unchanged the
 * picture is. `keptStretches` are stretches the script asked to be shown in
 * full — its `hold`s — and are never trimmed, whatever the other signals say.
 */
export function buildTimeMapping(
  frameTimesMs: readonly number[],
  sessionDurationMs: number,
  protectedTimesMs: readonly number[],
  pointerSamples: readonly PointerSample[],
  keptStretches: readonly Stretch[],
  options: IdleOptions = {},
): TimeMapping {
  const {
    compressToMs,
    maxPointerSpeedPxPerMs,
    protectMs,
    pointerStillPxPerMs,
    thresholdMs,
  } = {
    ...DEFAULT_IDLE,
    ...options,
  }
  if (compressToMs < 0 || thresholdMs <= 0) {
    throw new Error(
      'Idle trimming needs a positive threshold and a non-negative hold',
    )
  }

  const trimmed: Array<{ endMs: number; heldMs: number; startMs: number }> = []
  const protectedTimes = [...protectedTimesMs].sort((a, b) => a - b)
  const isProtected = (startMs: number, endMs: number): boolean =>
    protectedTimes.some(
      (time) => time >= startMs - protectMs && time <= endMs + protectMs,
    )

  const kept = mergeStretches(keptStretches)
  const stillPointer = pointerStillStretches(
    pointerSamples,
    sessionDurationMs,
    pointerStillPxPerMs,
  )
  const boundaries = [...frameTimesMs, sessionDurationMs]
  for (let index = 1; index < boundaries.length; index += 1) {
    const endMs = boundaries[index]
    const startMs = boundaries[index - 1]
    if (endMs === undefined || startMs === undefined) {
      throw new Error('unreachable: frame time index out of bounds')
    }
    if (endMs - startMs < thresholdMs) continue
    // The picture held still from `startMs` to `endMs`. Which parts of that did
    // the pointer hold still for too?
    for (const still of stillPointer) {
      const overlapFrom = Math.max(startMs, still.startMs)
      const overlapTo = Math.min(endMs, still.endMs)
      if (overlapTo - overlapFrom < thresholdMs) continue
      // What is left once the stretches the script asked for are taken out.
      for (const { startMs: from, endMs: to } of subtractStretches(
        overlapFrom,
        overlapTo,
        kept,
      )) {
        if (to - from < thresholdMs) continue
        if (isProtected(from, to)) continue
        // Long enough for the drift it does contain, and never shorter than
        // the compression floor.
        const travelPx = pointerTravelPx(pointerSamples, from, to)
        const heldMs = Math.min(
          to - from,
          Math.max(compressToMs, travelPx / maxPointerSpeedPxPerMs),
        )
        if (to - from - heldMs <= 0) continue
        trimmed.push({ startMs: from, endMs: to, heldMs })
      }
    }
  }

  const knots: Array<{ outputMs: number; sourceMs: number }> = [
    { sourceMs: 0, outputMs: 0 },
  ]
  let removedMs = 0
  for (const gap of trimmed) {
    knots.push({ sourceMs: gap.startMs, outputMs: gap.startMs - removedMs })
    removedMs += gap.endMs - gap.startMs - gap.heldMs
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

/**
 * The stretches in which the drawn pointer stands still.
 *
 * Walks the logged path and keeps every interval between two neighbouring
 * samples whose speed is below the threshold, merging neighbours so a pause
 * spanning several samples comes back as one stretch. The time before the first
 * sample and after the last one counts as still: the pointer is parked at the
 * ends of a recording, and a recording with no pointer at all is still
 * throughout, which is the honest answer rather than a fallback — nothing is
 * drawn, so nothing can jump.
 */
function pointerStillStretches(
  samples: readonly PointerSample[],
  sessionDurationMs: number,
  stillPxPerMs: number,
): Array<{ endMs: number; startMs: number }> {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first === undefined || last === undefined) {
    return [{ startMs: 0, endMs: sessionDurationMs }]
  }

  const stretches: Array<{ endMs: number; startMs: number }> = []
  const add = (startMs: number, endMs: number): void => {
    if (endMs <= startMs) return
    const previous = stretches[stretches.length - 1]
    if (previous !== undefined && previous.endMs >= startMs) {
      previous.endMs = Math.max(previous.endMs, endMs)
      return
    }
    stretches.push({ startMs, endMs })
  }

  add(0, first.timeMs)
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index]
    const previous = samples[index - 1]
    if (current === undefined || previous === undefined) {
      throw new Error('unreachable: pointer sample index out of bounds')
    }
    const spanMs = current.timeMs - previous.timeMs
    if (spanMs <= 0) continue
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y)
    if (distance / spanMs < stillPxPerMs) add(previous.timeMs, current.timeMs)
  }
  add(last.timeMs, sessionDurationMs)
  return stretches
}

/**
 * Sorts stretches and fuses the ones that touch or overlap, dropping empty
 * ones. Two holds written back to back are one pause to the viewer.
 */
function mergeStretches(stretches: readonly Stretch[]): Stretch[] {
  const sorted = stretches
    .filter((stretch) => stretch.endMs > stretch.startMs)
    .map((stretch) => ({ startMs: stretch.startMs, endMs: stretch.endMs }))
    .sort((a, b) => a.startMs - b.startMs)
  const merged: Stretch[] = []
  for (const stretch of sorted) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && previous.endMs >= stretch.startMs) {
      previous.endMs = Math.max(previous.endMs, stretch.endMs)
      continue
    }
    merged.push(stretch)
  }
  return merged
}

/**
 * `[startMs, endMs)` with every stretch in `holes` cut out, in order. `holes`
 * must be sorted and non-overlapping, as `mergeStretches` returns them.
 */
function subtractStretches(
  startMs: number,
  endMs: number,
  holes: readonly Stretch[],
): Stretch[] {
  const pieces: Stretch[] = []
  let cursor = startMs
  for (const hole of holes) {
    if (hole.endMs <= cursor) continue
    if (hole.startMs >= endMs) break
    if (hole.startMs > cursor)
      pieces.push({ startMs: cursor, endMs: hole.startMs })
    cursor = Math.max(cursor, hole.endMs)
    if (cursor >= endMs) break
  }
  if (cursor < endMs) pieces.push({ startMs: cursor, endMs })
  return pieces
}
