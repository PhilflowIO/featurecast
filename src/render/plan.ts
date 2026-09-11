import type { RecordEvent } from '../record.js'

import { toTimedEvents, type ClockOptions, type TimedEvent } from './clock.js'
import {
  cursorAt,
  DEFAULT_CURSOR_LOOK,
  inferCursorKind,
  rippleStarts,
  type CursorKind,
  type CursorLook,
} from './cursor.js'
import {
  DEFAULT_FORMATS,
  resolveFormat,
  type AspectName,
  type FormatSpec,
  type ResolvedFormat,
} from './format.js'
import { roundOutward, type Rect, type Size } from './geometry.js'
import {
  buildTimeMapping,
  mapTime,
  type IdleOptions,
  type TimeMapping,
} from './idle.js'
import { pointerSamples } from './zoom.js'
import {
  buildZoomSegments,
  cropAt,
  resolveLook,
  type ZoomLook,
  type ZoomSegment,
} from './zoom.js'

export const PLAN_VERSION = 1

export type CaptureInput = {
  /** Frame file names in order, as written by `captureScreencast`. */
  frames: ReadonlyArray<{ file: string; timestamp: number }>
  sessionDurationMs: number
  /** Absolute start of the capture session; frame timestamps are on this clock. */
  sessionStartedAt: number
  source: Size
}

export type PlanOptions = {
  clock?: ClockOptions
  cursor?: CursorLook
  formats?: readonly FormatSpec[]
  fps?: number
  idle?: IdleOptions
  zoom?: ZoomLook
}

/** One rendered frame's whole decision: where to crop, what to draw. */
export type FrameDecision = {
  crop: Rect
  cursor: {
    kind: CursorKind
    /** Position inside the output frame, in output pixels. */
    screenX: number
    screenY: number
    /** 0..1 while a click ripple blooms, null otherwise. */
    ripplePhase: number | null
  } | null
  /** Output frame index. */
  n: number
  /** Output time in milliseconds. */
  timeMs: number
}

export type FormatPlan = {
  aspect: AspectName
  base: Rect
  /** Every framing request that hit the sharpness ceiling, in plain words. */
  clamps: readonly string[]
  frames: readonly FrameDecision[]
  maxZoom: number
  output: Size
  segments: readonly ZoomSegment[]
}

export type RenderPlan = {
  /** Source frames with their output timestamps, after idle trimming. */
  frames: ReadonlyArray<{ file: string; outputMs: number }>
  formats: readonly FormatPlan[]
  fps: number
  idle: {
    outputDurationMs: number
    removedMs: number
    trimmed: ReadonlyArray<{ endMs: number; startMs: number }>
  }
  source: Size
  version: typeof PLAN_VERSION
}

function interactionTimes(events: readonly TimedEvent[]): number[] {
  const times: number[] = []
  for (const { event, timeMs } of events) {
    if (
      event.type === 'click' ||
      event.type === 'tap' ||
      event.type === 'type'
    ) {
      times.push(timeMs)
    }
  }
  return times
}

function remapEvents(
  events: readonly TimedEvent[],
  mapping: TimeMapping,
): TimedEvent[] {
  return events.map((timed) => ({
    event: timed.event,
    timeMs: mapTime(mapping, timed.timeMs),
  }))
}

/**
 * The whole post-processing decision, as a pure function.
 *
 * Inputs are events that already carry a time in milliseconds and frame
 * timestamps in milliseconds; nothing here knows what a `tick` is. The output
 * is, per format, one crop rectangle and one cursor draw instruction per
 * output frame — the data an encoder needs and the data a test can check
 * exactly. No pixels are touched at this level, which is why changing a look
 * parameter costs a recomputation and not a browser run.
 */
