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
 * the end of the transition — measured at 1.000138 of the way, at 99.965% of
 * the window (`tests/render/spring.test.ts`). That is far too little to
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
  // Refused, not clamped, and the choice is deliberate. A clamp would deliver a
  // camera that moves at a pace the caller did not ask for and would have to be
  // discovered in the rendered video; this is a look, not recorded material, so
  // there is no work to rescue and nothing is lost by saying no. The clamps this
  // renderer does apply — `frameBoundingBox`'s upscale clamp, the crowded hold —
  // all arise from material that already exists and cannot be re-recorded.
  for (const [name, value] of [
    ['zoomInMs', merged.zoomInMs],
    ['zoomOutMs', merged.zoomOutMs],
  ] as const) {
    if (value < MIN_TRAVEL_MS) {
      throw new Error(
        `${name} (${value}ms) is below the ${MIN_TRAVEL_MS.toFixed(1)}ms a ` +
          'camera move is never given less than. Thirteen frames at 60Hz is ' +
          'what the recorder itself can hold: no pointer journey it walks is ' +
          'shorter than fourteen (`src/motion.ts:92,305-306`), one of which ' +
          'the earlier shot keeps for its own event. Below it the camera ' +
          'arrives, or leaves, by cutting — a 50ms pull-out snaps back to the ' +
          'resting frame at the end of every shot. Ask for at least ' +
          `${MIN_TRAVEL_MS.toFixed(1)}ms.`,
      )
    }
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

/**
 * One frame at 60Hz — the grid this file measures motion on, deliberately fixed
 * while `plan.ts` accepts any output rate.
 *
 * It is a reference and not a parameter, and that is a decision rather than an
 * oversight: the shot list must not depend on the frame rate it will be sampled
 * at. `decisions.json` at 30fps and at 60fps describing the same camera is an
 * invariant this milestone already holds, and threading the output rate in here
 * — where it would move the hold floor and the approach floor — would end it.
 *
 * What the fixed grid owes in return is evidence that the promise survives a
 * coarser one, since a 30fps output frame covers two 60Hz steps. Measured over
 * the whole fixture corpus in three formats at 24, 25, 30, 50, 60 and 120fps:
 * 8880 frame-to-frame steps, worst 99.96% of the allowance for its own grid,
 * no cut anywhere (`tests/render/zoom.test.ts`, "never cuts at 24, 25, 30, 50,
 * 60 or 120 fps"). That share was 84.6% while the floor stood at eight frames;
 * raising the floor to thirteen tightened the allowance and the corpus now
 * brushes it, which is the intended shape and not a warning.
 */
const FRAME_MS = 1000 / 60

/**
 * The shortest stretch a shot may keep after its own interaction: one frame at
 * 60Hz, the rate this renderer is built around. It is not a look parameter and
 * must not become one — it is the numeric form of "the camera was there when it
 * was clicked", and a look that could set it to zero could switch the
 * milestone's acceptance criterion off.
 */
const ARRIVAL_FLOOR_MS = FRAME_MS

/**
 * The shortest stretch the camera may be given to travel a visible distance,
 * in either direction: thirteen frames at 60Hz.
 *
 * **The number comes from the recorder, not from this file's own curve.** A
 * bound a renderer picks for itself can always be argued down; this one cannot,
 * because it is what the material can hold. Every pointer journey the recorder
 * walks is at least fourteen 60Hz slots long: `travelDuration` is floored at
 * 220ms (`src/motion.ts:305-306`) and the sample count starts at
 * `ceil(220/1000 * 60)` = 14 (`src/motion.ts:92`), each sample consuming its
 * own tick (`src/record.ts:270-282`). So fourteen frames is the shortest gap
 * two interactions on two different elements can have, one of those frames
 * belongs to the earlier shot keeping its own element (`ARRIVAL_FLOOR_MS`), and
 * thirteen is what is left. A floor above that would refuse recordable work; a
 * floor below it buys nothing, because no log asks for it.
 *
 * Round five set it at eight frames and let the look pull it lower still —
 * `min(look.zoomInMs, floor)` — so a look with a 50ms `zoomInMs` got a 50ms
 * floor and the bound derived from it permitted 86% of a journey in one frame.
 * The floor is absolute now: a look that asks for less is refused in
 * `resolveLook` rather than quietly granted its own, smaller standard.
 *
 * What eight frames cost was not theoretical. At a 150ms gap the guard's worst
 * case was 36.7% of the journey in one frame; rendered, that is 201px then
 * 235px in consecutive frames where ordinary camera motion in the same material
 * is 8.3px — twenty-five times ordinary speed, which reads as a cut. No
 * recording can produce a 150ms gap across a visible distance, so the material
 * that case refuses is synthetic only.
 */
export const MIN_TRAVEL_MS = 13 * FRAME_MS

/**
 * A journey shorter than this is not a camera move, in source pixels.
 *
 * The smoothness bound below is a *fraction* of the journey, and a fraction of
 * nothing is a meaningless number: round four refused
 * `artifacts/m2-001/run-inner-scroll` in all three formats because a 7.1px
 * journey — a pull-out interrupted one frame in — was "covered entirely in one
 * frame". No viewer can see seven pixels of a 2560px raster move, so a purely
 * relative bound needs an absolute floor under it or it fails valid work.
 *
 * Sixteen source pixels is below the ±34px the aspect search in
 * `roundOutward` may already move a crop's width by (`geometry.ts:138-141`), so
 * a journey under it is inside the framing's own rounding noise. Measured over
 * the shipped corpus in all three formats: **it skips nothing at all**, and the
 * shortest journey it still guards is 66.3px. The 5.7, 7.1 and 9.2px journeys
 * this line was written for belonged to `run-b` and the two hand-written logs,
 * all three gone; the floor stays because the case it guards against is a
 * property of the framing's rounding, not of which logs happen to be checked
 * in this week.
 *
 * It is pinned from both sides in `tests/render/zoom.test.ts`: a 15.5px journey
 * covered in one frame passes and a 16.5px one fails, so lowering it to 8, 10
 * or 15 and raising it to 17 each break a test. Round five left it unpinned
 * from below — 8, 10 and 15 killed none of 165 tests.
 */
export const INVISIBLE_MOVE_PX = 16

/** The ∞-norm distance between two crops: the largest single-axis move. */
function rectSpan(a: Rect, b: Rect): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  )
}

