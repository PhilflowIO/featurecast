/**
 * Per-frame composition, in code we own.
 *
 * Round one drove `crop` and `overlay` through ffmpeg's `sendcmd`, one command
 * interval per output frame. That is not what `sendcmd` is: it is a sparse
 * command channel keyed on presentation timestamps, not a frame-accurate
 * animation track. Six byte-identical invocations over the same twelve-line
 * command file produced four distinct videos, each with two to four frames
 * framed at a neighbour's rectangle; widening the intervals and forcing
 * `-filter_threads 1` did not fix it. End to end, two renders of the same
 * sixty-frame input produced identical `decisions.json` and different `.mp4`s.
 *
 * So the geometry moved here. ffmpeg keeps decode, encode and timing — the jobs
 * it is good at — and loses per-frame geometry, the job it was unreliable at.
 * Everything in this file is a pure function of (source pixels, crop rectangle,
 * sprite, position): the same decision data cannot produce two different
 * pictures, because nothing between the decision and the pixel is free to vary.
 *
 * It is also where the product's hard rule now lives in testable code: the crop
 * is only ever read, never magnified beyond the output raster, and `resample`
 * refuses a crop that is smaller than the frame it has to fill.
 */

import type { Rect, Size } from './geometry.js'

/** A packed 8-bit RGB raster, row-major, no padding. */
export type Raster = {
  data: Uint8Array
  height: number
  width: number
}

/** A packed 8-bit RGBA raster with straight (non-premultiplied) alpha. */
export type RgbaRaster = {
  data: Uint8ClampedArray
  height: number
  width: number
}

export function createRaster(size: Size): Raster {
  return {
    data: new Uint8Array(size.width * size.height * 3),
    height: size.height,
    width: size.width,
  }
}

/** Bytes one decoded source frame occupies in the rawvideo stream. */
export function rasterByteLength(size: Size): number {
  return size.width * size.height * 3
}

function clampIndex(value: number, limit: number): number {
  if (value < 0) return 0
  if (value > limit) return limit
  return value
}

/**
 * Reads `crop` out of `source` and resamples it to fill `target`.
 *
 * Bilinear, separable in its weights: the horizontal tap positions depend only
 * on the crop and the target width, so they are computed once per frame rather
 * than once per pixel. The sampling grid is the standard half-pixel-centred
 * one, which makes the identity case (crop the size of the target) an exact
 * copy rather than a half-pixel smear.
 *
 * `rowStart` and `rowEnd` let one call fill a horizontal band of the frame
 * rather than all of it. Output rows are independent — each one reads the
 * source rows its own position maps to and nothing else — so splitting a frame
 * into bands across threads produces the same bytes as doing it in one go, for
 * any number of bands. That is what makes the parallel renderer's output
 * independent of how many cores it happened to run on.
 *
 * Refuses to magnify. A crop narrower or shorter than the target would have to
 * invent pixels, and inventing pixels is the one thing this tool does not do —
 * every other screen recorder gets that wrong. Callers never hit this: the
 * planner floors every crop at the output size. It is here so that a future
 * caller which forgets cannot quietly ship a blown-up frame.
 */
