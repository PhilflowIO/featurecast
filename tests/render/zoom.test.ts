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
  peakStepFraction,
  type ZoomSegment,
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
 *
 * The last four are round four's, and they exist for two reasons the first
 * eight could not serve.
 *
 * `run-toggle-twice` and `run-type-then-click` carry two interactions at *one*
 * tick, which is what the wrapper produces whenever a script touches the same
 * place twice: `click()` logs at the current tick without advancing it
 * (`src/record.ts:334-346`), and a move onto a target the pointer already sits
 * on yields no samples to advance it with (`src/motion.ts:82`). Their pointer
 * paths come from the same `generateMotionPoints` a recording uses, so the
 * logs have a recording's shape; the two interactions are one tick apart
 * because that is what the wrapper writes, not because the fixture was bent to
 * make it so.
 *
 * All four also place their elements in the *middle* of the raster. Every one
 * of the original eight frames an element near an edge, so its crop is pinned
 * against the raster and the centring assertion below is satisfied by the pin
 * rather than by the framing — measured, a 300px error in `frameBoundingBox`
 * failed exactly one of eight fixtures. A framing that is free to be wrong in
 * both directions is the only kind that can test centring.
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
  'run-toggle-twice',
  'run-type-then-click',
  'run-interior-taps',
  'run-interior-button',
]

/**
 * What each fixture produces, in absolute numbers: how many interactions it
 * contains, how many shots those become, how long each shot holds after its
 * last event, and how many shots had to give way to a successor. All four are
 * asserted, not just the last: a "no fixture violates the invariant" that
 * quietly ran over two segments instead of eleven would be a green suite
 * measuring nothing, and a hold that silently collapses to one frame — which is
 * what round three shipped in all eighteen crowded cases — is invisible unless
 * the number itself is written down.
 *
 * `interactions` differing from `segments` is the merge: two interactions at one
 * instant on one element are one shot.
 */
const SHOTS: Record<
  string,
  {
    crowded: number
    holdMs: readonly number[]
    interactions: number
    segments: number
  }
