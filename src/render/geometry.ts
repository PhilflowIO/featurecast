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
 * ffmpeg's crop wants integers and even dimensions for yuv420p chains.
 */
export function roundOutward(rect: Rect, bounds: Rect, even = true): Rect {
  const left = Math.floor(rect.x)
  const top = Math.floor(rect.y)
  let width = Math.ceil(rectRight(rect)) - left
  let height = Math.ceil(rectBottom(rect)) - top
  if (even) {
    width += width % 2
    height += height % 2
  }
  const maxWidth = Math.floor(bounds.width) - (Math.floor(bounds.width) % 2)
  const maxHeight = Math.floor(bounds.height) - (Math.floor(bounds.height) % 2)
  width = Math.min(width, maxWidth)
  height = Math.min(height, maxHeight)
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
