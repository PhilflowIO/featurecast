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
const PORTRAIT: FormatSpec = {
  aspect: '9:16',
  desired: { width: 1080, height: 1920 },
}
const SQUARE: FormatSpec = {
  aspect: '1:1',
  desired: { width: 1080, height: 1080 },
}
const CAPTURE = { width: 2560, height: 1600 }

/**
 * Every fixture below except the last is a real event log from
 * `artifacts/m2-001`, and every one of them contains at least one click or tap
 * with a bounding box. That is the point: the milestone is judged on whether
 * the zoom frames the element that was hit, so the suite has to be run against
 * logs in which something was actually hit.
 *
 * `run-a` and `run-b` are the two logs in the whole corpus whose interactions
 * are closer together than `zoomLeadMs` — 433ms apart. Rounds one and two both
 * shipped a suite in which the crowded-shot path was unreachable: four of the
 * five fixtures have a single interaction and the fifth has a 1917ms gap, so
 * the code that decides what happens when two shots collide was never once
 * executed by a test. These two make it reachable with real material.
 *
 * `run-close-taps` is synthetic and deliberately extreme: two taps 400ms apart
 * on opposite sides of the viewport, which is the case where a truncated shot
 * puts the clicked element *entirely outside* the picture rather than merely
 * off-centre. Two taps that far apart that fast are ordinary on a touch screen
 * — the finger lifts, so there is no pointer path between them.
 */
const FIXTURES = [
  'run-scroll-click',
  'run-touch',
  'run-sticky-overlay',
  'run-edge',
  'run-hero',
  'run-a',
  'run-b',
  'run-close-taps',
]

/**
 * How many shots each fixture produces, and how many of those shots had to give
 * way to a successor. Both numbers are asserted, not just the second: a "no
 * fixture violates the invariant" that quietly ran over two segments instead of
 * eleven would be a green suite measuring nothing. The counts are absolute so
 * that a change in the corpus shows up as a failure here rather than as a
 * silently smaller denominator.
 */
const SHOTS: Record<string, { crowded: number; segments: number }> = {
  'run-a': { crowded: 1, segments: 2 },
  'run-b': { crowded: 1, segments: 2 },
  'run-close-taps': { crowded: 1, segments: 2 },
  'run-edge': { crowded: 0, segments: 1 },
  'run-hero': { crowded: 0, segments: 1 },
  'run-scroll-click': { crowded: 0, segments: 2 },
  'run-sticky-overlay': { crowded: 0, segments: 1 },
  'run-touch': { crowded: 0, segments: 1 },
}

function fixture(name: string): RecordEvent[] {
  return parseEventLog(
    readFileSync(
      join(import.meta.dirname, 'fixtures', `${name}.jsonl`),
      'utf8',
    ),
  )
}

/**
 * The fixtures were recorded against a 1280x720 viewport; the capture raster
 * these tests frame against is 2560x1600. Doubling every coordinate is exactly
 * what a device-pixel-ratio-2 recording of the same page looks like, and it is
 * what spreads the elements across the whole raster instead of crowding them
 * into the top-left corner — where every crop would sit pinned against an edge
 * and the "is the element in the middle of the shot" assertion would be skipped
 * for all of them.
 */