> = {
  'run-a': { crowded: 1, holdMs: [251.6, 900], interactions: 2, segments: 2 },
  'run-b': { crowded: 1, holdMs: [251.6, 900], interactions: 2, segments: 2 },
  'run-close-taps': {
    crowded: 1,
    holdMs: [232.3, 1000],
    interactions: 2,
    segments: 2,
  },
  'run-edge': { crowded: 0, holdMs: [900], interactions: 1, segments: 1 },
  'run-hero': { crowded: 0, holdMs: [900], interactions: 1, segments: 1 },
  'run-interior-button': {
    crowded: 0,
    holdMs: [900],
    interactions: 1,
    segments: 1,
  },
  'run-interior-taps': {
    crowded: 1,
    holdMs: [232.3, 900],
    interactions: 2,
    segments: 2,
  },
  'run-scroll-click': {
    crowded: 1,
    holdMs: [1266.7, 900],
    interactions: 2,
    segments: 2,
  },
  'run-sticky-overlay': {
    crowded: 0,
    holdMs: [900],
    interactions: 1,
    segments: 1,
  },
  'run-toggle-twice': {
    crowded: 0,
    holdMs: [900],
    interactions: 2,
    segments: 1,
  },
  'run-touch': { crowded: 0, holdMs: [900], interactions: 1, segments: 1 },
  'run-type-then-click': {
    crowded: 0,
    holdMs: [900],
    interactions: 2,
    segments: 1,
  },
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
    if (event.type === 'header') return event
    // A `type` event carries a bounding box but no pointer position, so a
    // scaling that keyed on `x` left its box at viewport scale while everything
    // around it doubled — half a fixture in one coordinate system and half in
    // another. Both are scaled here, independently.
    const scaled =
      'x' in event ? { ...event, x: event.x * 2, y: event.y * 2 } : event
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
        // The shot answering this interaction. Normally one shot per
        // interaction; where two interactions land at one instant on one
        // element they share a shot, and that shot's `box` is what was framed.
        const shot = segments.find(
          (segment) =>
            timeMs >= segment.eventMs && timeMs <= segment.lastEventMs,
        )
        expect(shot).toBeDefined()
        if (shot === undefined) continue
        // The crop has to be the framing computed for *this* shot's element,
        // not some rectangle that happens to contain it — and for anything
        // smaller than the capture's reserve that is a genuine close-up rather
        // than the resting frame. The comparison stays an equality against
        // `frameBoundingBox`; a merged shot moves which box goes into it, never
        // whether the crop has to equal what comes out.
        expect(crop).toEqual(frameBoundingBox(shot.box, format).rect)
        expect(contains(boxToRect(shot.box), boxToRect(event.bbox))).toBe(true)
        const padded = shot.box.width + 2 * DEFAULT_ZOOM_LOOK.paddingPx
        if (padded < format.output.width) {
          expect(crop.width).toBe(format.output.width)
          expect(crop.width).toBeLessThan(format.base.width)
        }
        const box = boxToRect(shot.box)
        expect(
          contains(crop, visiblePart(boxToRect(event.bbox), format), 1),
        ).toBe(true)
        // Containment alone is a loose test: a 1920px crop around a 200px
        // button has hundreds of pixels of slack on each side, so a framing
        // that missed by half the picture would still "contain" it. The
        // element has to be in the middle of the shot — and where the raster
        // runs out, as far towards the middle as the raster allows.
        //
        // Rounds one and two skipped this check whenever the crop sat against
        // an edge, which inverted it: `run-edge` and `run-hero` never checked
        // at all, and `run-sticky-overlay` failed at a 20px error but passed at
        // a 900px one, because a large enough error pushes the crop against the
        // edge and switched the check off. A test that stops checking as the
        // error grows is worse than no test, so the pin is now part of the
        // expectation instead of an excuse to skip it.
        const centred = (
          value: number,
          size: number,
          low: number,
          span: number,
        ): number => Math.min(Math.max(value, low), low + span - size)
        expect(
          Math.abs(
            crop.x -
              centred(
                box.x + box.width / 2 - crop.width / 2,
                crop.width,
                format.panBounds.x,
                format.panBounds.width,
              ),
          ),
          // Two pixels of slack for the even-pixel rounding of the crop, which
          // can move its centre by one pixel on each axis. Sharp enough that
          // the 20px error of the mutation test below fails it.
        ).toBeLessThanOrEqual(2)
        expect(
          Math.abs(
            crop.y -
              centred(
                box.y + box.height / 2 - crop.height / 2,
                crop.height,
                format.panBounds.y,
                format.panBounds.height,
              ),
          ),
        ).toBeLessThanOrEqual(2)
        framed += 1
      }
      expect(framed).toBe(interactions.length)
      expect(framed).toBe(SHOTS[name]?.interactions)
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
        expect(segment.endMs).toBeGreaterThan(segment.lastEventMs)
        expect(cropAt(segment.eventMs, segments, format)).toEqual(
          segment.target,
        )
        expect(cropAt(segment.lastEventMs, segments, format)).toEqual(
          segment.target,
        )
        // The hold, in milliseconds, written down. Round three's crowded shots
        // all held for exactly one frame while `minHoldMs` said 900, and no
        // assertion anywhere said so.
        expect(segment.endMs - segment.lastEventMs).toBeCloseTo(
          expected.holdMs[index] ?? -1,
          1,
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
          expect(successor.from).toEqual(segment.target)
          expect(successor.startMs).toBeGreaterThanOrEqual(segment.endMs)
          expect(successor.zoomInMs).toBeLessThanOrEqual(
            successor.eventMs - successor.startMs,
          )
          // Hold and approach split the gap between the two events; neither
          // gets all of it and neither is cut to a single frame.
          const gap = successor.eventMs - segment.lastEventMs
          const hold = segment.endMs - segment.lastEventMs
          const approach = successor.eventMs - successor.startMs
          expect(hold + approach).toBeCloseTo(gap, 6)
          expect(hold).toBeGreaterThanOrEqual(
            Math.min(DEFAULT_ZOOM_LOOK.minHoldMs, gap / 3),
          )
          expect(approach).toBeGreaterThan(2 * (1000 / 60))
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

  it('refuses two interactions at one instant on elements that do not overlap', () => {
    const events: RecordEvent[] = [
      { type: 'header', version: 1, fps: 60, seed: 1 },
    ]
    for (let tick = 0; tick <= 60; tick += 1) {
      events.push({ type: 'pointer', tick, x: 200, y: 400 })
    }
    // One 60Hz tick apart, and nowhere near each other: there is no framing
    // that answers both, so the renderer says so instead of picking a way-point
    // at one of the two clicks.
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
      /do not overlap/,
    )
    // The remedy has to be one the author can apply today: `hold` is the only
    // call in the wrapper that advances the log's clock without moving the
    // pointer (`src/record.ts:377-386`).
    expect(() => buildZoomSegments(toTimedEvents(events), format)).toThrow(
      /demo\.hold\(400\)/,
    )
  })
})