/**
 * True when the two interactions landed on the very same rectangle.
 *
 * This is deliberately equality and not overlap. A shot that answers two events
 * at one instant is framed on *one* box, and the only box that is honestly both
 * of theirs is the one they share exactly — then `frameBoundingBox` of the
 * shot's box is `frameBoundingBox` of each event's box, bit for bit, and the
 * milestone's criterion stays an equality rather than a containment.
 *
 * Round four merged on overlap and framed the union. For an icon of 120x48
 * inside a page-filling backdrop the union is the page: the crop came out
 * 2560x1440 at 1.000x — the camera did not move at all — and the acceptance
 * test still passed, because it compared the crop against the self-generated
 * union while the clicked element only had to be *contained*, which a full
 * frame satisfies for free. Overlap is also not transitive, so three boxes in
 * one tick merged through a chain in which the third overlapped neither of the
 * first two.
 */
function boxesEqual(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  )
}

/**
 * How much of its journey the camera covers in the busiest single frame, as a
 * fraction of the whole journey, when it rides `spring` for `durationMs`.
 *
 * This is the pace of ordinary motion expressed as a number: it is computed
 * from the very curve `cropAt` interpolates along, so for an approach that is
 * given its full window it is not an allowance but an equality: the number the
 * bound permits and the number the motion produces are two evaluations of one
 * expression. `tests/render/zoom.test.ts` pins that on the shipped corpus,
 * whose worst step sits four parts in ten thousand under the bound. It is a
 * supremum over the phase of the frame grid, which the renderer does not
 * control: a segment may start anywhere between two output frames, so the
 * bound has to hold for every offset rather than for the one that happens to
 * line up with the segment's start.
 */
export function peakStepFraction(
  durationMs: number,
  spring: SpringConfig,
  frameMs: number = FRAME_MS,
): number {
  if (durationMs <= 0) return 1
  const samples = 2048
  let peak = 0
  for (let index = 0; index <= samples; index += 1) {
    const at = (index / samples) * durationMs
    const step =
      springEase(Math.min(1, (at + frameMs) / durationMs), spring) -
      springEase(Math.min(1, at / durationMs), spring)
    if (step > peak) peak = step
  }
  return Math.min(1, peak)
}

