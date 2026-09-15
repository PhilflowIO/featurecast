import type { BoundingBox, EventHeader, RecordEvent } from '../record.js'

const EVENT_TYPES = new Set([
  'header',
  'pointer',
  'click',
  'tap',
  'hold',
  'scroll',
  'type',
])

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readBoundingBox(value: unknown, line: number): BoundingBox {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`events.jsonl line ${line}: bbox must be an object`)
  }
  const box = value as Record<string, unknown>
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!isFiniteNumber(box[key])) {
      throw new Error(`events.jsonl line ${line}: bbox.${key} must be a number`)
    }
  }
  return {
    x: box['x'] as number,
    y: box['y'] as number,
    width: box['width'] as number,
    height: box['height'] as number,
  }
}

/**
 * Reads one `events.jsonl` line into the v1 vocabulary defined in
 * `src/record.ts`. Unknown event types are a hard error rather than a skip: a
 * renderer that silently ignores an event it does not understand produces a
 * video that quietly omits something the script did.
 */
export function parseEventLine(text: string, line: number): RecordEvent {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`events.jsonl line ${line}: not valid JSON`)
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`events.jsonl line ${line}: expected an object`)
  }
  const raw = value as Record<string, unknown>
  const type = raw['type']
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) {
    throw new Error(
      `events.jsonl line ${line}: unknown event type ${String(type)}`,
    )
  }
  if (type === 'header') {
    if (raw['version'] !== 1) {
      throw new Error(
        `events.jsonl line ${line}: unsupported log version ${String(raw['version'])}`,
      )
    }
    if (!isFiniteNumber(raw['fps']) || !isFiniteNumber(raw['seed'])) {
      throw new Error(
        `events.jsonl line ${line}: header needs numeric fps and seed`,
      )
    }
    return {
      type: 'header',
      version: 1,
      fps: raw['fps'] as 60,
      seed: raw['seed'],
    }
  }
  if (!isFiniteNumber(raw['tick'])) {
    throw new Error(`events.jsonl line ${line}: tick must be a number`)
  }
  const tick = raw['tick']
  switch (type) {
    case 'pointer': {
      if (!isFiniteNumber(raw['x']) || !isFiniteNumber(raw['y'])) {
        throw new Error(
          `events.jsonl line ${line}: pointer needs numeric x and y`,
        )
      }
      return { type, tick, x: raw['x'], y: raw['y'] }
    }
    case 'click':
    case 'tap': {
      if (!isFiniteNumber(raw['x']) || !isFiniteNumber(raw['y'])) {
        throw new Error(
          `events.jsonl line ${line}: ${type} needs numeric x and y`,
        )
      }
      return {
        type,
        tick,
        x: raw['x'],
        y: raw['y'],
        bbox: readBoundingBox(raw['bbox'], line),
      }
    }
    case 'hold': {
      if (!isFiniteNumber(raw['milliseconds'])) {
        throw new Error(
          `events.jsonl line ${line}: hold needs numeric milliseconds`,
        )
      }
      return { type, tick, milliseconds: raw['milliseconds'] }
    }
    case 'scroll': {
      if (!isFiniteNumber(raw['deltaX']) || !isFiniteNumber(raw['deltaY'])) {
        throw new Error(
          `events.jsonl line ${line}: scroll needs numeric deltas`,
        )
      }
      return { type, tick, deltaX: raw['deltaX'], deltaY: raw['deltaY'] }
    }
    default: {
      if (typeof raw['text'] !== 'string') {
        throw new Error(`events.jsonl line ${line}: type event needs text`)
      }
      return {
        type: 'type',
        tick,
        text: raw['text'],
        bbox: readBoundingBox(raw['bbox'], line),
      }
    }
  }
}

/** Parses a whole `events.jsonl` document. Blank lines are tolerated. */
export function parseEventLog(contents: string): RecordEvent[] {
  const events: RecordEvent[] = []
  const lines = contents.split('\n')
  for (const [index, text] of lines.entries()) {
    if (text.trim() === '') continue
    events.push(parseEventLine(text, index + 1))
  }
  return events
}

