import type { BoundingBox, RecordEvent } from '../record.js'

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
