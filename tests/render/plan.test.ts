import { describe, expect, it } from 'vitest'

import type { BoundingBox } from '../../src/record.js'
import { boxToRect, contains } from '../../src/render/geometry.js'
import {
  planRender,
  serializePlan,
  type CaptureInput,
} from '../../src/render/plan.js'
import type { TimedEvent } from '../../src/render/events.js'
import { recordedFixture as fixture } from './timed.js'

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

describe('one raw recording, three formats', () => {
  const events = fixture('run-scroll-click')
  const input = capture(400)

  it('delivers 16:9, 9:16 and 1:1 from a single pass over the same frames', () => {
    const plan = planRender(input, events)
    expect(plan.formats.map((format) => format.label)).toEqual([
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
        // Bounded by how much raster there is, which is `panBounds` — not by
        // where the camera happens to rest. Those were the same rectangle in
        // round one, and that is what froze the portrait format.
        expect(frame.crop.x).toBeGreaterThanOrEqual(format.panBounds.x)
        expect(frame.crop.y).toBeGreaterThanOrEqual(format.panBounds.y)
        expect(frame.crop.x + frame.crop.width).toBeLessThanOrEqual(
          format.panBounds.x + format.panBounds.width,
        )
        expect(frame.crop.y + frame.crop.height).toBeLessThanOrEqual(
          format.panBounds.y + format.panBounds.height,
        )
      }
    }
  })

  it('derives the crop’s height from its width, not from a second rounding', () => {
    // Whole even pixels cannot hit an arbitrary ratio exactly. What they can do
    // is fail it in one place instead of two: rounding both axes on their own
    // let the crop drift off-ratio by up to two pixels on each, and an
    // off-ratio crop in a chain that only crops and scales is a small
    // non-uniform stretch. Here the height follows from the rounded width, so
    // there is a single rounding and it is the smallest one available.
    const plan = planRender(input, events)
    const evenUp = (value: number): number => {
      const ceiling = Math.ceil(value)
      return ceiling + (ceiling % 2)
    }
    for (const format of plan.formats) {
      const aspect = format.output.width / format.output.height
      for (const frame of format.frames) {
        expect(frame.crop.height).toBe(evenUp(frame.crop.width / aspect))
      }
    }
  })

  it('frames the hit element in every format, not only the landscape one', () => {
    // Against the element's own logged box, not against the segment's target.
    // Comparing a crop with the framing it was computed from is self-consistent
    // by construction and cannot fail, whatever the framing does.
    const boxes = new Map<number, BoundingBox>()
    for (const { event, timeMs } of events) {
      if ('bbox' in event) boxes.set(Math.round(timeMs), event.bbox)
    }
    expect(boxes.size).toBeGreaterThan(0)

    const plan = planRender(input, events)
    let checked = 0
    for (const format of plan.formats) {
      for (const segment of format.segments) {
        const box = boxes.get(Math.round(segment.eventMs))
        expect(box).toBeDefined()
        if (box === undefined) continue
        const frame = format.frames.find(
          (candidate) => candidate.timeMs >= segment.eventMs,
        )
        expect(frame).toBeDefined()
        if (frame === undefined) continue
        expect(contains(frame.crop, boxToRect(box), 2)).toBe(true)
        checked += 1
      }
    }
    expect(checked).toBe(plan.formats.length * boxes.size)
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

describe('a scripted hold survives idle trimming', () => {
  it('plays the declared length of every hold in the log', () => {
    // Issue 139, end to end through the plan: a click, then the page stands
    // still for five seconds, of which the script asked for three.
    const input: CaptureInput = {
      frames: [0, 16, 33, 5033, 5050].map((ms, index) => ({
        file: `frame-${String(index).padStart(6, '0')}.jpg`,
        timestamp: STARTED_AT + ms,
      })),
      sessionDurationMs: 5100,
      sessionStartedAt: STARTED_AT,
      source: { width: 1280, height: 720 },
    }
    const bbox: BoundingBox = { x: 100, y: 100, width: 50, height: 20 }
    const events: TimedEvent[] = [
      { event: { type: 'pointer', tick: 0, x: 120, y: 110 }, timeMs: 0 },
      { event: { type: 'click', tick: 1, x: 120, y: 110, bbox }, timeMs: 16 },
      { event: { type: 'hold', tick: 60, milliseconds: 3000 }, timeMs: 1000 },
    ]
    const plan = planRender(input, events)
    // Without the hold, all of 33..5033 minus the click's guard would be
    // squeezed to 250ms. With it, the three seconds stay.
    expect(plan.idle.outputDurationMs).toBeGreaterThanOrEqual(3000)
    for (const stretch of plan.idle.trimmed) {
      const overlap =
        Math.min(stretch.endMs, 4000) - Math.max(stretch.startMs, 1000)
      expect(overlap).toBeLessThanOrEqual(0)
    }
  })
})