/**
 * The event log's own clock.
 *
 * Until issue #9 this module's companion, `src/render/clock.ts`, converted the
 * log's `tick` counter into milliseconds and handed the renderer a time that
 * was not the time: `tick` counts *planned* 60 Hz slots, so it stands still
 * through a page load, a settle wait or a click's network round trip. Measured
 * on one acceptance recording the log claimed 14.7 s for a capture that took
 * 20.7 s, and the error was a staircase rather than a rate, so no scale factor
 * could have absorbed it.
 *
 * The recorder now reads the wall clock when it writes each event
 * (`event-times.jsonl`, written beside the log by `src/record.ts`), and that is
 * the same clock `src/capture.ts` stamps `session.startedAt` and every frame
 * with. Frames and events are therefore on one timeline by construction, and
 * there is nothing left to convert.
 */

/** An event lifted onto the millisecond clock the renderer works in. */
export type TimedEvent<E extends RecordEvent = RecordEvent> = {
  event: E
  /** Milliseconds since the start of the recording session. */
  timeMs: number
}

/** A parsed `event-times.jsonl`: when the log started, and every reading. */
export type EventTimes = {
  /** Epoch milliseconds of the first reading. */
  startedAt: number
  entries: ReadonlyArray<{ ms: number; tick: number }>
}

/** Parses a whole `event-times.jsonl` document. Blank lines are tolerated. */
export function parseEventTimes(contents: string): EventTimes {
  const lines = contents.split('\n').filter((text) => text.trim() !== '')
  const headerText = lines[0]
  if (headerText === undefined) {
    throw new Error('event-times.jsonl is empty: it must carry a header')
  }
  const header = parseObject(headerText, 1)
  if (header['type'] !== 'times-header') {
    throw new Error('event-times.jsonl line 1: expected a times-header')
  }
  if (header['version'] !== 1) {
    throw new Error(
      `event-times.jsonl line 1: unsupported version ${String(header['version'])}`,
    )
  }
  const startedAt = header['startedAt']
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    throw new Error('event-times.jsonl line 1: startedAt must be a number')
  }
  const entries: Array<{ ms: number; tick: number }> = []
  for (const [index, text] of lines.slice(1).entries()) {
    const line = index + 2
    const raw = parseObject(text, line)
    const ms = raw['ms']
    const tick = raw['tick']
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
      throw new Error(
        `event-times.jsonl line ${String(line)}: ms must be a number`,
      )
    }
    if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0) {
      throw new Error(
        `event-times.jsonl line ${String(line)}: tick must be a non-negative integer`,
      )
    }
    entries.push({ ms, tick })
  }
  return { startedAt, entries }
}

function parseObject(text: string, line: number): Record<string, unknown> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`event-times.jsonl line ${String(line)}: not valid JSON`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      `event-times.jsonl line ${String(line)}: expected an object`,
    )
  }
  return raw as Record<string, unknown>
}

/**
 * Puts the events on the recording's timeline.
 *
 * `originMs` is what "zero" means for the caller: the capture's
 * `session.startedAt` when there is a capture, so events and frames share an
 * origin, and the times file's own `startedAt` when a log was recorded on its
 * own. Both are epoch milliseconds from the same machine, so the subtraction
 * is exact rather than approximate.
 *
 * The header line of `events.jsonl` carries no time and gets none; everything
 * else is paired by position and cross-checked by `tick`, so a times file that
 * belongs to a different run is refused instead of silently believed.
 */
export function toTimedEvents(
  events: readonly RecordEvent[],
  times: EventTimes,
  originMs: number = times.startedAt,
): TimedEvent[] {
  const timed = events.filter(
    (event): event is Exclude<RecordEvent, EventHeader> =>
      event.type !== 'header',
  )
  if (timed.length !== times.entries.length) {
    throw new Error(
      `event-times.jsonl describes ${String(times.entries.length)} events, ` +
        `events.jsonl carries ${String(timed.length)}`,
    )
  }
  const offsetMs = times.startedAt - originMs
  return timed.map((event, index) => {
    const entry = times.entries[index]
    if (entry === undefined) {
      throw new Error('unreachable: event time index out of bounds')
    }
    if (entry.tick !== event.tick) {
      throw new Error(
        `event-times.jsonl line ${String(index + 2)} is tick ${String(entry.tick)}, ` +
          `events.jsonl line ${String(index + 2)} is tick ${String(event.tick)}: ` +
          'the two files are not from the same run',
      )
    }
    return { event, timeMs: offsetMs + entry.ms }
  })
}
