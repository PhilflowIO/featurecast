import { EVENT_LOG_FPS, type RecordEvent } from '../record.js'

/**
 * THE ADAPTER ISSUE #9 DELETES. THE MAPPING IT COMPUTES IS PROVISIONAL AND
 * KNOWN TO BE WRONG ON ANY RECORDING THAT WAITS FOR ANYTHING.
 *
 * `tick` in `events.jsonl` is a counted 60 Hz slot index, not a reading from
 * the same clock as the capture's frame timestamps. Everything that consumes
 * *planned* time increments it; everything that costs real but unplanned time
 * — `page.goto`, waiting for geometry to settle, a click's network round trip
 * — does not. So this module converts a count into milliseconds and hands the
 * renderer a time that is not the time.
 *
 * THE ERROR IS A STAIRCASE, NOT A RATE ERROR. That distinction is the whole
 * reason the two options below cannot fix it. Measured on the m1-008 recording,
 * with the true times of all twelve scroll deltas recovered by cross-
 * correlating per-frame scroll displacement against the logged deltas:
 *
 *     tick 358 (type)   log 5 967 ms   really  7 611 ms   +1.6 s
 *     tick 365          log 6 083 ms   really 33 476 ms   +27.4 s
 *     tick 577          log 9 617 ms   really 49 057 ms   +39.4 s
 *     tick 750          log 12 500 ms  really 55 142 ms   +42.6 s
 *
 * Inside one burst of planned actions the local error is 11-15%, which matches
 * what README.md reports. Between bursts the offset jumps in lumps — +25.8 s,
 * +3.2 s, +8.6 s, +2.9 s — wherever unlogged real work happens. A staircase is
 * not a slope: `rateScale` can only tilt the line, and `originMs` can only
 * shift it, so no pair of values for them is right for more than one step at a
 * time. Over 62 seconds of recording the accumulated offset reaches 42.6 s.
 *
 * What that costs, concretely: the one zoom this recording produces holds its
 * 1.333x framing from 4659 ms to 5559 ms of output, while the text that was
 * typed only appears at 6300 ms, by which time the crop is back to 1.004x. The
 * zoom frames an empty search box 1.64 s before anything happens in it and has
 * pulled out again before the change shows.
 *
 * DO NOT ADD A THIRD KNOB, and do not try to re-synchronise from the pictures.
 * Recovering the real timeline by correlating image content against the log is
 * exactly what issue #9 does properly, at the source; doing it here would be a
 * second bridge built to be torn down, inside the module that gets torn down.
 * If you find a better interim mapping, put it in #9, not here.
 *
 * Issue #9 replaces the counter with a real timestamp taken from the capture
 * clock. When it lands, this file is the only thing that has to go: everything
 * downstream of `toTimedEvents` already speaks milliseconds and nothing else,
 * so the replacement is `timeMs: event.timestamp` in one place instead of a
 * hunt for tick arithmetic spread through the renderer.
 *
 * Consequently: no other module under `src/render/` may read `tick`. The core
 * is a pure function over (events carrying a time in milliseconds, frame
 * timestamps in milliseconds).
 */

/** An event lifted onto the millisecond clock the renderer works in. */
export type TimedEvent<E extends RecordEvent = RecordEvent> = {
  event: E
  /** Milliseconds since the start of the recording session. */
  timeMs: number
}

/**
 * The two knobs — neither of which can correct the staircase above. They shift
 * and tilt a straight line; the error is a sequence of steps. They exist so a
 * caller can express what it knows about one specific recording, not because
 * any setting of them makes the mapping right.
 */
export type ClockOptions = {
  /**
   * Wall-clock milliseconds the log's tick 0 corresponds to, relative to the
   * capture session start. Defaults to 0 (log and capture start together).
   * Shifts the whole timeline; cannot fix a growing offset.
   */
  originMs?: number
  /**
   * Multiplier applied to tick-derived time. Tilts the whole timeline, so it
   * can absorb the 11-15% local rate error inside one burst of planned actions
   * and nothing else — the moment a second burst starts after unlogged real
   * work, whatever value was right for the first is wrong for the second. The
   * default of 1 makes no claim, which is the honest default while #9 is open.
   */
  rateScale?: number
}

/**
 * Converts one tick index to milliseconds on the log's own planned timebase.
 * Exported only so tests and the CLI can talk about the conversion by name.
 */
export function tickToMilliseconds(
  tick: number,
  fps: number = EVENT_LOG_FPS,
): number {
  if (!Number.isFinite(tick) || tick < 0) {
    throw new Error(`Event tick must be a non-negative number, got ${tick}`)
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Event log fps must be positive, got ${fps}`)
  }
  return (tick * 1000) / fps
}

/**
 * Lifts a parsed event log onto the millisecond clock. The header carries the
 * log's own fps, so a future log recorded at a different rate still converts
 * correctly; a log without a header falls back to the compiled-in 60 Hz.
 */
export function toTimedEvents(
  events: readonly RecordEvent[],
  options: ClockOptions = {},
): TimedEvent[] {
  const originMs = options.originMs ?? 0
  const rateScale = options.rateScale ?? 1
  if (!Number.isFinite(rateScale) || rateScale <= 0) {
    throw new Error(`Clock rateScale must be positive, got ${rateScale}`)
  }
  const header = events.find((event) => event.type === 'header')
  const fps = header?.fps ?? EVENT_LOG_FPS
  const timed: TimedEvent[] = []
  for (const event of events) {
    if (event.type === 'header') continue
    timed.push({
      event,
      timeMs: originMs + tickToMilliseconds(event.tick, fps) * rateScale,
    })
  }
  return timed
}
