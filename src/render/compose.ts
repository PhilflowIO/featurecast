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

/** Lanczos' window half-width in kernel units: three lobes on each side. */
const LANCZOS_A = 3

/**
 * The Lanczos kernel: a sinc lobe windowed by a wider sinc.
 *
 * It is negative between its lobes, which is the point — the negative ring is
 * what puts the edge contrast back that any purely positive kernel (bilinear,
 * box, tent) averages away. The price is overshoot, so the caller clamps.
 */
function lanczosWeight(x: number): number {
  if (x === 0) return 1
  const magnitude = x < 0 ? -x : x
  if (magnitude >= LANCZOS_A) return 0
  const pi = Math.PI * x
  return (LANCZOS_A * Math.sin(pi) * Math.sin(pi / LANCZOS_A)) / (pi * pi)
}

/** One axis' sampling plan: where each output sample reads, and how much. */
type AxisTaps = {
  /** How many source samples every output sample reads. Constant per axis. */
  count: number
  /** The first source index each output sample reads, unclamped. */
  first: Int32Array
  /**
   * The weights, laid out tap-major: all output samples' weight for tap 0,
   * then all of them for tap 1, and so on. That is the order both passes walk
   * them in — one tap at a time across a whole row — which keeps the weight, a
   * single number, in a register while the reads run straight through memory.
   * The obvious sample-major layout measured three times slower.
   */
  weights: Float32Array
}

/**
 * Plans one axis once per frame.
 *
 * Two details carry the quality. The grid is half-pixel-centred, so a crop the
 * size of the target lands exactly on the source samples and the kernel reduces
 * to the identity rather than smearing by half a pixel. And the kernel is
 * *stretched by the scale factor* when the crop is larger than the target: at
 * 1.33x that widens the support from three source pixels to four, which is what
 * makes it a low-pass filter of the right width instead of a sharpening filter
 * applied to an aliased signal. This is what ffmpeg's own `lanczos` does, and
 * it is why the numbers here are comparable with `src/assemble.ts`.
 */
function planAxis(
  cropStart: number,
  cropSize: number,
  targetSize: number,
): AxisTaps {
  const scale = cropSize / targetSize
  const stretch = scale > 1 ? scale : 1
  const support = LANCZOS_A * stretch
  const count = Math.ceil(support * 2) + 1
  const first = new Int32Array(targetSize)
  const weights = new Float32Array(targetSize * count)
  const inverse = 1 / stretch
  const row = new Float64Array(count)
  for (let i = 0; i < targetSize; i += 1) {
    const center = cropStart + (i + 0.5) * scale - 0.5
    const start = Math.ceil(center - support)
    first[i] = start
    let sum = 0
    for (let k = 0; k < count; k += 1) {
      const weight = lanczosWeight((start + k - center) * inverse)
      row[k] = weight
      sum += weight
    }
    // Normalising is what keeps a flat area flat: the truncated, stretched
    // kernel does not sum to one on its own, and an unnormalised kernel shifts
    // the whole picture's brightness by a fraction of a level.
    const scaleBy = sum === 0 ? 1 : 1 / sum
    for (let k = 0; k < count; k += 1) {
      weights[k * targetSize + i] = (row[k] as number) * scaleBy
    }
  }
  return { count, first, weights }
}

function clampByte(value: number): number {
  const rounded = Math.round(value)
  if (rounded < 0) return 0
  if (rounded > 255) return 255
  return rounded
}