/**
 * The largest share of its journey the camera may cover in one 60Hz frame on
 * the way in, for a given look.
 *
 * **It is read off the floor, not off the shot being judged.** The shot list may
 * squeeze an approach — a second interaction inside the first shot's lead takes
 * time away from it — but never below `MIN_TRAVEL_MS`, so the fastest legitimate
 * approach is exactly the spring over thirteen frames and that is the number
 * here. Round four measured each shot against its own window, which is the same
 * quantity the interpolation used, and the comparison was an identity that
 * passed a 639.5px step across a 640px journey. Round five moved the reference
 * to a floor but let the look lower the floor, which is the same identity with
 * one more step in it.
 *
 * Stated as a multiple of ordinary motion: at the default look this is **2.943
 * times** the share the same spring covers in its busiest frame over the 650ms
 * approach the look actually configures (0.2714 against 0.0922). The multiple is
 * derived from the floor rather than chosen, so it cannot drift away from it;
 * both numbers are pinned to four places in `tests/render/zoom.test.ts`.
 */
export function approachStepFraction(look: ResolvedLook): number {
  return peakStepFraction(MIN_TRAVEL_MS, look.spring)
}

/**
 * The same bound for the way out, on the relaxed spring the pull-out rides.
 *
 * The pull-out is never squeezed — nothing in the shot list shortens it — so
 * unlike the approach it is judged against the duration the look configures
 * rather than against the floor, which makes this the tighter of the two. What
 * the floor does here is stop the bound from dissolving: round five formed the
 * seam allowance as `peakStepFraction(previous.zoomOutMs)` with no floor at all,
 * and since that function returns 1 for a non-positive duration, a look with
 * `zoomOutMs: 0` was allowed the entire journey in a single frame and the
 * renderer said nothing. Measured on `run-interior-button` at 16:9, a 640px
 * journey: 35.0px permitted at 900ms, 154.3px at 200ms, 472.3px at 50ms and
 * 640.0px at 0ms, every one of them accepted.
 */
