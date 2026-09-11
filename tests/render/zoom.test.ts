import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { BoundingBox, RecordEvent } from '../../src/record.js'
import { toTimedEvents } from '../../src/render/clock.js'
import { parseEventLog } from '../../src/render/events.js'
import { resolveFormat, type FormatSpec } from '../../src/render/format.js'
import { boxToRect, contains, type Rect } from '../../src/render/geometry.js'
import {
  buildZoomSegments,
  cropAt,
  DEFAULT_ZOOM_LOOK,
  frameBoundingBox,
} from '../../src/render/zoom.js'

const LANDSCAPE: FormatSpec = {
  aspect: '16:9',
  desired: { width: 1920, height: 1080 },
}
const CAPTURE = { width: 2560, height: 1600 }
const VIEWPORT = { width: 1280, height: 720 }

const FIXTURES = [
  'run-scroll-click',
  'run-touch',
  'run-sticky-overlay',
  'run-edge',
]

function fixture(name: string): RecordEvent[] {
  return parseEventLog(
    readFileSync(
      join(import.meta.dirname, 'fixtures', `${name}.jsonl`),
      'utf8',
    ),
  )
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  }
}

describe('framing a logged bounding box', () => {
  const format = resolveFormat(LANDSCAPE, CAPTURE)

  it('frames the element, not a point beside it', () => {
    const box: BoundingBox = { x: 900, y: 600, width: 300, height: 120 }
    const { rect } = frameBoundingBox(box, format)
    expect(contains(rect, boxToRect(box))).toBe(true)
    const centerX = rect.x + rect.width / 2
    const centerY = rect.y + rect.height / 2
    expect(centerX).toBeCloseTo(box.x + box.width / 2, 0)
    expect(centerY).toBeCloseTo(box.y + box.height / 2, 0)
  })

  it('never crops below the output size, and says so when it has to stop', () => {
    const icon: BoundingBox = { x: 1200, y: 700, width: 18, height: 18 }
    const { clamp, rect } = frameBoundingBox(icon, format, { paddingPx: 4 })
    expect(rect.width).toBeGreaterThanOrEqual(format.output.width)
    expect(rect.height).toBeGreaterThanOrEqual(format.output.height)
    expect(clamp).toMatch(/never blown up/)
  })

  it('keeps the crop inside the source raster for an element at the edge', () => {
    const corner: BoundingBox = { x: 2530, y: 1410, width: 20, height: 20 }
    const { rect } = frameBoundingBox(corner, format)
    expect(rect.x).toBeGreaterThanOrEqual(format.base.x)
    expect(rect.y).toBeGreaterThanOrEqual(format.base.y)
    expect(rect.x + rect.width).toBeLessThanOrEqual(
      format.base.x + format.base.width,
    )
    expect(rect.y + rect.height).toBeLessThanOrEqual(
      format.base.y + format.base.height,
    )
  })

  it('depends on nothing but the box, the format and the look', () => {
    const box: BoundingBox = { x: 400, y: 200, width: 400, height: 80 }
    expect(frameBoundingBox(box, format)).toEqual(frameBoundingBox(box, format))
  })
})

describe('the zoom frames the hit element at every click', () => {
  for (const name of FIXTURES) {
    it(`${name}: the crop contains the logged bounding box`, () => {
      const events = toTimedEvents(fixture(name))
      const format = resolveFormat(LANDSCAPE, VIEWPORT)
      const segments = buildZoomSegments(events, format)
      const interactions = events.filter(({ event }) =>
        ['click', 'tap', 'type'].includes(event.type),
      )
      expect(interactions.length).toBeGreaterThan(0)
      for (const { event, timeMs } of interactions) {
        if (!('bbox' in event)) continue
        const crop = cropAt(timeMs, segments, format)
        // An element larger than the picture cannot be contained by a crop of
        // the picture; what must hold is that every visible part of it is in
        // frame.
        const visible = intersect(boxToRect(event.bbox), format.base)
        expect(contains(crop, visible, 1)).toBe(true)
      }
    })
  }

  it('has arrived on the element before the click, not on the way to it', () => {
    const events = toTimedEvents(fixture('run-scroll-click'))
    const format = resolveFormat(LANDSCAPE, VIEWPORT)
    const segments = buildZoomSegments(events, format)
    for (const segment of segments) {
      expect(cropAt(segment.eventMs, segments, format)).toEqual(segment.target)
    }
  })
})

