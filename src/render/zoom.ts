import type { BoundingBox } from '../record.js'

import type { TimedEvent } from './clock.js'
import type { ResolvedFormat } from './format.js'
import {
  boxToRect,
  expandToAspect,
  lerpRect,
  padRect,
  roundOutward,
  shiftInside,
  type Rect,
} from './geometry.js'
import { detectRestZones, restZoneAt, type PointerSample } from './rest.js'
import { relaxSpring, springEase, type SpringConfig } from './spring.js'

/** Event types that pull the camera in. All of them carry a bounding box. */
export type ZoomTrigger = 'click' | 'tap' | 'type'

export type ZoomLook = {
  /**
   * Ceiling on how tight a single element may be framed, independent of the
   * source's reserve. Keeps a 20x14px icon from filling the screen.
   */
  maxZoom?: number
  /** Milliseconds the camera holds at most after the interaction. */
  maxHoldMs?: number
  /** Milliseconds the camera holds at least after the interaction. */
  minHoldMs?: number
  /** Shortest pointer standstill that counts as "the moment is over". */
  minRestMs?: number
  /** Breathing room around the element, in source pixels. */
  paddingPx?: number
  /** Pointer displacement below which the pointer counts as standing still. */
  restThresholdPx?: number
  /** The spring the camera rides on the way in. */
  spring?: SpringConfig
  triggers?: readonly ZoomTrigger[]
  /**
   * Milliseconds the camera is given to arrive *before* the interaction.
   * It is deliberately not smaller than `zoomInMs`: the camera is asked to
   * have settled by the time the click lands, so the frame that shows the
   * click is exactly the framing computed for the element, not a way-point.
   */
  zoomInMs?: number
  zoomLeadMs?: number
  zoomOutMs?: number
}

type ResolvedLook = Required<Omit<ZoomLook, 'triggers'>> & {
  triggers: readonly ZoomTrigger[]
}

/**
 * Upstream's screen spring (tension 200, friction 40, mass 2.25). Its damping
 * ratio is ~0.943, so it is underdamped and does creep past its target near
 * the end of the transition — measured at 1.00017 of the way, just before the
 * window closes (`tests/render/spring.test.ts`). That is far too little to
 * see, but it is not zero, so `cropAt` clamps the curve to [0,1] rather than
 * relying on the shape. The clamp is the guarantee that the crop never
 * travels tighter than the framing computed to contain the element.
 */
export const DEFAULT_ZOOM_SPRING: SpringConfig = {
  friction: 40,
  mass: 2.25,
  tension: 200,
}

export const DEFAULT_ZOOM_LOOK: ResolvedLook = {
  maxZoom: 2.6,
  maxHoldMs: 2400,
  minHoldMs: 900,
  minRestMs: 400,
  paddingPx: 140,
  restThresholdPx: 2,
  spring: DEFAULT_ZOOM_SPRING,
  triggers: ['click', 'tap', 'type'],
  zoomInMs: 650,
  zoomLeadMs: 700,
  zoomOutMs: 900,
}

export function resolveLook(look: ZoomLook = {}): ResolvedLook {
  const merged = { ...DEFAULT_ZOOM_LOOK, ...look }
  if (merged.zoomLeadMs < merged.zoomInMs) {
    throw new Error(
      `zoomLeadMs (${merged.zoomLeadMs}) must be at least zoomInMs ` +
        `(${merged.zoomInMs}) so the camera has settled on the element by ` +
        'the time the interaction happens.',
    )
  }
  return merged
}