export function pullOutStepFraction(look: ResolvedLook): number {
  return peakStepFraction(look.zoomOutMs, relaxSpring(look.spring))
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
 * **Two interactions at the same instant on the same element are one shot.**
 * The event log has no spacing to give there: `click()` logs at the current
 * tick without advancing it (`src/record.ts:388-398`), and when the pointer
 * already sits on the target there is no travel to advance it either
 * (`src/motion.ts:89`), so a switch toggled twice or a counter pressed twice
 * arrive 0.0ms apart. That is not a crowded pair of shots, it is one shot with
 * two events in it: the camera frames the element and holds through both. The
 * shot's `box` is unchanged by the merge, because the two boxes are equal — so
 * `target` is `frameBoundingBox` of each event's own box, bit for bit, and the
 * acceptance criterion stays an equality by construction.
 *
 * What stays loud is the pair that no camera can answer: two interactions at
 * one instant on *different* elements, overlapping or not. Round four merged
 * those too and framed the union, which for an icon inside a page-filling panel
 * is the whole page — a 2560x1440 crop at 1.000x, a zoom that does not move,
 * and an acceptance test that passed because it compared the crop against the
 * union it had generated itself. There is no move, no framing and no compromise
 * that has the camera on two different elements at once, so the run fails and
 * names the remedy the author can apply today.
 *
 * The zero-gap timing itself is a symptom of the event log's counted `tick`,
 * which issue #9 replaces with a reading of the capture clock. Nothing here
 * invents spacing to paper over that: the merge is decided on the logged
 * geometry — are the two boxes the same rectangle — and on a gap of exactly
 * zero, which is the artefact's own size rather than a tolerance this file
 * chose.
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
      // An interaction in the opening moments of a recording has less lead than
      // the look asks for, and below the approach floor there is no honest move
      // left to make. There is also nothing before it to cut away from, so the
      // video simply opens on the close-up rather than flicking towards it.
      if (segment.eventMs - segment.startMs < MIN_TRAVEL_MS) {
        segment.from = segment.target
        segment.zoomInMs = 0
      }
      kept.push(segment)
      continue
    }

    const gap = segment.eventMs - previous.lastEventMs
    // Exactly the same instant, and nothing wider. The zero-gap case is an
    // artefact of the event log's counted `tick`, which issue #9 replaces with
    // a reading of the capture clock; the bound is therefore the artefact's own
    // size and not a tolerance that might quietly swallow real spacing. Two
    // interactions one tick apart are two shots, and the crowded branch below
    // answers them.
    if (gap === 0) {
      if (!boxesEqual(previous.box, segment.box)) {
        throw new Error(
          `Two interactions at the same instant ` +
            `(${segment.eventMs.toFixed(1)}ms) land on different elements: ` +
            `${describeBox(previous.box)} and ${describeBox(segment.box)}. ` +
            `One shot is framed on one box; framing the two together would ` +
            `mean framing something neither of them is — for an icon inside a ` +
            `page-filling panel that is the whole page, a "zoom" that does not ` +
            `move. No camera is on both at the same instant, so the renderer ` +
            `refuses rather than picking a way-point at one of the two. Put a ` +
            `beat between them in the script: \`await demo.hold(400)\` — the ` +
            `only call in the wrapper that advances the event log's clock on ` +
            `its own (\`src/record.ts:431-441\`) — and the camera has a move ` +
            `to make.`,
        )
      }
      mergeShots(previous, segment)
      continue
    }

    if (previous.endMs > segment.startMs) {
      // Two shots that crowd each other share the gap between their events, and
      // both give way: the earlier shot's hold and the later shot's approach
      // are cut back in proportion to what each asked for, never below one
      // frame. Round three gave the whole gap to the approach, which left the
      // hold at 16.7ms in all eighteen measured cases and made `minHoldMs`
      // invisible — a 900ms setting that the shipped shot never showed.
      const floor = MIN_TRAVEL_MS
      const travels =
        rectSpan(previous.target, segment.target) > INVISIBLE_MOVE_PX
      if (travels && gap < ARRIVAL_FLOOR_MS + floor - 1e-9) {
        throw new Error(
          `Two interactions ${gap.toFixed(1)}ms apart (at ` +
            `${previous.lastEventMs.toFixed(1)}ms and ` +
            `${segment.eventMs.toFixed(1)}ms) on ` +
            `${describeBox(previous.box)} and ${describeBox(segment.box)} ` +
            `leave the camera no time to travel between them: the first shot ` +
            `must keep its own element for at least ` +
            `${ARRIVAL_FLOOR_MS.toFixed(1)}ms and the move to the second ` +
            `needs at least ${floor.toFixed(1)}ms, which is more than the gap ` +
            `the log gives. Crossing it anyway would be a cut, not a camera ` +
            `move. Put a beat between them in the script: ` +
            `\`await demo.hold(400)\` — the only call in the wrapper that ` +
            `advances the event log's clock on its own ` +
            `(\`src/record.ts:431-441\`).`,
        )
      }
      const hold = crowdedHoldMs(gap, resolved)
      if (hold < resolved.minHoldMs - 1e-9) {
        // Which of the two limits actually bound, named. Round five printed the
        // proportional sentence in both cases, so a log that read "held 17ms
        // instead of the 900ms asked for … in proportion to what each asked
        // for" described a 58% share of a 150ms gap that was in fact 11% — the
        // message was wrong for every gap under 317.9ms, which is most of them.
        const shared = proportionalHoldMs(gap, resolved)
        previous.clamps = [
          ...previous.clamps,
          `A shot was held ${hold.toFixed(0)}ms instead of the ` +
            `${resolved.minHoldMs.toFixed(0)}ms asked for: the next ` +
            `interaction follows ${gap.toFixed(0)}ms later, and ` +
            (hold < shared - 1e-9
              ? `the move to it may never be squeezed below ` +
                `${MIN_TRAVEL_MS.toFixed(0)}ms, which is what is left of the ` +
                `gap once the hold has had ${hold.toFixed(0)}ms of it`
              : `hold and approach share that gap in proportion to what each ` +
                `asked for, so the hold gets ` +
                `${((100 * hold) / gap).toFixed(0)}% of it`) +
            `. Record the two interactions further apart to see the full hold.`,
        ]
      }
      previous.endMs = Math.min(previous.endMs, previous.lastEventMs + hold)
      // Cut straight from one close-up to the next: no pull-out in between.
      segment.from = previous.target
      segment.startMs = Math.max(segment.startMs, previous.endMs)
      segment.zoomInMs = Math.min(
        segment.zoomInMs,
        segment.eventMs - segment.startMs,
      )
    } else if (segment.startMs < previous.endMs + previous.zoomOutMs) {
      // The pull-out is still running when the next shot opens. Starting that
      // shot from the resting frame would teleport the camera back to it for
      // one frame — measured 640px in a single frame at a 1600ms gap, where the
      // two shots abut exactly and the pull-out never runs at all. A shot
      // starts from wherever the camera actually is.
      segment.from = cropAt(segment.startMs, kept, format, resolved)
    }
    kept.push(segment)
  }

  assertSmoothApproach(kept, format, resolved)
  return kept
}