describe('a bounded-animating target', () => {
  // The logged box is the element's resting extent — an envelope over an
  // observation window, not the geometry of the one frame the click landed
  // on. A pop-in call to action that rests at 400x80 is logged at 400x80 even
  // if it measured 219x44 at the instant of the click. The camera must
  // therefore stand perfectly still while the element pulses.
  const RESTING: BoundingBox = { x: 800, y: 500, width: 400, height: 80 }
  const format = resolveFormat(LANDSCAPE, CAPTURE)

  function pulsingLog(): RecordEvent[] {
    const events: RecordEvent[] = [
      { type: 'header', version: 1, fps: 60, seed: 1 },
    ]
    for (let tick = 0; tick <= 300; tick += 1) {
      events.push({ type: 'pointer', tick, x: 1000, y: 540 })
    }
    events.push({ type: 'click', tick: 180, x: 1000, y: 540, bbox: RESTING })
    return events
  }

  it('does not breathe with the element while the camera holds', () => {
    const events = toTimedEvents(pulsingLog())
    const segments = buildZoomSegments(events, format)
    const segment = segments[0]
    expect(segment).toBeDefined()
    if (segment === undefined) return

    const held: Rect[] = []
    for (
      let timeMs = segment.eventMs;
      timeMs < segment.endMs;
      timeMs += 1000 / 60
    ) {
      held.push(cropAt(timeMs, segments, format))
    }
    expect(held.length).toBeGreaterThan(30)
    for (const crop of held) {
      expect(crop).toEqual(segment.target)
      expect(contains(crop, boxToRect(RESTING))).toBe(true)
    }
  })

  it('frames the resting extent, not the instantaneous one', () => {
    // The same click logged with the shrunken, mid-animation geometry would
    // produce a tighter crop. The renderer must never see that value — and it
    // must not try to recover it by widening adaptively, which is what would
    // reintroduce the breathing.
    // A hero call-to-action that pops in from its top-left anchor: it rests
    // at 1800x360 but measured 990x180 in the frame the click landed on.
    const restingHero: BoundingBox = {
      x: 400,
      y: 600,
      width: 1800,
      height: 360,
    }
    const instantaneous: BoundingBox = {
      x: 400,
      y: 690,
      width: 990,
      height: 180,
    }
    const resting = frameBoundingBox(restingHero, format).rect
    const shrunken = frameBoundingBox(instantaneous, format).rect
    expect(resting.width).toBeGreaterThan(shrunken.width)
    expect(contains(resting, boxToRect(restingHero))).toBe(true)
    expect(contains(shrunken, boxToRect(restingHero))).toBe(false)
  })
})

describe('the shot list', () => {
  it('opens the shot early enough for the camera to arrive', () => {
    const events = toTimedEvents(fixture('run-scroll-click'))
    const format = resolveFormat(LANDSCAPE, VIEWPORT)
    for (const segment of buildZoomSegments(events, format)) {
      expect(segment.eventMs - segment.startMs).toBeGreaterThanOrEqual(
        segment.zoomInMs,
      )
      expect(segment.endMs).toBeGreaterThan(segment.eventMs)
    }
  })

  it('refuses a look whose lead is too short to arrive on time', () => {
    expect(() =>
      buildZoomSegments([], resolveFormat(LANDSCAPE, CAPTURE), {
        zoomLeadMs: 100,
        zoomInMs: 650,
      }),
    ).toThrow(/settled on the element/)
  })

  it('rests on the full picture when nothing is happening', () => {
    const format = resolveFormat(LANDSCAPE, CAPTURE)
    expect(cropAt(0, [], format)).toEqual(format.base)
    expect(cropAt(99_999, [], format)).toEqual(format.base)
  })

  it('returns to the resting frame after the shot is over', () => {
    const events = toTimedEvents(fixture('run-touch'))
    const format = resolveFormat(LANDSCAPE, VIEWPORT)
    const segments = buildZoomSegments(events, format)
    const last = segments.at(-1)
    expect(last).toBeDefined()
    if (last === undefined) return
    const settled = cropAt(
      last.endMs + DEFAULT_ZOOM_LOOK.zoomOutMs + 1,
      segments,
      format,
    )
    expect(settled).toEqual(format.base)
  })
})
