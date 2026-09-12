import type { BoundingBox } from '../record.js'

/** An axis-aligned rectangle in source-capture pixels. */
export type Rect = {
  height: number
  width: number
  x: number
  y: number
}

export type Size = { height: number; width: number }

export function rectRight(rect: Rect): number {
  return rect.x + rect.width
}

export function rectBottom(rect: Rect): number {
  return rect.y + rect.height
}

/** True when `outer` fully covers `inner`, within a sub-pixel tolerance. */
export function contains(outer: Rect, inner: Rect, tolerance = 1e-6): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    rectRight(inner) <= rectRight(outer) + tolerance &&
    rectBottom(inner) <= rectBottom(outer) + tolerance
  )
}

export function boxToRect(box: BoundingBox): Rect {
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

/** Component-wise interpolation. Used to run a rectangle along a spring curve. */
export function lerpRect(from: Rect, to: Rect, t: number): Rect {
  const u = 1 - t
  return {
    x: from.x * u + to.x * t,
    y: from.y * u + to.y * t,
    width: from.width * u + to.width * t,
    height: from.height * u + to.height * t,
  }
}

/**
 * The largest rectangle of the given aspect ratio that fits inside `source`.
 *
 * `anchor` decides where that rectangle sits when the ratio leaves slack in
 * one axis. The default is `top`, matching the decision already taken in
 * `src/assemble.ts`: a centred 16:9 crop of a 2560x1600 capture cuts 80px off
 * the top, and web app chrome — nav bars, toolbars — lives exactly there.
 */
export function baseRect(
  source: Size,
  aspect: number,
  anchor: 'center' | 'top' = 'top',
): Rect {
  let width = source.width
  let height = width / aspect
  if (height > source.height) {
    height = source.height
    width = height * aspect
  }
  const x = (source.width - width) / 2
  const y = anchor === 'top' ? 0 : (source.height - height) / 2
  return { x, y, width, height }
}

/**
 * Grows `rect` to the given aspect ratio around its own centre, never
 * shrinking either axis.
 */
export function expandToAspect(rect: Rect, aspect: number): Rect {
  let width = rect.width
  let height = rect.height
  if (width / height < aspect) {
    width = height * aspect
  } else {
    height = width / aspect
  }
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  return { x: centerX - width / 2, y: centerY - height / 2, width, height }
}

/** Slides `rect` (never resizing it) until it lies inside `bounds`. */
export function shiftInside(rect: Rect, bounds: Rect): Rect {
  let { x, y } = rect
  if (rect.width >= bounds.width) {
    x = bounds.x + (bounds.width - rect.width) / 2
  } else {
    x = Math.min(Math.max(x, bounds.x), rectRight(bounds) - rect.width)
  }
  if (rect.height >= bounds.height) {
    y = bounds.y + (bounds.height - rect.height) / 2
  } else {
    y = Math.min(Math.max(y, bounds.y), rectBottom(bounds) - rect.height)
  }
  return { x, y, width: rect.width, height: rect.height }
}

/** Pads a rectangle outwards by a fixed number of pixels on every side. */
export function padRect(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  }
}

/**
 * Rounds a crop to whole pixels without ever losing coverage: the rectangle
 * only grows, so anything it contained before rounding it still contains.
 * Whole even pixels, because a yuv420p chain wants them.
 *
 * `aspect`, when given, ties the two axes together instead of rounding each on
 * its own. Independent rounding lets the crop end up off-aspect by up to two
 * pixels, and an off-aspect crop in a chain that only ever crops and scales is
 * a non-uniform stretch — exactly the kind of quiet distortion this tool exists
 * not to have.
 *
 * Deriving the height from the rounded width is not enough on its own: both
 * axes have to land on even numbers, so the derived height is rounded up by up
 * to two pixels and the ratio moves with it. Measured worst case during a zoom
 * move, 1938x1092 instead of 16:9 — 0.17%, where the comment here used to claim
 * one part in two thousand, three and a half times better than the truth.
 *
 * So instead of rounding once, this searches the even sizes just above the
 * requested one and takes the pair closest to the ratio. For every ratio the
 * project ships there is an exact even pair within sixteen steps — 16:9 has one
 * every 32 pixels of width — so the search does not merely improve the error,
 * it removes it: measured over a sweep of 33 600 rectangles at four ratios, the
 * worst deviation is exactly zero (`tests/render/geometry.test.ts`).
 *
 * The price is field of view: finding that pair can widen a crop by up to 34
 * pixels, about 1.8% at 1920. That is the right way round for this tool. A
 * slightly wider crop is still a crop of the original, still contains
 * everything the unrounded rectangle did and still never magnifies; an
 * off-ratio crop is a non-uniform stretch of the picture, which is a quiet
 * distortion nobody can undo later.
 *
 * The one place the ratio still yields is the raster's own edge, where there is
 * nothing left to grow into — see the clamps below.
 */
export function roundOutward(
  rect: Rect,
  bounds: Rect,
  even = true,
  aspect?: number,
): Rect {
  const left = Math.floor(rect.x)
  const top = Math.floor(rect.y)
  let width = Math.ceil(rectRight(rect)) - left
  let height = Math.ceil(rectBottom(rect)) - top
  if (even) {
    width += width % 2
    height += height % 2
  }
  const evenUp = (value: number): number => {
    const ceiling = Math.ceil(value)
    return ceiling + (ceiling % 2)
  }
  const evenDown = (value: number): number => {
    const floor = Math.floor(value)
    return floor - (floor % 2)
  }
  if (aspect !== undefined && aspect > 0) {
    // Grow whichever axis is short of the ratio, never shrink either: the crop
    // must still contain everything the unrounded one did.
    const derived = evenUp(width / aspect)
    if (derived < height) width = evenUp(height * aspect)
    const leastWidth = width
    const leastHeight = height
    let bestError = Infinity
    for (let step = 0; step <= 16; step += 1) {
      const candidateWidth = leastWidth + step * 2
      for (const candidateHeight of [
        evenDown(candidateWidth / aspect),
        evenUp(candidateWidth / aspect),
      ]) {
        if (candidateHeight < leastHeight) continue
        const error = Math.abs(candidateWidth / candidateHeight - aspect)
        // Strictly better only, so the smallest rectangle wins a tie and the
        // search stays a pure function of its inputs.
        if (error >= bestError) continue
        bestError = error
        width = candidateWidth
        height = candidateHeight
      }
    }
  }
  const maxWidth = evenDown(bounds.width)
  const maxHeight = evenDown(bounds.height)
  if (width > maxWidth) {
    width = maxWidth
    if (aspect !== undefined && aspect > 0) height = evenUp(width / aspect)
  }
  if (height > maxHeight) {
    height = maxHeight
    // Past the raster's own edge there is nothing left to grow into, so the
    // ratio is honoured by giving the other axis back rather than by asking
    // for pixels that do not exist.
    if (aspect !== undefined && aspect > 0) {
      width = Math.min(maxWidth, evenDown(height * aspect))
    }
  }
  const x = Math.min(
    Math.max(left, Math.ceil(bounds.x)),
    Math.floor(rectRight(bounds)) - width,
  )
  const y = Math.min(
    Math.max(top, Math.ceil(bounds.y)),
    Math.floor(rectBottom(bounds)) - height,
  )
  return { x, y, width, height }
}
