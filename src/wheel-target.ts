import type { ViewportSize } from './record.js'

/** A box in viewport coordinates, the shape Playwright's `boundingBox()` returns. */
export type BoxRect = { height: number; width: number; x: number; y: number }

/** A wheel delivery point in viewport coordinates, rounded to whole pixels. */
export type WheelPoint = { x: number; y: number }

/**
 * Answers, for a whole batch of candidate points at once, whether a wheel
 * delivered there would reach the scroll target itself — i.e. whether the
 * element painting at that point is the target or a descendant of it *and*
 * nothing between the two is itself scrollable on the driven axis. One call
 * per batch, not per point, so every answer reads the same DOM snapshot.
 */
export type WheelPointProbe = (
  points: readonly WheelPoint[],
) => Promise<boolean[]>

/** How far, in px, a candidate sits inside the target's visible area. */
const WHEEL_PROBE_INSET_PX = 4

/**
 * Candidate points per axis. Five gives an outer ring at the inset, a
 * mid ring, and the center — enough spread that a nested scroller covering
 * everything but a margin still leaves eight candidates, while keeping the
 * single hit-test round trip at 25 points.
 */
const WHEEL_SAMPLES_PER_AXIS = 5

/**
 * The visible part of `box`: its intersection with the viewport, or `box`
 * itself when the viewport size is unknown (a headed context can report
 * `null`). Returns `null` when nothing of the box is on screen — there is
 * no point to deliver a wheel to in that case.
 *
 * Clipping matters because a scroll container is routinely taller than the
 * viewport: unclipped, the "bottom edge" candidates would sit below the fold,
 * where `document.elementFromPoint` returns `null` and a real wheel would go
 * nowhere.
 */
export function visibleRect(
  box: BoxRect,
  viewport: ViewportSize | null,
): { bottom: number; left: number; right: number; top: number } | null {
  const left = viewport === null ? box.x : Math.max(box.x, 0)
  const top = viewport === null ? box.y : Math.max(box.y, 0)
  const right =
    viewport === null
      ? box.x + box.width
      : Math.min(box.x + box.width, viewport.width)
  const bottom =
    viewport === null
      ? box.y + box.height
      : Math.min(box.y + box.height, viewport.height)
  if (right <= left || bottom <= top) return null
  return { bottom, left, right, top }
}

function positions(start: number, end: number, count: number): number[] {
  if (count <= 1) return [(start + end) / 2]
  const step = (end - start) / (count - 1)
  return Array.from({ length: count }, (_unused, index) => start + step * index)
}

/**
 * Deterministic candidate points inside the target's visible area, ordered
 * outermost ring first and the center *last*.
 *
 * The order is the whole point. A nested scroller (the recorded
 * application's `MuiDataGrid-virtualScroller`, ticket 47) sits in the middle
 * of its container and
 * leaves the container's own chrome and padding exposed around it, so the
 * border of the visible area is where a wheel most likely reaches the target
 * itself. The center is still a candidate — it is simply the last one tried,
 * and only ever used when the probe confirms nothing scrollable sits there.
 *
 * Ties inside a ring resolve row-major, and every coordinate is rounded, so
 * the same box and viewport always yield the same list in the same order.
 */
export function wheelCandidatePoints(
  box: BoxRect,
  viewport: ViewportSize | null,
): WheelPoint[] {
  const rect = visibleRect(box, viewport)
  if (rect === null) return []

  const inset = Math.min(
    WHEEL_PROBE_INSET_PX,
    (rect.right - rect.left) / 2,
    (rect.bottom - rect.top) / 2,
  )
  const xs = positions(
    rect.left + inset,
    rect.right - inset,
    WHEEL_SAMPLES_PER_AXIS,
  )
  const ys = positions(
    rect.top + inset,
    rect.bottom - inset,
    WHEEL_SAMPLES_PER_AXIS,
  )
  const middle = (WHEEL_SAMPLES_PER_AXIS - 1) / 2

  const ranked: { point: WheelPoint; ring: number }[] = []
  ys.forEach((y, row) => {
    xs.forEach((x, column) => {
      ranked.push({
        point: { x: Math.round(x), y: Math.round(y) },
        ring: Math.max(Math.abs(row - middle), Math.abs(column - middle)),
      })
    })
  })
  ranked.sort((left, right) => right.ring - left.ring)

  const seen = new Set<string>()
  const points: WheelPoint[] = []
  for (const { point } of ranked) {
    const key = `${String(point.x)}:${String(point.y)}`
    if (seen.has(key)) continue
    seen.add(key)
    points.push(point)
  }
  return points
}

/** The first candidate the probe reported as reaching the target, or `null`. */
export function firstClearPoint(
  points: readonly WheelPoint[],
  clear: readonly boolean[],
): WheelPoint | null {
  for (const [index, point] of points.entries()) {
    if (clear[index] === true) return point
  }
  return null
}

/**
 * Picks where to put the pointer before driving the wheel, and throws when no
 * candidate is free.
 *
 * Chromium binds a wheel gesture to the element under the pointer and does not
 * hand the rest of the gesture on to the ancestor once the inner element stops
 * short, so delivering a wheel on top of a nested scroller loses most of the
 * commanded distance. Measured on the box (ticket 47): with the pointer in the
 * center of the container, `invoices:scroll-up` was commanded 454px and
 * stopped at 91, `tasks:scroll-up` at 3 instead of 0, while every other
 * scrollable element on the page stood at 0 afterwards — the pixels never
 * arrived anywhere. With the pointer clear of the inner scroller, every window
 * landed exactly (`invoices` 456 -> 0, `tasks` 590 -> 0, `users` 188 -> 0, in
 * both repeats).
 *
 * Throwing is deliberate. Falling back to the center would restore exactly the
 * silent shortfall this exists to end, and a benchmark that quietly travels a
 * fifth of the distance it reports is worse than one that stops.
 */
export async function chooseWheelPoint(
  box: BoxRect,
  viewport: ViewportSize | null,
  probe: WheelPointProbe,
  context: { axis: 'x' | 'y'; description: string },
): Promise<WheelPoint> {
  const points = wheelCandidatePoints(box, viewport)
  if (points.length === 0) {
    throw new Error(
      `chooseWheelPoint: (${context.axis}) ${context.description} has no ` +
        'visible area to deliver a wheel to',
    )
  }
  const clear = await probe(points)
  const point = firstClearPoint(points, clear)
  if (point === null) {
    throw new Error(
      `chooseWheelPoint: (${context.axis}) every one of the ` +
        `${String(points.length)} candidate points on ${context.description} ` +
        'is covered by another scrollable element; a wheel there would be ' +
        'captured by that inner scroller instead of moving the target (ticket 47)',
    )
  }
  return point
}
