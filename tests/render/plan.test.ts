import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseEventLog } from '../../src/render/events.js'
import { boxToRect, contains } from '../../src/render/geometry.js'
import {
  planRender,
  serializePlan,
  type CaptureInput,
} from '../../src/render/plan.js'

const STARTED_AT = 1_700_000_000_000

function capture(frameCount = 90, spacingMs = 16.666): CaptureInput {
  const frames = Array.from({ length: frameCount }, (_, index) => ({
    file: `frame-${String(index).padStart(6, '0')}.jpg`,
    timestamp: STARTED_AT + index * spacingMs,
  }))
  return {
    frames,
    sessionDurationMs: frameCount * spacingMs,
    sessionStartedAt: STARTED_AT,
    source: { width: 1280, height: 720 },
  }
}

function fixture(name: string) {
  return parseEventLog(
    readFileSync(
      join(import.meta.dirname, 'fixtures', `${name}.jsonl`),
      'utf8',
    ),
  )
}

describe('one raw recording, three formats', () => {
  const events = fixture('run-scroll-click')
  const input = capture(400)

  it('delivers 16:9, 9:16 and 1:1 from a single pass over the same frames', () => {
    const plan = planRender(input, events)
    expect(plan.formats.map((format) => format.aspect)).toEqual([
      '16:9',
      '9:16',
      '1:1',
    ])
    for (const format of plan.formats) {
      expect(format.frames.length).toBe(plan.formats[0]?.frames.length)
      expect(format.frames.length).toBeGreaterThan(0)
    }
  })

  it('never asks for more pixels than the capture holds', () => {
    const plan = planRender(input, events)
    for (const format of plan.formats) {
      for (const frame of format.frames) {
        expect(frame.crop.width).toBeGreaterThanOrEqual(format.output.width)
        expect(frame.crop.height).toBeGreaterThanOrEqual(format.output.height)
        expect(frame.crop.x).toBeGreaterThanOrEqual(format.base.x)
        expect(frame.crop.x + frame.crop.width).toBeLessThanOrEqual(
          format.base.x + format.base.width,
        )
      }
    }
  })

  it('frames the hit element in every format, not only the landscape one', () => {
    const plan = planRender(input, events)
    for (const format of plan.formats) {
      for (const segment of format.segments) {
        const frame = format.frames.find(
          (candidate) => candidate.timeMs >= segment.eventMs,
        )
        expect(frame).toBeDefined()
        if (frame === undefined) continue
        const box = boxToRect(segment.target)
        expect(contains(frame.crop, box, 2)).toBe(true)
      }
    }
  })
})

describe('determinism', () => {
  it('produces byte-identical decision data twice', () => {
    const events = fixture('run-scroll-click')
    const input = capture(400)
    const first = serializePlan(planRender(input, events))
    const second = serializePlan(planRender(input, events))
    expect(first).toBe(second)
    expect(first.length).toBeGreaterThan(1000)
  })

  it('produces byte-identical decision data for the touch recording too', () => {
    const events = fixture('run-touch')
    const input = capture(200)
    expect(serializePlan(planRender(input, events))).toBe(
      serializePlan(planRender(input, events)),
    )
  })
})

describe('a look parameter is a parameter', () => {
  const events = fixture('run-scroll-click')
  const input = capture(400)

  it('changes the framing without touching the recording', () => {
    const tight = planRender(input, events, { zoom: { paddingPx: 20 } })
    const loose = planRender(input, events, { zoom: { paddingPx: 300 } })
    expect(serializePlan(tight)).not.toBe(serializePlan(loose))
    expect(tight.frames).toEqual(loose.frames)
  })

  it('changes the pointer without touching the framing', () => {
    const withCursor = planRender(input, events)
    const without = planRender(input, events, { cursor: { visible: false } })
    expect(
      without.formats[0]?.frames.every((frame) => frame.cursor === null),
    ).toBe(true)
    expect(withCursor.formats[0]?.frames.map((frame) => frame.crop)).toEqual(
      without.formats[0]?.frames.map((frame) => frame.crop),
    )
  })
})

describe('the cursor comes from the log, because the browser draws none', () => {
  it('draws an arrow for a mouse recording and a ripple at the click', () => {
    const plan = planRender(capture(400), fixture('run-scroll-click'))
    const frames = plan.formats[0]?.frames ?? []
    expect(frames.some((frame) => frame.cursor?.kind === 'arrow')).toBe(true)
    expect(frames.some((frame) => frame.cursor?.ripplePhase !== null)).toBe(
      true,
    )
  })

  it('draws a touch ripple, not an arrow, for a tap recording', () => {
    const plan = planRender(capture(200), fixture('run-touch'))
    const frames = plan.formats[0]?.frames ?? []
    expect(
      frames.every(
        (frame) => frame.cursor === null || frame.cursor.kind === 'touch',
      ),
    ).toBe(true)
  })
})