/**
 * Reads `crop` out of `source` and resamples it to fill `target`.
 *
 * Lanczos-3, separable, computed as two one-dimensional passes with a small
 * cache of horizontally filtered source rows. Separability is not a detail: the
 * kernel is nine taps wide on each axis at the capture's 1.33x reserve, so the
 * two-dimensional form would cost eighty-one multiplications per pixel where
 * this costs about twenty.
 *
 * **Why not the cheaper kernel it replaces.** The project records at 2560x1600
 * and delivers 1920x1080 for exactly one reason — that is the only way to get
 * sharp text — so the filter that performs that reduction is not an
 * implementation detail, it is the feature. Measured on four real capture
 * frames at the 1.33x reserve, the bilinear kernel this replaces scored 30.72dB
 * round-trip against Lanczos' 31.62dB, and a reviewer reading side-by-side text
 * crops called the difference "distinguishable in an A/B comparison". Round two
 * had quietly traded the milestone's own justification for arithmetic.
 *
 * `rowStart` and `rowEnd` let one call fill a horizontal band of the frame
 * rather than all of it. Output rows stay independent — each one reads the
 * source rows its own position maps to and nothing else, and the row cache is
 * local to the call — so splitting a frame into bands across threads produces
 * the same bytes as doing it in one go, for any number of bands. That is what
 * makes the parallel renderer's output independent of how many cores it
 * happened to run on.
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
    // Not an optimisation: the portrait deliverable has no zoom reserve at all,
    // so its crop is always the size of its frame. It must stay a true copy —
    // running it through any kernel, however good, would cost sharpness the
    // format cannot spare.
    copyRows(source, crop, target, rowStart, rowEnd)
    return
  }

  const pixels = source.data
  const out = target.data
  const sourceStride = source.width * 3
  const lastColumn = source.width - 1
  const lastRow = source.height - 1
  const targetWidth = target.width
  const targetStride = targetWidth * 3

  const horizontal = planAxis(crop.x, crop.width, targetWidth)
  const vertical = planAxis(crop.y, crop.height, target.height)

  // Where every horizontal tap reads, clamped at the raster's edges once per
  // frame rather than once per pixel per row.
  const columns = new Int32Array(horizontal.count * targetWidth)
  for (let k = 0; k < horizontal.count; k += 1) {
    const base = k * targetWidth
    for (let i = 0; i < targetWidth; i += 1) {
      let column = (horizontal.first[i] as number) + k
      if (column < 0) column = 0
      else if (column > lastColumn) column = lastColumn
      columns[base + i] = column * 3
    }
  }

  // Consecutive output rows overlap heavily — at 1.33x each source row feeds
  // several of them — so horizontally filtered rows are kept until they fall
  // out of the window. One slot more than the window is wide, so a row is never
  // evicted by the row that still needs it.
  const slots = vertical.count + 1
  const cache = new Float64Array(slots * targetStride)
  const cached = new Int32Array(slots).fill(-1)
  const slotOf = new Int32Array(vertical.count)
  const accumulator = new Float64Array(targetStride)

  const fillSlot = (sourceRow: number, slot: number): void => {
    const rowOffset = sourceRow * sourceStride
    const into = slot * targetStride
    cache.fill(0, into, into + targetStride)
    for (let k = 0; k < horizontal.count; k += 1) {
      const base = k * targetWidth
      let write = into
      for (let i = 0; i < targetWidth; i += 1) {
        const weight = horizontal.weights[base + i] as number
        const at = rowOffset + (columns[base + i] as number)
        cache[write] =
          (cache[write] as number) + weight * (pixels[at] as number)
        cache[write + 1] =
          (cache[write + 1] as number) + weight * (pixels[at + 1] as number)
        cache[write + 2] =
          (cache[write + 2] as number) + weight * (pixels[at + 2] as number)
        write += 3
      }
    }
  }

  let write = rowStart * targetStride
  for (let j = rowStart; j < rowEnd; j += 1) {
    const start = vertical.first[j] as number
    // Bring the rows this output row reads into the cache first, so the inner
    // loop below is pure arithmetic.
    for (let k = 0; k < vertical.count; k += 1) {
      let row = start + k
      if (row < 0) row = 0
      else if (row > lastRow) row = lastRow
      const slot = row % slots
      if (cached[slot] !== row) {
        fillSlot(row, slot)
        cached[slot] = row
      }
      slotOf[k] = slot * targetStride
    }
    accumulator.fill(0)
    for (let k = 0; k < vertical.count; k += 1) {
      const weight = vertical.weights[k * target.height + j] as number
      if (weight === 0) continue
      const base = slotOf[k] as number
      for (let x = 0; x < targetStride; x += 1) {
        accumulator[x] =
          (accumulator[x] as number) + weight * (cache[base + x] as number)
      }
    }
    for (let x = 0; x < targetStride; x += 1) {
      // Lanczos rings, so it overshoots at a hard edge. Clamping here is the
      // only place the kernel's output meets an 8-bit channel.
      out[write + x] = clampByte(accumulator[x] as number)
    }
    write += targetStride
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