/** What the camera does around one interaction. */
export type ZoomSegment = {
  /**
   * The resting extent this shot is framed on. Normally one logged bounding
   * box; for a shot that answers several interactions at the same instant, the
   * union of theirs. `target` is `frameBoundingBox(box)` and nothing else, so
   * the acceptance criterion stays an equality rather than a containment.
   */
  box: BoundingBox
  /** Every limit this shot ran into, in plain words; carried into the plan. */
  clamps: readonly string[]
  /** Time of the interaction itself. */
  eventMs: number
  endMs: number
  /** The framing the camera comes *from*: the resting crop, or the previous target. */
  from: Rect
  /**
   * The last interaction this shot holds through. Equal to `eventMs` for every
   * ordinary shot; larger only when interactions at one instant were merged
   * into one shot, in which case the hold has to cover all of them.
   */
  lastEventMs: number
  startMs: number
  target: Rect
  trigger: ZoomTrigger
  zoomInMs: number
  zoomOutMs: number
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * The framing for one logged bounding box.
 *
 * The box is the element's *resting extent*: the geometry it spends most of its
 * time at, picked by dwell share out of an observation window upstream — not
 * its geometry in the frame the click happened to land on, and emphatically not
 * an average of its extremes. On an asymmetric animation an average is a size
 * the element is never at in any single frame; the most-dwelt box is the one a
 * viewer would call its size.
 *
 * So this function depends on nothing but the box, the format and the look: the
 * same box always yields the same rectangle, which is exactly why the crop
 * stands still while the element pulses. Never widen it from per-frame
 * observation, and never derive a framing by interpolating between two observed
 * extremes — the dwell-weighted choice upstream already did that work, and
 * doing it again here is what would put the breathing back.
 *
 * Zoom is a crop out of the original raster. The rectangle is therefore never
 * allowed below the output size; a request that would need more magnification
 * than the capture's reserve clamps, and says so.
 */
export function frameBoundingBox(
  box: BoundingBox,
  format: ResolvedFormat,
  look: ZoomLook = {},
): { clamp?: string; rect: Rect } {
  const resolved = resolveLook(look)
  const aspect = format.output.width / format.output.height
  const padded = expandToAspect(
    padRect(boxToRect(box), resolved.paddingPx),
    aspect,
  )

  const reserveFloor = format.output.width
  const lookFloor = format.base.width / resolved.maxZoom
  const floor = Math.max(reserveFloor, lookFloor)

  let clamp: string | undefined
  let width = padded.width
  if (width < reserveFloor) {
    const requested = format.base.width / width
    clamp =
      `${format.aspect}: framing ${Math.round(box.width)}x${Math.round(box.height)} ` +
      `at ${requested.toFixed(2)}x would need more than the ` +
      `${format.maxZoom.toFixed(2)}x the capture holds at full sharpness. ` +
      `Clamped to ${format.maxZoom.toFixed(2)}x — the picture is never blown up.`
  }
  width = Math.max(width, floor)
  width = Math.min(width, format.base.width)
  const height = Math.min(width / aspect, format.base.height)
  const centerX = padded.x + padded.width / 2
  const centerY = padded.y + padded.height / 2

  // Size is capped by the resting frame — that is the no-upscale rule. Position
  // is bounded by how much raster there is, which is a different and usually
  // larger rectangle. Conflating the two is what froze the portrait format.
  const placed = shiftInside(
    { x: centerX - width / 2, y: centerY - height / 2, width, height },
    format.panBounds,
  )
  return {
    rect: roundOutward(placed, format.panBounds, true, aspect),
    ...(clamp === undefined ? {} : { clamp }),
  }
}

/** Pointer samples on the millisecond clock, in log order. */
export function pointerSamples(events: readonly TimedEvent[]): PointerSample[] {
  const samples: PointerSample[] = []
  for (const { event, timeMs } of events) {
    if (event.type !== 'pointer') continue
    samples.push({ timeMs, x: event.x, y: event.y })
  }
  return samples
}

/** One frame at 60Hz, the rate this renderer is built around. */
const FRAME_MS = 1000 / 60

/**
 * The shortest stretch a shot may keep after its own interaction: one frame at
 * 60Hz, the rate this renderer is built around. It is not a look parameter and
 * must not become one — it is the numeric form of "the camera was there when it
 * was clicked", and a look that could set it to zero could switch the
 * milestone's acceptance criterion off.
 */
const ARRIVAL_FLOOR_MS = FRAME_MS

/** The smallest box containing both, in source pixels. */
function unionBox(a: BoundingBox, b: BoundingBox): BoundingBox {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

/** True when the two elements share screen area — the same element included. */
function boxesOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
  )
}

