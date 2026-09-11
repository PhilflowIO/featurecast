import { EVENT_LOG_FPS, type RecordEvent } from '../record.js'

/**
 * THE ADAPTER ISSUE #9 DELETES.
 *
 * Today `tick` in `events.jsonl` is a counted 60 Hz slot index, not a reading
 * from the same clock as the capture's frame timestamps: everything that
 * consumes planned time increments it, and everything that costs real but
 * unplanned time (`page.goto`, geometry settling, a click's round trip) does
 * not. README.md documents the resulting drift as roughly +14-15% on an
 * ordinary script.
 *
 * Issue #9 replaces that counter with a real timestamp taken from the capture
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

export type ClockOptions = {
  /**
   * Wall-clock milliseconds the log's tick 0 corresponds to, relative to the
   * capture session start. Defaults to 0 (log and capture start together).
   */
  originMs?: number
  /**
   * Multiplier applied to tick-derived time. The event log's planned time runs
   * short of wall time by a script-dependent factor; a caller that has
   * measured that factor for its own recording can correct for it here. The
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