/**
 * Two interactions at one instant on one element.
 *
 * This is not an exotic log. `click()` writes its event at the tick the pointer
 * has reached and does not advance it (`src/record.ts:334-346`), and a move
 * onto a target the pointer already sits on generates no samples to advance it
 * with (`src/motion.ts:82`) — so a switch toggled twice, a counter pressed
 * twice, and `type(el, 'x')` followed by `click(el)` all produce two
 * interactions 0.0ms apart. Round three refused to render any of them, with a
 * message advising an option the CLI did not have.
 *
 * They are one shot: the camera frames the element and holds through both
 * events. The framing stays exactly what `frameBoundingBox` computes — for the
 * same element twice, from the very same box.
 */
describe('two interactions at one instant are one shot', () => {
  const format = resolveFormat(LANDSCAPE, CAPTURE)

  it('renders a switch toggled twice instead of refusing the recording', () => {
    const events = toTimedEvents(atCaptureScale(fixture('run-toggle-twice')))
    const interactions = events.filter(({ event }) => 'bbox' in event)
    expect(interactions.length).toBe(2)
    const [first, second] = interactions
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first === undefined || second === undefined) return
    // The premise: the wrapper really does log both at the same time.
    expect(second.timeMs - first.timeMs).toBe(0)

    const segments = buildZoomSegments(events, format)
    expect(segments.length).toBe(1)
    const shot = segments[0]
    expect(shot).toBeDefined()
    if (shot === undefined || !('bbox' in first.event)) return
    // Same element twice: the merged box *is* the logged box, so the framing is
    // bit for bit the one the criterion asks for.
    expect(shot.box).toEqual(first.event.bbox)
    expect(shot.target).toEqual(frameBoundingBox(first.event.bbox, format).rect)
    expect(cropAt(first.timeMs, segments, format)).toEqual(shot.target)
    expect(cropAt(second.timeMs, segments, format)).toEqual(shot.target)
    // And it is a hold, not a single frame: the shot keeps the element for the
    // full `minHoldMs` past the last of the two.
    expect(shot.endMs - shot.lastEventMs).toBeCloseTo(
      DEFAULT_ZOOM_LOOK.minHoldMs,
      6,
    )
  })

  it('frames both elements when a type and a click overlap', () => {
    const events = toTimedEvents(atCaptureScale(fixture('run-type-then-click')))
    const boxes = events
      .filter(({ event }) => 'bbox' in event)
      .map(({ event }) => ('bbox' in event ? event.bbox : undefined))
    expect(boxes.length).toBe(2)
    const [field, suggestion] = boxes
    expect(field).toBeDefined()
    expect(suggestion).toBeDefined()
    if (field === undefined || suggestion === undefined) return
    // Overlapping but not identical — the union is genuinely larger than both.
    expect(
      intersect(boxToRect(field), boxToRect(suggestion)).width,
    ).toBeGreaterThan(0)
    expect(field).not.toEqual(suggestion)

    const segments = buildZoomSegments(events, format)
    expect(segments.length).toBe(1)
    const shot = segments[0]
    expect(shot).toBeDefined()
    if (shot === undefined) return
    expect(shot.box.width).toBeGreaterThan(field.width)
    expect(shot.box.width).toBeGreaterThan(suggestion.width)
    expect(shot.target).toEqual(frameBoundingBox(shot.box, format).rect)
    for (const box of [field, suggestion]) {
      expect(contains(boxToRect(shot.box), boxToRect(box))).toBe(true)
      expect(contains(shot.target, boxToRect(box), 1)).toBe(true)
    }
  })

  it('holds one shot through both events instead of cutting between them', () => {
    const events = toTimedEvents(atCaptureScale(fixture('run-toggle-twice')))
    const segments = buildZoomSegments(events, format)
    const shot = segments[0]
    expect(shot).toBeDefined()
    if (shot === undefined) return
    const held: Rect[] = []
    for (let timeMs = shot.eventMs; timeMs < shot.endMs; timeMs += 1000 / 60) {
      held.push(cropAt(timeMs, segments, format))
    }
    expect(held.length).toBeGreaterThan(50)
    for (const crop of held) expect(crop).toEqual(shot.target)
  })
})

/**
 * The camera moves; it does not cut.
 *
 * Round three's suite could not tell the difference. Every assertion on the
 * crowded branch checked times and endpoints — where the shot starts, where it
 * ends, what it is framed on — and none of them looked at the motion in
 * between, so setting `zoomInMs = 0` on a crowded shot, which makes the camera
 * arrive by teleporting, left all 249 tests green. Measured on a pair 50ms
 * apart at opposite corners, that mutation moves the camera 658px in a single
 * frame: 95% of the journey, against 8.3px in the ordinary case.
 *
 * The threshold below is not a taste. `peakStepFraction` runs the very spring
 * `cropAt` interpolates along and returns how much of the path its busiest
 * frame covers — so a shot that is given its whole window matches the bound
 * exactly rather than fitting under it, and a shot with less time is allowed
 * proportionally more per frame because it has fewer frames, not because
 * anything was relaxed for it.
 */