/**
 * Turns the event log into the camera's shot list.
 *
 * One segment per interaction. It opens `zoomLeadMs` before the interaction so
 * the camera has arrived when the click lands, and closes when the pointer has
 * come to rest — bounded below by `minHoldMs` so a fast script still shows the
 * result, and above by `maxHoldMs` so a long standstill does not hold the
 * close-up forever. Overlapping segments cut straight into one another rather
 * than pulling out and back in.
 *
 * **A segment never ends before its own event.** When two interactions crowd
 * each other — a second click less than `zoomLeadMs` after the first — one of
 * them has to give, and the choice of which is the whole point. Round two shut
 * the first shot down at the second shot's ideal start, which for a 433ms gap
 * is 267ms *before* the first click; `cropAt` then answered that click with a
 * way-point on the journey to the next element, and on two targets on opposite
 * sides of the viewport the clicked element was not in the picture at all.
 *
 * So the later shot yields instead. Its approach starts where the earlier shot
 * ends and covers the same ground faster, which is exactly what a camera
 * operator does when the action is quick, and it leaves the promise above
 * literally true: at every event the crop is the framing computed for that
 * event's element.
 *
 * **Two interactions at the same instant on one element are one shot.** The
 * event log has no spacing to give there: `click()` logs at the current tick
 * without advancing it (`src/record.ts:334-346`), and when the pointer already
 * sits on the target there is no travel to advance it either
 * (`src/motion.ts:82`), so a switch toggled twice, a counter pressed twice, or
 * `type(el, 'x')` followed by `click(el)` all arrive 0.0ms apart. That is not a
 * crowded pair of shots, it is one shot with two events in it: the camera
 * frames the element and holds through both. The shot's `box` becomes the union
 * of the merged boxes and `target` stays `frameBoundingBox(box)`, so the
 * acceptance criterion is still an equality against a framing this file
 * computed — for the ordinary case of the same element twice the union *is* the
 * box, bit for bit.
 *
 * What stays loud is the pair that no camera can answer: two interactions at
 * one instant on elements that do not overlap. There is no move, no framing and
 * no compromise that has the camera on both at once, so the run fails and names
 * the remedy the author can apply today.
 *
 * The zero-gap timing itself is a symptom of the event log's counted `tick`,
 * which issue #9 replaces with a reading of the capture clock. Nothing here
 * invents spacing to paper over that: the merge is decided on the logged
 * geometry — do the two elements overlap — and not on a time this file made up.
 */
export function buildZoomSegments(
  events: readonly TimedEvent[],
  format: ResolvedFormat,
  look: ZoomLook = {},
): ZoomSegment[] {
  const resolved = resolveLook(look)
  const triggers = new Set<string>(resolved.triggers)
  const restZones = detectRestZones(pointerSamples(events), {
    minRestMs: resolved.minRestMs,
    thresholdPx: resolved.restThresholdPx,
  })

  const segments: ZoomSegment[] = []
  for (const { event, timeMs } of events) {
    if (!triggers.has(event.type)) continue
    if (!('bbox' in event)) continue
    const framing = frameBoundingBox(event.bbox, format, resolved)
    const startMs = Math.max(0, timeMs - resolved.zoomLeadMs)
    // A lead cut short by the start of the recording shortens the travel with
    // it, so the camera still arrives on time instead of arriving late.
    const zoomInMs = Math.min(resolved.zoomInMs, timeMs - startMs)
    const rest = restZoneAt(restZones, timeMs, resolved.minRestMs)
    const restEnd = rest === undefined ? timeMs : rest.endMs
    const endMs = Math.min(
      Math.max(restEnd, timeMs + resolved.minHoldMs),
      timeMs + resolved.maxHoldMs,
    )
    segments.push({
      box: event.bbox,
      clamps: framing.clamp === undefined ? [] : [framing.clamp],
      eventMs: timeMs,
      endMs,
      from: format.base,
      lastEventMs: timeMs,
      startMs,
      target: framing.rect,
      trigger: event.type as ZoomTrigger,
      zoomInMs,
      zoomOutMs: resolved.zoomOutMs,
    })
  }

  segments.sort((a, b) => a.startMs - b.startMs || a.eventMs - b.eventMs)

  const kept: ZoomSegment[] = []
  for (const segment of segments) {
    const previous = kept.at(-1)
    if (previous === undefined) {
      kept.push(segment)
      continue
    }

    const gap = segment.eventMs - previous.lastEventMs
    if (gap < 2 * ARRIVAL_FLOOR_MS) {
      if (!boxesOverlap(previous.box, segment.box)) {
        throw new Error(
          `Two interactions ${gap.toFixed(1)}ms apart (at ` +
            `${previous.lastEventMs.toFixed(1)}ms and ` +
            `${segment.eventMs.toFixed(1)}ms) land on elements that do not ` +
            `overlap: ${describeBox(previous.box)} and ` +
            `${describeBox(segment.box)}. No camera is on both at the same ` +
            `instant, so there is no framing to compute and the renderer ` +
            `refuses rather than picking a way-point at one of the two. Put a ` +
            `beat between them in the script: \`await demo.hold(400)\` — the ` +
            `only call in the wrapper that advances the event log's clock on ` +
            `its own (\`src/record.ts:377-386\`) — and the camera has a move ` +
            `to make.`,
        )
      }
      mergeShots(previous, segment, format, resolved)
      continue
    }

    if (previous.endMs > segment.startMs) {
      // The later shot yields, never the earlier one's arrival: its approach
      // starts where the earlier shot ends and covers the same distance in
      // whatever time is left. The earlier shot keeps its own click plus one
      // frame — everything beyond that is hold, and hold is what gives way.
      previous.endMs = Math.min(
        previous.endMs,
        Math.max(segment.startMs, previous.lastEventMs + ARRIVAL_FLOOR_MS),
      )
      // Cut straight from one close-up to the next: no pull-out in between.
      segment.from = previous.target
      segment.startMs = Math.max(segment.startMs, previous.endMs)
      segment.zoomInMs = Math.min(
        segment.zoomInMs,
        segment.eventMs - segment.startMs,
      )
    }
    kept.push(segment)
  }

  return kept
}