function describeRect(rect: Rect): string {
  return (
    `${Math.round(rect.width)}x${Math.round(rect.height)} at ` +
    `(${Math.round(rect.x)},${Math.round(rect.y)})`
  )
}

function describeBox(box: BoundingBox): string {
  return (
    `${Math.round(box.width)}x${Math.round(box.height)} at ` +
    `(${Math.round(box.x)},${Math.round(box.y)})`
  )
}

/**
 * Two interactions at one instant on the very same element, folded into the
 * earlier shot: one framing, held through both events.
 *
 * The boxes are equal, so there is nothing to recompute — the framing already
 * on the shot *is* the framing of the second event's box. That is the point of
 * merging on equality rather than on overlap: the acceptance criterion stays an
 * equality against `frameBoundingBox` of the logged box by construction,
 * instead of resting on an argument about unions.
 */
function mergeShots(previous: ZoomSegment, segment: ZoomSegment): void {
  previous.lastEventMs = Math.max(previous.lastEventMs, segment.eventMs)
  // The hold is measured from the last of the merged events, so a `minHoldMs`
  // that could not be honoured around two events separately is honoured once
  // around the shot that contains them both.
  previous.endMs = Math.max(previous.endMs, segment.endMs)
}

/**
 * What the two crowded shots would each like out of the `gap` between their
 * events, before the approach's floor is applied: everything the approach does
 * not need when the gap can pay for both wishes, and otherwise a split in
 * proportion to what each asked for — with the default look, 900ms of hold
 * against 650ms of approach, 58% of the gap to the hold.
 */
function proportionalHoldMs(gap: number, look: ResolvedLook): number {
  const wishes = look.minHoldMs + look.zoomInMs
  return gap >= wishes ? gap - look.zoomInMs : (gap * look.minHoldMs) / wishes
}

/**
 * How long the earlier of two crowded shots holds, out of the `gap` between the
 * two events.
 *
 * Two limits sit on top of the proportional split above, and which one binds
 * depends on the gap. The hold is floored at one frame, which keeps the earlier
 * shot alive through its own event. The approach is floored at `MIN_TRAVEL_MS`,
 * which is what keeps it from becoming a cut — and since that floor is taken out
 * of the same gap, it caps the hold at `gap - MIN_TRAVEL_MS`.
 *
 * **The cap binds for every gap below 516.7ms**, which is most crowded gaps:
 * with the default look the proportional share only drops under `gap - 216.7ms`
 * above that point. Measured on the corpus, `run-crowded-taps` at a 600ms gap
 * holds its proportional 348ms while `run-a` at 433ms is cut to 217ms by the
 * cap. The clamp the caller sees names whichever one bound; round five printed
 * the proportional sentence in both cases and was wrong in the commoner one.
 *
 * A gap that cannot pay for one frame of hold plus the floor is refused above
 * rather than split into a teleport.
 */
function crowdedHoldMs(gap: number, look: ResolvedLook): number {
  return Math.min(
    Math.max(proportionalHoldMs(gap, look), ARRIVAL_FLOOR_MS),
    Math.max(gap - MIN_TRAVEL_MS, ARRIVAL_FLOOR_MS),
  )
}