export function resample(
  source: Raster,
  crop: Rect,
  target: Raster,
  rowStart = 0,
  rowEnd = target.height,
): void {
  if (crop.width < target.width || crop.height < target.height) {
    throw new Error(
      `Crop ${crop.width}x${crop.height} is smaller than the ` +
        `${target.width}x${target.height} frame it has to fill; zoom is a ` +
        'crop out of the original raster, never an upscale.',
    )
  }
  if (
    crop.width === target.width &&
    crop.height === target.height &&
    Number.isInteger(crop.x) &&
    Number.isInteger(crop.y)
  ) {
    copyRows(source, crop, target, rowStart, rowEnd)
    return
  }
  const pixels = source.data
  const out = target.data
  const sourceStride = source.width * 3
  const lastColumn = source.width - 1
  const lastRow = source.height - 1
  const targetWidth = target.width

  // The horizontal tap positions depend only on the crop and the target width,
  // so they are computed once per frame instead of once per pixel.
  const columnLeft = new Int32Array(targetWidth)
  const columnRight = new Int32Array(targetWidth)
  const columnWeight = new Float64Array(targetWidth)
  const scaleX = crop.width / targetWidth
  for (let i = 0; i < targetWidth; i += 1) {
    const sx = crop.x + (i + 0.5) * scaleX - 0.5
    const left = Math.floor(sx)
    columnLeft[i] = clampIndex(left, lastColumn) * 3
    columnRight[i] = clampIndex(left + 1, lastColumn) * 3
    columnWeight[i] = sx - left
  }

  const scaleY = crop.height / target.height
  let write = rowStart * targetWidth * 3
  for (let j = rowStart; j < rowEnd; j += 1) {
    const sy = crop.y + (j + 0.5) * scaleY - 0.5
    const top = Math.floor(sy)
    const weightY = sy - top
    const rowTop = clampIndex(top, lastRow) * sourceStride
    const rowBottom = clampIndex(top + 1, lastRow) * sourceStride
    for (let i = 0; i < targetWidth; i += 1) {
      const weightX = columnWeight[i] as number
      const left = columnLeft[i] as number
      const right = columnRight[i] as number
      const topLeft = rowTop + left
      const topRight = rowTop + right
      const bottomLeft = rowBottom + left
      const bottomRight = rowBottom + right
      // The three channels are written out rather than looped: this is the
      // innermost loop of the whole renderer, run a few billion times on a
      // minute of video, and the loop itself measured a fifth of its cost.
      let a = pixels[topLeft] as number
      let b = pixels[topRight] as number
      let c = pixels[bottomLeft] as number
      let d = pixels[bottomRight] as number
      let upper = a + (b - a) * weightX
      let lower = c + (d - c) * weightX
      out[write] = Math.round(upper + (lower - upper) * weightY)

      a = pixels[topLeft + 1] as number
      b = pixels[topRight + 1] as number
      c = pixels[bottomLeft + 1] as number
      d = pixels[bottomRight + 1] as number
      upper = a + (b - a) * weightX
      lower = c + (d - c) * weightX
      out[write + 1] = Math.round(upper + (lower - upper) * weightY)

      a = pixels[topLeft + 2] as number
      b = pixels[topRight + 2] as number
      c = pixels[bottomLeft + 2] as number
      d = pixels[bottomRight + 2] as number
      upper = a + (b - a) * weightX
      lower = c + (d - c) * weightX
      out[write + 2] = Math.round(upper + (lower - upper) * weightY)
      write += 3
    }
  }
}

/**
 * The no-scale case: a crop already the size of the frame it fills is a copy,
 * row by row. It is not an optimisation detail but the normal case for a format
 * with no zoom reserve — the portrait deliverable pans across the raster at
 * 1:1 and never resamples at all, so it stays as sharp as the capture.
 */
function copyRows(
  source: Raster,
  crop: Rect,
  target: Raster,
  rowStart: number,
  rowEnd: number,
): void {
  const sourceStride = source.width * 3
  const targetStride = target.width * 3
  for (let j = rowStart; j < rowEnd; j += 1) {
    const from = (crop.y + j) * sourceStride + crop.x * 3
    target.data.set(
      source.data.subarray(from, from + targetStride),
      j * targetStride,
    )
  }
}

/**
 * Alpha-blends a sprite onto a frame at an integer position, clipped at every
 * edge. `x` and `y` are the sprite's top-left corner in output pixels; callers
 * subtract the hotspot themselves, because only they know which pixel of the
 * sprite is the pointer tip.
 */
export function compositeSprite(
  target: Raster,
  sprite: RgbaRaster,
  x: number,
  y: number,
): void {
  const startX = Math.max(0, -x)
  const startY = Math.max(0, -y)
  const endX = Math.min(sprite.width, target.width - x)
  const endY = Math.min(sprite.height, target.height - y)
  for (let sy = startY; sy < endY; sy += 1) {
    const targetRow = (y + sy) * target.width * 3
    const spriteRow = sy * sprite.width * 4
    for (let sx = startX; sx < endX; sx += 1) {
      const source = spriteRow + sx * 4
      const alpha = (sprite.data[source + 3] ?? 0) / 255
      if (alpha <= 0) continue
      const destination = targetRow + (x + sx) * 3
      for (let channel = 0; channel < 3; channel += 1) {
        const over = sprite.data[source + channel] ?? 0
        const under = target.data[destination + channel] ?? 0
        target.data[destination + channel] = Math.round(
          over * alpha + under * (1 - alpha),
        )
      }
    }
  }
}
