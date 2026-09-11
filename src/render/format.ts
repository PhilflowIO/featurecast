import { baseRect, type Rect, type Size } from './geometry.js'

/** The three deliverables M4 owes from one raw recording. */
export type AspectName = '16:9' | '9:16' | '1:1'

export type FormatSpec = {
  aspect: AspectName
  /**
   * The size we would like to ship. It is a wish, not a promise: see
   * `resolveFormat`, which refuses to reach it by upscaling.
   */
  desired: Size
}

export const DEFAULT_FORMATS: readonly FormatSpec[] = [
  { aspect: '16:9', desired: { width: 1920, height: 1080 } },
  { aspect: '9:16', desired: { width: 1080, height: 1920 } },
  { aspect: '1:1', desired: { width: 1080, height: 1080 } },
]

export function aspectRatio(aspect: AspectName): number {
  switch (aspect) {
    case '16:9':
      return 16 / 9
    case '9:16':
      return 9 / 16
    case '1:1':
      return 1
  }
}

export type ResolvedFormat = {
  aspect: AspectName
  /** The resting crop: the whole picture, at this aspect ratio. */
  base: Rect
  /**
   * How much closer the camera may get before the crop would have to be
   * blown up: `base.width / output.width`. A 2560x1600 capture delivered at
   * 1920x1080 has 1.333 of it. Requests beyond this clamp and are reported.
   */
  maxZoom: number
  output: Size
  /**
   * Set when `desired` could not be met without upscaling, with the reason in
   * plain words. Never silently swallowed: the plan carries it and the CLI
   * prints it.
   */
  upscaleClamp?: string
}

function evenFloor(value: number): number {
  const floored = Math.floor(value)
  return floored - (floored % 2)
}

/**
 * Turns a wished-for format into one this source can actually deliver.
 *
 * Zoom is a crop out of the original raster, never a magnification — that is
 * the product rule from PLAN.md, and it has a consequence people skip: a
 * 2560x1600 desktop capture simply does not contain a sharp 1080x1920
 * portrait frame. The tallest 9:16 rectangle inside it is 900x1600. So the
 * resting crop is computed first, and the output is capped by it. The wish is
 * honoured when the source can pay for it and reported as clamped when it
 * cannot; it is never met by inventing pixels.
 */
export function resolveFormat(spec: FormatSpec, source: Size): ResolvedFormat {
  const aspect = aspectRatio(spec.aspect)
  const raw = baseRect(source, aspect)
  const base: Rect = {
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    width: evenFloor(raw.width),
    height: evenFloor(raw.height),
  }

  let width = evenFloor(spec.desired.width)
  let height = evenFloor(spec.desired.height)
  let upscaleClamp: string | undefined

  if (width > base.width || height > base.height) {
    const scale = Math.min(base.width / width, base.height / height)
    const clampedWidth = evenFloor(width * scale)
    const clampedHeight = evenFloor(clampedWidth / aspect)
    upscaleClamp =
      `${spec.aspect} was asked for ${width}x${height}, but the largest ` +
      `${spec.aspect} rectangle inside the ${source.width}x${source.height} ` +
      `capture is ${base.width}x${base.height}. Delivering ` +
      `${clampedWidth}x${clampedHeight} at full sharpness instead of ` +
      'upscaling. Record in this aspect ratio to get the requested size.'
    width = clampedWidth
    height = clampedHeight
  }

  return {
    aspect: spec.aspect,
    base,
    maxZoom: base.width / width,
    output: { width, height },
    ...(upscaleClamp === undefined ? {} : { upscaleClamp }),
  }
}