/**
 * The camera never jumps: in no single output frame does it cover more of a
 * shot's journey than the spring covers in its busiest frame over the shortest
 * approach the shot list is allowed to contain.
 *
 * **The bound does not read the quantity it judges.** Round four measured the
 * motion against `peakStepFraction(min(look.zoomInMs, window))` while `cropAt`
 * interpolated over `segment.zoomInMs`, which in the crowded branch *is* that
 * same number — the check compared the motion against itself and passed a
 * 639.5px step across a 640px journey. The reference here is
 * `MIN_TRAVEL_MS`, a constant the recorder fixes: a shot that crosses its path
 * faster than the spring would cross it in thirteen frames is a cut, whatever
 * its own `zoomInMs` claims. The window itself is asserted separately, so a
 * shot list that shortened the approach below the floor fails even where the
 * interpolation happens to look smooth.
 *
 * **The bound has an absolute floor under it.** A fraction of a journey too
 * small to see is not evidence of anything: `INVISIBLE_MOVE_PX` is where the
 * question stops being meaningful.
 *
 * **The seam is judged on its own terms.** Round four measured the step in the
 * frame *before* a shot against that shot's journey — but that frame belongs to
 * the previous shot pulling out, and the pull-out's pace has nothing to do with
 * how far the next shot has to travel. On `artifacts/m2-001/run-inner-scroll`,
 * two clicks on adjacent elements, the ratio was one frame of pull-out against
 * a 7.1px journey, and `pnpm render` died on all three formats. So the seam
 * gets two checks of its own instead: the shot must open exactly where the
 * camera already is, and the step across the seam may be no larger than the
 * pull-out configured by the look covers in its busiest frame.
 *
 * **The way out is checked too.** Round five guarded the approach and left the
 * pull-out to no check at all: `assertSmoothApproach` ran its frame loop from
 * `startMs` to `eventMs` only, so the frames after a shot's hold were watched by
 * nothing. `assertSmoothPullOut` below covers them.
 *
 * Everything is checked against the crops `cropAt` really produces, rather than
 * against the `zoomInMs` field — a guard that read the field back would pass
 * any value that field was given.
 *
 * **Which of these can fire on a list the builder produces, and which cannot.**
 * The opening equality, the seam bound and the two duration floors are all
 * reachable and tested from real material. The two frame loops are not: with
 * `resolveLook` refusing a `zoomInMs` or `zoomOutMs` under the floor and the
 * crowded branch capping the hold at `gap - MIN_TRAVEL_MS`, every window the
 * builder hands over is at least thirteen frames, and `lerpRect` is linear, so
 * the realised step is exactly the spring's own and can never exceed a bound
 * read off the floor. That is defence in depth and is kept deliberately: the
 * fields say what the builder *intended*, the loops measure what `cropAt`
 * actually draws, and those are different claims. A future change to the
 * stitching, to `lerpRect` or to the easing would be caught by the loops and by
 * nothing else. They are exercised from hand-built segment lists in
 * `tests/render/zoom.test.ts`, which is precisely the shape a builder bug takes.
 */
export function assertSmoothApproach(
  segments: readonly ZoomSegment[],
  format: ResolvedFormat,
  look: ResolvedLook,
): void {
  const floor = MIN_TRAVEL_MS
  const fraction = approachStepFraction(look)
  const outFraction = pullOutStepFraction(look)
  for (const [index, segment] of segments.entries()) {
    assertSmoothPullOut(segment, segments[index + 1], segments, format, look)

    // A journey too small to see is not evidence of anything, and neither is a
    // fraction of it. This is the absolute floor under a bound that is
    // otherwise purely relative.
    const path = rectSpan(segment.from, segment.target)
    if (path <= INVISIBLE_MOVE_PX) continue

    // The shot opens where the camera already is. This is an equality and not a
    // bound, and it is what catches the teleport: a shot given no approach at
    // all is at its target the instant it opens, while `from` says the camera
    // was somewhere else. The jump lives exactly on this boundary, so a check
    // that only watched the frames *inside* the shot would see a camera that
    // never moves and call it smooth.
    const opening = cropAt(segment.startMs, segments, format, look)
    if (rectSpan(opening, segment.from) > 1e-6) {
      throw new Error(
        `A shot opens at ${describeRect(opening)} while the camera it ` +
          `inherits is at ${describeRect(segment.from)}. It arrives by ` +
          `cutting: that is a cut, not a camera move.`,
      )
    }

    // The step across the seam, against the only motion allowed there — the
    // previous shot's pull-out, riding its own relaxed spring. Nothing before
    // time zero was ever rendered, so a shot that opens the recording has no
    // seam to cross.
    const previous = segments[index - 1]
    if (previous !== undefined && segment.startMs > 0) {
      const seam = rectSpan(
        cropAt(segment.startMs - FRAME_MS, segments, format, look),
        opening,
      )
      // The pull-out's pace comes from the look, not from `previous.zoomOutMs`.
      // They are the same number for every list the builder produces, and the
      // difference is the whole point: a shot list that shortened a pull-out is
      // judged against the pace the look configured, instead of against itself.
      const pullOut = rectSpan(previous.target, format.base) * outFraction
      if (seam > Math.max(INVISIBLE_MOVE_PX, pullOut * 1.001 + 1e-6)) {
        throw new Error(
          `The camera moves ${seam.toFixed(1)}px in the single frame where ` +
            `one shot hands over to the next at ` +
            `${segment.startMs.toFixed(1)}ms, against the ` +
            `${pullOut.toFixed(1)}px the previous shot's pull-out covers in ` +
            `its busiest frame. A shot starts from wherever the camera ` +
            `actually is; this one starts somewhere else.`,
        )
      }
    }

    const window = segment.eventMs - segment.startMs
    if (window < floor - 1e-9) {
      throw new Error(
        `A shot with ${path.toFixed(1)}px to travel was given ` +
          `${window.toFixed(1)}ms to travel it, below the ` +
          `${floor.toFixed(1)}ms floor. However smoothly that window is ` +
          `interpolated, the camera arrives by cutting.`,
      )
    }
    const limit = path * fraction
    for (
      let timeMs = segment.startMs;
      timeMs < segment.eventMs;
      timeMs += FRAME_MS
    ) {
      const step = rectSpan(
        cropAt(timeMs, segments, format, look),
        cropAt(timeMs + FRAME_MS, segments, format, look),
      )
      // A thousandth of slack for the sampled supremum in `peakStepFraction`,
      // which is a grid over a smooth curve and so sits a hair below the true
      // peak. Far too small to admit a cut: the mutation this catches moves
      // 100% of the path in one frame against a 27.1% allowance.
      if (step > limit * 1.001 + 1e-6) {
        throw new Error(
          `The camera would cover ${step.toFixed(1)}px of a ` +
            `${path.toFixed(1)}px journey in one frame at ` +
            `${timeMs.toFixed(1)}ms, against the ${limit.toFixed(1)}px the ` +
            `spring covers in its busiest frame over the ` +
            `${floor.toFixed(1)}ms an approach is never squeezed below. That ` +
            `is a cut, not a camera move.`,
        )
      }
    }
  }
}