describe('the camera never jumps', () => {
  const FRAME_MS = 1000 / 60
  const span = (a: Rect, b: Rect): number =>
    Math.max(
      Math.abs(a.x - b.x),
      Math.abs(a.y - b.y),
      Math.abs(a.width - b.width),
      Math.abs(a.height - b.height),
    )

  it('never covers more of a shot in one frame than the spring does, over the whole corpus', () => {
    let shots = 0
    let tightShots = 0
    let handedOver = 0
    let frames = 0
    let worst = 0
    for (const name of FIXTURES) {
      for (const spec of [LANDSCAPE, PORTRAIT, SQUARE]) {
        const format = resolveFormat(spec, CAPTURE)
        const segments = buildZoomSegments(
          toTimedEvents(atCaptureScale(fixture(name))),
          format,
        )
        for (const segment of segments) {
          const path = span(segment.from, segment.target)
          if (path <= 0) continue
          shots += 1
          const window = segment.eventMs - segment.startMs
          if (window < DEFAULT_ZOOM_LOOK.zoomInMs) tightShots += 1
          if (span(segment.from, format.base) > 0) handedOver += 1
          const limit = peakStepFraction(
            Math.min(DEFAULT_ZOOM_LOOK.zoomInMs, window),
            DEFAULT_ZOOM_LOOK.spring,
          )
          for (
            let timeMs = segment.startMs - FRAME_MS;
            timeMs < segment.eventMs;
            timeMs += FRAME_MS
          ) {
            const step = span(
              cropAt(timeMs, segments, format),
              cropAt(timeMs + FRAME_MS, segments, format),
            )
            frames += 1
            worst = Math.max(worst, step / path)
            expect(step / path).toBeLessThanOrEqual(limit * 1.001)
          }
        }
      }
    }
    // The denominators, absolute: how many shots were watched, how many of them
    // had less time for their approach than the look asks for, how many started
    // from where the camera already was rather than from the resting frame —
    // the crowded branch and the interrupted pull-out, the two this invariant
    // exists for — and how many frame-to-frame steps were measured in all.
    expect(shots).toBe(46)
    expect(tightShots).toBe(16)
    expect(handedOver).toBe(12)
    expect(frames).toBe(1586)
    expect(worst).toBeGreaterThan(0.15)
  })

  it('lets an ordinary approach take 9.2% of its path in its busiest frame', () => {
    // The number ordinary motion actually produces, written down: 650ms of
    // spring at 60Hz. Everything else in this block is measured against it.
    expect(
      peakStepFraction(DEFAULT_ZOOM_LOOK.zoomInMs, DEFAULT_ZOOM_LOOK.spring),
    ).toBeCloseTo(0.092, 3)
    // A shot with a fifth of the time is allowed more per frame, because it has
    // fewer frames — and still nothing like a cut.
    expect(peakStepFraction(130, DEFAULT_ZOOM_LOOK.spring)).toBeLessThan(0.5)
    // No duration at all is a cut, and the bound says so.
    expect(peakStepFraction(0, DEFAULT_ZOOM_LOOK.spring)).toBe(1)
  })

  it('would fail a shot that arrived by cutting, which is why it passes the ones that do not', () => {
    // The mutation applied by hand to the shots the shipped rule produces: the
    // crowded shot in `run-interior-taps` jumps to its framing instead of
    // travelling to it. Its own bound, unchanged, rejects it.
    const format = resolveFormat(LANDSCAPE, CAPTURE)
    const segments = buildZoomSegments(
      toTimedEvents(atCaptureScale(fixture('run-interior-taps'))),
      format,
    )
    const crowded = segments[1]
    expect(crowded).toBeDefined()
    if (crowded === undefined) return
    const cut: ZoomSegment[] = [
      segments[0] as ZoomSegment,
      { ...crowded, zoomInMs: 0 },
    ]
    const path = span(crowded.from, crowded.target)
    expect(path).toBeGreaterThan(100)
    const limit = peakStepFraction(
      Math.min(DEFAULT_ZOOM_LOOK.zoomInMs, crowded.eventMs - crowded.startMs),
      DEFAULT_ZOOM_LOOK.spring,
    )
    let worst = 0
    for (
      let timeMs = crowded.startMs - FRAME_MS;
      timeMs < crowded.eventMs;
      timeMs += FRAME_MS
    ) {
      worst = Math.max(
        worst,
        span(
          cropAt(timeMs, cut, format),
          cropAt(timeMs + FRAME_MS, cut, format),
        ) / path,
      )
    }
    expect(worst).toBeGreaterThan(0.9)
    expect(worst).toBeGreaterThan(limit * 1.001)
  })

  it('opens a shot from where the camera is, not from the resting frame', () => {
    // The other way a cut gets into a video, found by this invariant rather
    // than by watching: when a shot opens while the previous one's pull-out is
    // still running, treating the resting frame as its starting point teleports
    // the camera back to it for one frame. At a 1600ms gap — where the first
    // shot's hold ends exactly where the second's approach begins, so the
    // pull-out never runs at all — that was the whole journey, 640px, in one
    // frame.
    const format = resolveFormat(LANDSCAPE, CAPTURE)
    const events: RecordEvent[] = [
      { type: 'header', version: 1, fps: 60, seed: 1 },
    ]
    // A pointer that keeps moving, so the hold is exactly `minHoldMs` and the
    // gap lands in the window where the pull-out is interrupted.
    for (let tick = 0; tick <= 400; tick += 1) {
      events.push({ type: 'pointer', tick, x: 300 + tick * 5, y: 400 })
    }
    events.push({
      type: 'click',
      tick: 60,
      x: 600,
      y: 400,
      bbox: { x: 200, y: 380, width: 200, height: 80 },
    })
    events.push({
      type: 'click',
      tick: 156,
      x: 2300,
      y: 1200,
      bbox: { x: 2200, y: 1180, width: 200, height: 80 },
    })
    const segments = buildZoomSegments(toTimedEvents(events), format)
    expect(segments.length).toBe(2)
    const [first, second] = segments
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first === undefined || second === undefined) return
    expect(second.eventMs - first.eventMs).toBeCloseTo(1600, 6)
    expect(second.startMs).toBeGreaterThanOrEqual(first.endMs)
    expect(second.startMs).toBeLessThan(first.endMs + first.zoomOutMs)

    let worst = 0
    for (
      let timeMs = first.endMs - FRAME_MS;
      timeMs < second.eventMs;
      timeMs += FRAME_MS
    ) {
      worst = Math.max(
        worst,
        span(
          cropAt(timeMs, segments, format),
          cropAt(timeMs + FRAME_MS, segments, format),
        ),
      )
    }
    expect(worst).toBeLessThan(100)

    // The old rule, applied by hand to the same shots: a second shot that
    // believes the camera rests at the base rectangle.
    const fromBase = [first, { ...second, from: format.base }]
    let jumped = 0
    for (
      let timeMs = first.endMs - FRAME_MS;
      timeMs < second.eventMs;
      timeMs += FRAME_MS
    ) {
      jumped = Math.max(
        jumped,
        span(
          cropAt(timeMs, fromBase, format),
          cropAt(timeMs + FRAME_MS, fromBase, format),
        ),
      )
    }
    expect(jumped).toBeGreaterThan(300)
  })

  it('keeps its pace when the look asks for a much shorter approach', () => {
    // The bound is the look's, not a constant: a 130ms approach is allowed its
    // own, larger, per-frame share and is still a move rather than a cut. The
    // shot list builds — the guard inside `buildZoomSegments` measures the same
    // thing this file does and would refuse it otherwise.
    const format = resolveFormat(LANDSCAPE, CAPTURE)
    const events = toTimedEvents(atCaptureScale(fixture('run-interior-button')))
    const look = { zoomInMs: 130, zoomLeadMs: 200 }
    const segments = buildZoomSegments(events, format, look)
    const segment = segments[0]
    expect(segment).toBeDefined()
    if (segment === undefined) return
    const path = span(segment.from, segment.target)
    const limit = peakStepFraction(130, DEFAULT_ZOOM_LOOK.spring)
    let worst = 0
    for (
      let timeMs = segment.startMs - FRAME_MS;
      timeMs < segment.eventMs;
      timeMs += FRAME_MS
    ) {
      worst = Math.max(
        worst,
        span(
          cropAt(timeMs, segments, format, look),
          cropAt(timeMs + FRAME_MS, segments, format, look),
        ) / path,
      )
    }
    expect(worst).toBeGreaterThan(
      peakStepFraction(DEFAULT_ZOOM_LOOK.zoomInMs, DEFAULT_ZOOM_LOOK.spring),
    )
    expect(worst).toBeLessThanOrEqual(limit * 1.001)
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