export function planRender(
  capture: CaptureInput,
  events: readonly RecordEvent[],
  options: PlanOptions = {},
): RenderPlan {
  const fps = options.fps ?? 60
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Render fps must be positive, got ${fps}`)
  }
  const frameTimes = capture.frames.map(
    (frame) => frame.timestamp - capture.sessionStartedAt,
  )
  const timedEvents = toTimedEvents(events, options.clock)
  const mapping = buildTimeMapping(
    frameTimes,
    capture.sessionDurationMs,
    interactionTimes(timedEvents),
    options.idle,
  )
  // One clock for everybody: the same mapping bends the frames and the events,
  // so trimming cannot pull the two timelines apart.
  const outputEvents = remapEvents(timedEvents, mapping)
  const frames = capture.frames.map((frame, index) => ({
    file: frame.file,
    outputMs: mapTime(mapping, frameTimes[index] ?? 0),
  }))

  const cursorLook = {
    ...DEFAULT_CURSOR_LOOK,
    kind: inferCursorKind(outputEvents),
    ...options.cursor,
  }
  const zoomLook = resolveLook(options.zoom)
  const samples = pointerSamples(outputEvents)
  const ripples = rippleStarts(outputEvents)
  const frameCount = Math.max(
    1,
    Math.round((mapping.outputDurationMs / 1000) * fps),
  )

  const formats: FormatPlan[] = []
  for (const spec of options.formats ?? DEFAULT_FORMATS) {
    const format: ResolvedFormat = resolveFormat(spec, capture.source)
    const segments = buildZoomSegments(outputEvents, format, zoomLook)
    const clamps = new Set<string>()
    if (format.upscaleClamp !== undefined) clamps.add(format.upscaleClamp)
    for (const segment of segments) {
      if (segment.clamp !== undefined) clamps.add(segment.clamp)
    }

    const decisions: FrameDecision[] = []
    for (let n = 0; n < frameCount; n += 1) {
      const timeMs = (n * 1000) / fps
      const crop = roundOutward(
        cropAt(timeMs, segments, format, zoomLook),
        format.base,
      )
      const drawn = cursorAt(timeMs, samples, ripples, cursorLook)
      decisions.push({
        crop,
        cursor:
          drawn === undefined
            ? null
            : {
                kind: drawn.kind,
                ripplePhase: drawn.ripplePhase,
                screenX: Math.round(
                  ((drawn.x - crop.x) / crop.width) * format.output.width,
                ),
                screenY: Math.round(
                  ((drawn.y - crop.y) / crop.height) * format.output.height,
                ),
              },
        n,
        timeMs,
      })
    }

    formats.push({
      aspect: format.aspect,
      base: format.base,
      clamps: [...clamps],
      frames: decisions,
      maxZoom: format.maxZoom,
      output: format.output,
      segments,
    })
  }

  return {
    frames,
    formats,
    fps,
    idle: {
      outputDurationMs: mapping.outputDurationMs,
      removedMs: mapping.removedMs,
      trimmed: mapping.trimmed,
    },
    source: capture.source,
    version: PLAN_VERSION,
  }
}

/**
 * Canonical serialisation of the decision data: fixed key order, fixed number
 * formatting. Two renders of the same input produce byte-identical text, which
 * is the determinism claim that can actually be checked exactly — unlike the
 * encoded video, whose bytes an encoder is free to vary.
 */
export function serializePlan(plan: RenderPlan): string {
  const number = (value: number): number =>
    Number.isInteger(value) ? value : Number(value.toFixed(6))
  const rect = (value: Rect): Record<string, number> => ({
    x: number(value.x),
    y: number(value.y),
    width: number(value.width),
    height: number(value.height),
  })
  return `${JSON.stringify(
    {
      version: plan.version,
      fps: plan.fps,
      source: { width: plan.source.width, height: plan.source.height },
      idle: {
        outputDurationMs: number(plan.idle.outputDurationMs),
        removedMs: number(plan.idle.removedMs),
        trimmed: plan.idle.trimmed.map((gap) => ({
          startMs: number(gap.startMs),
          endMs: number(gap.endMs),
        })),
      },
      frames: plan.frames.map((frame) => ({
        file: frame.file,
        outputMs: number(frame.outputMs),
      })),
      formats: plan.formats.map((format) => ({
        aspect: format.aspect,
        output: { width: format.output.width, height: format.output.height },
        base: rect(format.base),
        maxZoom: number(format.maxZoom),
        clamps: [...format.clamps],
        segments: format.segments.map((segment) => ({
          trigger: segment.trigger,
          startMs: number(segment.startMs),
          eventMs: number(segment.eventMs),
          endMs: number(segment.endMs),
          zoomInMs: number(segment.zoomInMs),
          zoomOutMs: number(segment.zoomOutMs),
          from: rect(segment.from),
          target: rect(segment.target),
          clamp: segment.clamp ?? null,
        })),
        frames: format.frames.map((frame) => ({
          n: frame.n,
          timeMs: number(frame.timeMs),
          crop: rect(frame.crop),
          cursor:
            frame.cursor === null
              ? null
              : {
                  kind: frame.cursor.kind,
                  screenX: frame.cursor.screenX,
                  screenY: frame.cursor.screenY,
                  ripplePhase:
                    frame.cursor.ripplePhase === null
                      ? null
                      : number(frame.cursor.ripplePhase),
                },
        })),
      })),
    },
    null,
    2,
  )}\n`
}
