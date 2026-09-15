import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  EVENT_LOG_FPS,
  type EventHeader,
  type RecordEvent,
} from '../../src/record.js'
import {
  parseEventLog,
  parseEventTimes,
  toTimedEvents,
  type TimedEvent,
} from '../../src/render/events.js'

/**
 * One recorded corpus log, on its own timeline.
 *
 * Two files, because the recorder writes two: the log, which is bit-identical
 * across runs of the same seed, and the times beside it, which are not. Both
 * are committed, and `toTimedEvents` refuses to pair them unless every tick
 * matches — so a fixture whose halves came from different runs fails loudly
 * instead of producing a plausible timeline.
 */
export function recordedFixture(name: string): TimedEvent[] {
  const directory = join(import.meta.dirname, 'fixtures')
  return toTimedEvents(
    parseEventLog(readFileSync(join(directory, `${name}.jsonl`), 'utf8')),
    parseEventTimes(
      readFileSync(join(directory, `${name}.times.jsonl`), 'utf8'),
    ),
  )
}

/**
 * Puts a hand-built event array on a millisecond timeline.
 *
 * This is **not** the adapter issue #9 deleted. That one converted a real
 * recording's `tick` counter into a claim about when things happened, and the
 * claim was wrong by up to 42 s, because the counter stands still through
 * every unplanned wait. Here there is no wait and no recording: the events are
 * invented by the test, and their ticks are the test saying "this many 60 Hz
 * slots later". Reading them at the slot rate is the definition, not an
 * estimate.
 *
 * A real recording's timeline comes from `recordedFixture`, never from this.
 */
export function atTicks(events: readonly RecordEvent[]): TimedEvent[] {
  return events
    .filter(
      (event): event is Exclude<RecordEvent, EventHeader> =>
        event.type !== 'header',
    )
    .map((event) => ({
      event,
      timeMs: (event.tick * 1000) / EVENT_LOG_FPS,
    }))
}
