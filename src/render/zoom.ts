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
  /** Set when the requested framing hit a limit; carried into the plan. */
  clamp?: string
  /** Time of the interaction itself. */
  eventMs: number
  endMs: number
  /** The framing the camera comes *from*: the resting crop, or the previous target. */
  from: Rect
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

/**
 * Turns the event log into the camera's shot list.
 *
 * One segment per interaction. It opens `zoomLeadMs` before the interaction so
 * the camera has arrived when the click lands, and closes when the pointer has
 * come to rest — bounded below by `minHoldMs` so a fast script still shows the
 * result, and above by `maxHoldMs` so a long standstill does not hold the
 * close-up forever. Overlapping segments cut straight into one another rather
 * than pulling out and back in.
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
      eventMs: timeMs,
      endMs,
      from: format.base,
      startMs,
      target: framing.rect,
      trigger: event.type as ZoomTrigger,
      zoomInMs,
      zoomOutMs: resolved.zoomOutMs,
      ...(framing.clamp === undefined ? {} : { clamp: framing.clamp }),
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
    if (previous.endMs > segment.startMs) {
      // Cut straight from one close-up to the next: no pull-out in between.
      previous.endMs = segment.startMs
      segment.from = previous.target
      segment.zoomInMs = Math.min(
        segment.zoomInMs,
        segment.eventMs - segment.startMs,
      )
    }
    if (previous.endMs <= previous.startMs) {
      // Fully swallowed by its successor; its own shot never happens.
      kept.pop()
      const earlier = kept.at(-1)
      segment.from = earlier?.target ?? format.base
    }
    kept.push(segment)
  }
  return kept
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