function atCaptureScale(events: readonly RecordEvent[]): RecordEvent[] {
  return events.map((event) => {
    if (event.type === 'header' || !('x' in event)) return event
    const scaled = { ...event, x: event.x * 2, y: event.y * 2 }
    if (!('bbox' in scaled)) return scaled
    return {
      ...scaled,
      bbox: {
        x: scaled.bbox.x * 2,
        y: scaled.bbox.y * 2,
        width: scaled.bbox.width * 2,
        height: scaled.bbox.height * 2,
      },
    }
  })
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

/**
 * The headline acceptance criterion of issue #5, and the one round one could
 * not fail.
 *
 * It ran against `resolveFormat(LANDSCAPE, {1280x720})`, a format whose
 * `maxZoom` is exactly 1, so every crop came out the full base rectangle and
 * the assertion reduced to "the picture contains a piece of itself" — true by
 * construction, for any framing whatsoever. It was weakened a second time by
 * reducing the target through `intersect`, which returns a zero-width rectangle
 * for an off-screen element, and a zero-width rectangle is contained by
 * anything.
 *
 * So: the real capture size, which has 1.33x of zoom reserve, and a target that
 * has to be non-empty before it is allowed to be contained.
 */
function visiblePart(box: Rect, format: { base: Rect }): Rect {
  // An element larger than the picture cannot be contained by a crop of the
  // picture; what must hold is that every visible part of it is in frame.
  const visible = intersect(box, format.base)
  if (visible.width <= 0 || visible.height <= 0) {
    throw new Error(
      'The logged element has no visible overlap with the picture at all, ' +
        'so "the crop contains it" is not a claim about framing. `record` ' +
        'refuses such a target; a fixture that produced one is a bug in the ' +
        'fixture, not a passing test.',
    )
  }
  return visible
}

describe('the zoom frames the hit element at every click', () => {
  for (const name of FIXTURES) {
    it(`${name}: the crop contains the logged bounding box`, () => {
      const events = toTimedEvents(atCaptureScale(fixture(name)))
      const format = resolveFormat(LANDSCAPE, CAPTURE)
      expect(format.maxZoom).toBeGreaterThan(1.3)
      const segments = buildZoomSegments(events, format)
      const interactions = events.filter(({ event }) =>
        ['click', 'tap', 'type'].includes(event.type),
      )
      expect(interactions.length).toBeGreaterThan(0)
      let framed = 0
      for (const { event, timeMs } of interactions) {
        if (!('bbox' in event)) continue
        const crop = cropAt(timeMs, segments, format)
        // The crop has to be the framing computed for *this* element, not some
        // rectangle that happens to contain it — and for anything smaller than
        // the capture's reserve that is a genuine close-up rather than the
        // resting frame.
        expect(crop).toEqual(frameBoundingBox(event.bbox, format).rect)
        const padded = event.bbox.width + 2 * DEFAULT_ZOOM_LOOK.paddingPx
        if (padded < format.output.width) {
          expect(crop.width).toBe(format.output.width)
          expect(crop.width).toBeLessThan(format.base.width)
        }
        const box = boxToRect(event.bbox)
        expect(contains(crop, visiblePart(box, format), 1)).toBe(true)
        // Containment alone is a loose test: a 1920px crop around a 200px
        // button has hundreds of pixels of slack on each side, so a framing
        // that missed by half the picture would still "contain" it. The
        // element has to be in the middle of the shot, unless the crop is
        // pinned against the edge of the raster and cannot be.
        const pinnedX =
          crop.x <= format.panBounds.x ||
          crop.x + crop.width >= format.panBounds.x + format.panBounds.width
        const pinnedY =
          crop.y <= format.panBounds.y ||
          crop.y + crop.height >= format.panBounds.y + format.panBounds.height
        if (!pinnedX) {
          expect(crop.x + crop.width / 2).toBeCloseTo(box.x + box.width / 2, 0)
        }
        if (!pinnedY) {
          expect(crop.y + crop.height / 2).toBeCloseTo(
            box.y + box.height / 2,
            0,
          )
        }
        framed += 1
      }
      expect(framed).toBeGreaterThan(0)
    })
  }

  it('fails when the framing is wrong, which is the point of it', () => {
    const events = toTimedEvents(atCaptureScale(fixture('run-scroll-click')))
    const format = resolveFormat(LANDSCAPE, CAPTURE)
    const segments = buildZoomSegments(events, format)
    const clicks = events.filter(({ event }) => 'bbox' in event)
    expect(clicks.length).toBeGreaterThan(0)
    for (const { event, timeMs } of clicks) {
      if (!('bbox' in event)) continue
      const crop = cropAt(timeMs, segments, format)
      const visible = visiblePart(boxToRect(event.bbox), format)
      // The same assertion against a crop framed a few hundred pixels beside
      // the element — "a point beside it", in the milestone's words.
      const beside = { ...crop, x: crop.x + 400, y: crop.y + 300 }
      expect(contains(beside, visible, 1)).toBe(false)
    }
  })

  it('refuses to call an off-screen element framed', () => {
    const format = resolveFormat(LANDSCAPE, CAPTURE)
    const offScreen: Rect = { x: 4000, y: 2000, width: 200, height: 80 }
    expect(() => visiblePart(offScreen, format)).toThrow(/no visible overlap/)
  })

  it('has arrived on the element before the click, not on the way to it', () => {
    const events = toTimedEvents(fixture('run-scroll-click'))
    const format = resolveFormat(LANDSCAPE, CAPTURE)
    const segments = buildZoomSegments(events, format)
    expect(segments.length).toBeGreaterThan(0)
    for (const segment of segments) {
      expect(cropAt(segment.eventMs, segments, format)).toEqual(segment.target)
      expect(segment.target).not.toEqual(format.base)
    }
  })
})

/**
 * The invariant the whole milestone rests on: **a shot never ends before its
 * own event.**
 *
 * Round two ended a crowded shot at its successor's ideal start, which for the
 * 433ms gap in `run-a` is 267ms before the first click. `cropAt` answered that
 * click with a point on the journey to the next element — 92px beside it there,
 * and 657px beside it on two targets on opposite sides, where the clicked
 * element was not in the picture at all. Six of the 57 shots the corpus
 * produces were cut that way, and the error has no bound.
 */
describe('a shot never ends before its own event', () => {
  const format = resolveFormat(LANDSCAPE, CAPTURE)

  for (const name of FIXTURES) {
    it(`${name}: every shot is on its element when its event lands`, () => {
      const events = toTimedEvents(atCaptureScale(fixture(name)))
      const segments = buildZoomSegments(events, format)
      const expected = SHOTS[name]
      expect(expected).toBeDefined()
      if (expected === undefined) return
      // The denominator, asserted: this many shots, of which this many were
      // crowded by a successor. Without it, "no shot violates the invariant"
      // would still pass over an empty shot list.
      expect(segments.length).toBe(expected.segments)

      let crowded = 0
      for (const [index, segment] of segments.entries()) {
        expect(segment.endMs).toBeGreaterThan(segment.eventMs)
        expect(cropAt(segment.eventMs, segments, format)).toEqual(
          segment.target,
        )
        const successor = segments[index + 1]
        if (successor === undefined) continue
        const ideal = Math.max(
          0,
          successor.eventMs - DEFAULT_ZOOM_LOOK.zoomLeadMs,
        )
        if (successor.startMs > ideal) {
          // The successor's approach was pushed later, which only happens when
          // it collided with this shot's hold — the guarded path.
          crowded += 1
          expect(segment.endMs).toBeLessThan(
            segment.eventMs + DEFAULT_ZOOM_LOOK.minHoldMs,
          )
          expect(successor.from).toEqual(segment.target)
          expect(successor.startMs).toBeGreaterThanOrEqual(segment.endMs)
          expect(successor.zoomInMs).toBeLessThanOrEqual(
            successor.eventMs - successor.startMs,
          )
        }
      }
      expect(crowded).toBe(expected.crowded)
    })
  }

  it('would frame a way-point if the shot were truncated, which is why it is not', () => {
    // The old rule, applied by hand to the shots the new one produced, so the
    // assertion above is shown to be sharp rather than merely green. Two taps
    // 400ms apart on opposite sides: truncating the first shot at the second's
    // ideal start leaves the tapped element completely out of frame at the
    // moment it is tapped.
    const events = toTimedEvents(atCaptureScale(fixture('run-close-taps')))
    const segments = buildZoomSegments(events, format)
    const first = segments[0]
    const second = segments[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first === undefined || second === undefined) return

    const truncatedStart = Math.max(
      0,
      second.eventMs - DEFAULT_ZOOM_LOOK.zoomLeadMs,
    )
    expect(truncatedStart).toBeLessThan(first.eventMs)
    const truncated = [
      { ...first, endMs: truncatedStart },
      {
        ...second,
        startMs: truncatedStart,
        zoomInMs: Math.min(
          DEFAULT_ZOOM_LOOK.zoomInMs,
          second.eventMs - truncatedStart,
        ),
      },
    ]
    const wayPoint = cropAt(first.eventMs, truncated, format)
    expect(wayPoint).not.toEqual(first.target)
    const taps = events.filter(({ event }) => event.type === 'tap')
    const firstTap = taps[0]
    expect(firstTap).toBeDefined()
    if (firstTap === undefined || !('bbox' in firstTap.event)) return
    expect(contains(wayPoint, boxToRect(firstTap.event.bbox), 1)).toBe(false)
    // ...while the rule that ships keeps it framed.
    expect(
      contains(
        cropAt(first.eventMs, segments, format),
        boxToRect(firstTap.event.bbox),
        1,
      ),
    ).toBe(true)
  })

  it('refuses two interactions too close for any honest camera move', () => {
    const events: RecordEvent[] = [
      { type: 'header', version: 1, fps: 60, seed: 1 },
    ]
    for (let tick = 0; tick <= 60; tick += 1) {
      events.push({ type: 'pointer', tick, x: 200, y: 400 })
    }
    // One 60Hz tick apart: there is no move that arrives on both elements in
    // time, so the renderer says so instead of picking a way-point at one of
    // the two clicks.
    events.push({
      type: 'click',
      tick: 60,
      x: 200,
      y: 400,
      bbox: { x: 100, y: 380, width: 200, height: 80 },
    })
    events.push({
      type: 'click',
      tick: 61,
      x: 2300,
      y: 200,
      bbox: { x: 2200, y: 180, width: 200, height: 80 },
    })
    expect(() => buildZoomSegments(toTimedEvents(events), format)).toThrow(
      /no honest move/,
    )
  })
})

describe('a format with no zoom reserve still has pan reserve', () => {
  // 9:16 out of a 2560x1600 desktop capture: the tallest portrait rectangle in
  // it is 900x1600, so the output is 900x1600 and maxZoom is exactly 1. Round
  // one made the crop floor double as the crop's fence, so every portrait frame
  // was the same centre strip — 900 pixels out of 2560 — and a click on a left
  // hand nav produced a video of a click on nothing.
  const format = resolveFormat(PORTRAIT, CAPTURE)

  it('has no zoom left to give, which is the premise', () => {
    expect(format.maxZoom).toBeCloseTo(1, 6)
    expect(format.output).toEqual({ width: 900, height: 1600 })
  })

  it('follows the element sideways instead of freezing on the centre', () => {
    const left = frameBoundingBox(
      { x: 120, y: 700, width: 220, height: 60 },
      format,
    ).rect
    const middle = frameBoundingBox(
      { x: 1180, y: 700, width: 220, height: 60 },
      format,
    ).rect
    const right = frameBoundingBox(
      { x: 2340, y: 700, width: 200, height: 60 },
      format,
    ).rect
    expect(left.x).toBeLessThan(middle.x)
    expect(middle.x).toBeLessThan(right.x)
    for (const [crop, box] of [
      [left, { x: 120, y: 700, width: 220, height: 60 }],
      [middle, { x: 1180, y: 700, width: 220, height: 60 }],
      [right, { x: 2340, y: 700, width: 200, height: 60 }],
    ] as const) {
      expect(contains(crop, boxToRect(box), 1)).toBe(true)
      expect(crop.width).toBe(format.output.width)
      expect(crop.x).toBeGreaterThanOrEqual(0)
      expect(crop.x + crop.width).toBeLessThanOrEqual(CAPTURE.width)
    }
  })

  it('pans on a spring like everything else, so it does not snap', () => {
    const events: RecordEvent[] = [
      { type: 'header', version: 1, fps: 60, seed: 1 },
    ]
    for (let tick = 0; tick <= 240; tick += 1) {
      events.push({ type: 'pointer', tick, x: 230, y: 730 })
    }
    events.push({
      type: 'click',
      tick: 120,
      x: 230,
      y: 730,
      bbox: { x: 120, y: 700, width: 220, height: 60 },
    })
    const timed = toTimedEvents(events)
    const segments = buildZoomSegments(timed, format)
    const segment = segments[0]
    expect(segment).toBeDefined()
    if (segment === undefined) return
    const travelled: number[] = []
    for (
      let timeMs = segment.startMs;
      timeMs <= segment.eventMs;
      timeMs += 1000 / 60
    ) {
      travelled.push(cropAt(timeMs, segments, format).x)
    }
    expect(travelled.length).toBeGreaterThan(20)
    const first = travelled[0] ?? 0
    const last = travelled.at(-1) ?? 0
    expect(first).toBeCloseTo(format.base.x, 6)
    expect(last).toBeCloseTo(segment.target.x, 6)
    // No single step may cover more than a fifth of the journey: that is what
    // "it slides rather than cuts" means in numbers.
    for (let i = 1; i < travelled.length; i += 1) {
      const step = Math.abs((travelled[i] ?? 0) - (travelled[i - 1] ?? 0))
      expect(step).toBeLessThan(Math.abs(last - first) / 5)
    }
  })
})

describe('landscape is left exactly where it was', () => {
  // The pan reserve is deliberately horizontal only, and 16:9 spans the
  // capture's full width already. Its bounds are therefore its resting frame,
  // which is the same rectangle round one used — there is no behaviour left for
  // this change to alter. The vertical anchoring that drops the bottom 160
  // pixels is a decision made on purpose in `baseRect` and stays made.
  it('bounds 16:9 by its resting frame, as before, because it has no width to spare', () => {
    const format = resolveFormat(LANDSCAPE, CAPTURE)
    expect(format.panBounds).toEqual(format.base)
  })

  it('never lets a 16:9 crop leave the resting frame, on the whole corpus', () => {
    const format = resolveFormat(LANDSCAPE, CAPTURE)
    let checked = 0
    for (const name of FIXTURES) {
      const events = toTimedEvents(fixture(name))
      const segments = buildZoomSegments(events, format)
      for (const segment of segments) {
        for (const timeMs of [
          segment.startMs,
          segment.eventMs,
          segment.endMs,
        ]) {
          expect(
            contains(format.base, cropAt(timeMs, segments, format), 1),
          ).toBe(true)
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(10)
  })
})

describe('the square format has the same defect, milder', () => {
  // 1:1 out of a 2560x1600 capture rests on the middle 1600 pixels, so 480 on
  // each side were unreachable for exactly the same reason the portrait strip
  // was frozen. The fix is the same fix. What does not change is the zoom: 1:1
  // keeps its 1.48x of reserve and its crop sizes.
  const format = resolveFormat(SQUARE, CAPTURE)

  it('frames an element the resting frame could already reach exactly as before', () => {
    const inside = { x: 1180, y: 700, width: 220, height: 60 }
    const { rect } = frameBoundingBox(inside, format)
    expect(contains(format.base, rect, 1)).toBe(true)
  })

  it('now follows an element the resting frame never covered', () => {
    const leftNav = { x: 120, y: 700, width: 220, height: 60 }
    const { rect } = frameBoundingBox(leftNav, format)
    expect(contains(rect, boxToRect(leftNav), 1)).toBe(true)
    expect(rect.x).toBeLessThan(format.base.x)
    expect(rect.x).toBeGreaterThanOrEqual(0)
  })
})

describe('a bounded-animating target', () => {
  // The logged box is the element's resting extent: the geometry it dwells at
  // longest over an observation window, not the geometry of the one frame the
  // click landed on, and not an average of the two extremes — on an asymmetric
  // animation the average is a size the element never has. A pop-in call to
  // action that rests at 400x80 is logged at 400x80 even if it measured 219x44
  // at the instant of the click. The camera must therefore stand perfectly
  // still while the element pulses.
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
    const format = resolveFormat(LANDSCAPE, CAPTURE)
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
    const format = resolveFormat(LANDSCAPE, CAPTURE)
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