function describeBox(box: BoundingBox): string {
  return (
    `${Math.round(box.width)}x${Math.round(box.height)} at ` +
    `(${Math.round(box.x)},${Math.round(box.y)})`
  )
}

/**
 * Two interactions at one instant on overlapping elements, folded into the
 * earlier shot: one framing, held through both events.
 */
function mergeShots(
  previous: ZoomSegment,
  segment: ZoomSegment,
  format: ResolvedFormat,
  look: ResolvedLook,
): void {
  const box = unionBox(previous.box, segment.box)
  const framing = frameBoundingBox(box, format, look)
  previous.box = box
  previous.target = framing.rect
  previous.clamps = framing.clamp === undefined ? [] : [framing.clamp]
  previous.lastEventMs = Math.max(previous.lastEventMs, segment.eventMs)
  // The hold is measured from the last of the merged events, so a `minHoldMs`
  // that could not be honoured around two events separately is honoured once
  // around the shot that contains them both.
  previous.endMs = Math.max(previous.endMs, segment.endMs)
}

/**
 * The crop rectangle at one moment, in source pixels.
 *
 * Pure: same time, same segments, same answer. The curve is the analytically
 * solved spring, so the result does not depend on what frame rate it is
 * sampled at — rendering at 60 and at 30 gives the same camera.
 */
export function cropAt(
  timeMs: number,
  segments: readonly ZoomSegment[],
  format: ResolvedFormat,
  look: ZoomLook = {},
): Rect {
  const resolved = resolveLook(look)
  const relax = relaxSpring(resolved.spring)

  let previous: ZoomSegment | undefined
  for (const segment of segments) {
    if (timeMs >= segment.startMs && timeMs < segment.endMs) {
      const progress =
        segment.zoomInMs <= 0
          ? 1
          : clamp01((timeMs - segment.startMs) / segment.zoomInMs)
      // Clamped to [0,1]: the crop may not travel past the framing that was
      // computed to contain the element, or an overshoot would crop into it.
      const ease = clamp01(springEase(progress, resolved.spring))
      return lerpRect(segment.from, segment.target, ease)
    }
    if (segment.endMs <= timeMs) previous = segment
  }

  if (previous === undefined) return format.base
  const progress =
    previous.zoomOutMs <= 0
      ? 1
      : clamp01((timeMs - previous.endMs) / previous.zoomOutMs)
  const ease = clamp01(springEase(progress, relax))
  return lerpRect(previous.target, format.base, ease)
}