/**
 * The same promise for the way home, over the frames between a shot's hold and
 * whatever comes next.
 *
 * The journey is the whole distance back to the resting frame, and the pace it
 * is judged against is the relaxed spring over the pull-out the *look*
 * configures — never over `segment.zoomOutMs`, which is the quantity the motion
 * is interpolated along. Round five formed the allowance from that field with no
 * floor beneath it, so shortening the pull-out raised its own permission in
 * step: at `zoomOutMs: 0` the field's `peakStepFraction` is 1 and the entire
 * journey in one frame was accepted in silence. In a finished video that is a
 * hard cut back to the wide shot at the end of every shot.
 *
 * The frames are sampled from the shot's end up to whichever comes first, the
 * pull-out finishing or the next shot opening. The single frame that straddles a
 * hand-over belongs to the seam and is judged there instead of twice.
 */
function assertSmoothPullOut(
  segment: ZoomSegment,
  next: ZoomSegment | undefined,
  segments: readonly ZoomSegment[],
  format: ResolvedFormat,
  look: ResolvedLook,
): void {
  const path = rectSpan(segment.target, format.base)
  if (path <= INVISIBLE_MOVE_PX) return

  if (segment.zoomOutMs < MIN_TRAVEL_MS - 1e-9) {
    throw new Error(
      `A shot with ${path.toFixed(1)}px to travel home was given ` +
        `${segment.zoomOutMs.toFixed(1)}ms to travel it, below the ` +
        `${MIN_TRAVEL_MS.toFixed(1)}ms floor. However smoothly that window is ` +
        `interpolated, the camera leaves by cutting.`,
    )
  }

  const limit = path * pullOutStepFraction(look)
  const until = Math.min(
    segment.endMs + segment.zoomOutMs,
    next?.startMs ?? Number.POSITIVE_INFINITY,
  )
  for (let timeMs = segment.endMs; timeMs < until; timeMs += FRAME_MS) {
    const step = rectSpan(
      cropAt(timeMs, segments, format, look),
      cropAt(Math.min(timeMs + FRAME_MS, until), segments, format, look),
    )
    if (step > limit * 1.001 + 1e-6) {
      throw new Error(
        `The camera would cover ${step.toFixed(1)}px of the ` +
          `${path.toFixed(1)}px journey back to the resting frame in one ` +
          `frame at ${timeMs.toFixed(1)}ms, against the ` +
          `${limit.toFixed(1)}px the relaxed spring covers in its busiest ` +
          `frame over the ${look.zoomOutMs.toFixed(1)}ms pull-out the look ` +
          `asks for. That is a cut, not a camera move.`,
      )
    }
  }
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
