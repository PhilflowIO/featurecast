import {
  DEFAULT_OUTPUT_QUALITY,
  encoderProfile,
  qualityNumber,
  type OutputQuality,
} from '../encoders.js'
import type { VideoInfo } from '../probe.js'

import type { FfmpegPlan } from './ffmpeg.js'
import { shellGeometry, type Shell, type ShellKind } from './shell.js'

/**
 * The shot a product page opens with: the same application on a monitor, a
 * tablet and a phone at once, all three moving together.
 *
 * `compare` already puts videos side by side, but it builds a measurement
 * view — labelled bands, equal heights, a frame around each picture. This
 * builds the opposite: devices at their own relative sizes, overlapping,
 * standing on one line, against a plain background.
 *
 * featurecast is in an unusual position to produce it, because the three
 * recordings are three runs of *one* script, each filmed in its own device's
 * layout. The montage therefore shows an application that really is
 * responsive, not one desktop picture squeezed into three holes.
 */

export type MontagePiece = {
  kind: ShellKind
  path: string
}

export const MIN_PIECES = 2
export const MAX_PIECES = 4

/**
 * How tall each device stands relative to the tallest one in the picture.
 * A phone next to a monitor at equal height reads as a poster, not as a
 * product; these are roughly the ratios of the real objects on a desk.
 */
const RELATIVE_HEIGHT: Record<ShellKind, number> = {
  monitor: 1,
  laptop: 0.92,
  tablet: 0.62,
  phone: 0.46,
}

export const DEFAULT_HEIGHT = 1080
export const DEFAULT_OVERLAP = 0.08
/** Breathing room around the whole picture, as a fraction of its height. */
export const DEFAULT_MARGIN = 0.04
export const DEFAULT_FPS = 60
export const DEFAULT_BACKGROUND = 'white'

export type MontageOptions = {
  /** Solid background colour, or `transparent` for an alpha output. */
  background?: string
  fps?: number
  /** Output height in pixels; the tallest device fills most of it. */
  height?: number
  /** Space around the picture, as a fraction of its height. */
  margin?: number
  /** How far each device overlaps the one before it, as a fraction of its width. */
  overlap?: number
  quality?: OutputQuality
}

export type PlacedPiece = {
  kind: ShellKind
  path: string
  /** The shell, already scaled to its place in the picture. */
  shell: Shell
  /** Where the shell's top-left corner sits on the canvas. */
  x: number
  y: number
}

export type MontageLayout = {
  height: number
  pieces: readonly PlacedPiece[]
  /** The length every piece is trimmed to: the shortest recording. */
  seconds: number
  width: number
}

function even(value: number): number {
  const rounded = Math.round(value)
  return rounded % 2 === 0 ? rounded : rounded + 1
}

export function checkPieceCount(count: number): void {
  if (count < MIN_PIECES || count > MAX_PIECES) {
    throw new Error(
      `A montage holds ${String(MIN_PIECES)} to ${String(MAX_PIECES)} devices, got ${String(count)}.`,
    )
  }
}

/**
 * Sizes and places every device.
 *
 * The scale of a piece is decided by its shell height, not by its screen
 * height: a phone's bezel is a larger share of its body than a monitor's, and
 * scaling by screen alone would make the phone stand taller than it should.
 */
export function montageLayout(
  pieces: readonly MontagePiece[],
  probes: readonly VideoInfo[],
  options: MontageOptions = {},
): MontageLayout {
  checkPieceCount(pieces.length)
  if (probes.length !== pieces.length) {
    throw new Error(
      `Got ${String(probes.length)} probes for ${String(pieces.length)} devices.`,
    )
  }
  const height = options.height ?? DEFAULT_HEIGHT
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(
      `--height must be a positive number, got "${String(height)}".`,
    )
  }
  const overlap = options.overlap ?? DEFAULT_OVERLAP
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= 0.5) {
    throw new Error(
      `--overlap is a fraction below 0.5, got "${String(overlap)}".`,
    )
  }
  const marginFraction = options.margin ?? DEFAULT_MARGIN
  if (
    !Number.isFinite(marginFraction) ||
    marginFraction < 0 ||
    marginFraction >= 0.25
  ) {
    throw new Error(
      `--margin is a fraction below 0.25, got "${String(marginFraction)}".`,
    )
  }
  // The devices carry their own soft shadow, and a picture that ends at the
  // outermost pixel of a shadow reads as a crop rather than as a composition.
  const margin = Math.round(marginFraction * height)

  const tallest = Math.max(
    ...pieces.map((piece) => RELATIVE_HEIGHT[piece.kind]),
  )
  const unscaled = pieces.map((piece, index) => {
    const probe = probes[index]
    if (probe === undefined) {
      throw new Error(`No probe for ${piece.path}.`)
    }
    return shellGeometry(piece.kind, probe.width, probe.height)
  })

  // One pass to learn each shell's natural height, a second to scale it to
  // the share of the picture its kind is entitled to.
  const scaled = pieces.map((piece, index) => {
    const shell = unscaled[index]
    const probe = probes[index]
    if (shell === undefined || probe === undefined) {
      throw new Error(`No probe for ${piece.path}.`)
    }
    const share =
      (RELATIVE_HEIGHT[piece.kind] / tallest) * (height - margin * 2)
    const factor = share / shell.height
    return shellGeometry(
      piece.kind,
      even(probe.width * factor),
      even(probe.height * factor),
    )
  })

  const baseline = Math.max(...scaled.map((shell) => shell.height)) + margin
  let cursor = margin
  const placed: PlacedPiece[] = []
  for (const [index, piece] of pieces.entries()) {
    const shell = scaled[index]
    if (shell === undefined) continue
    placed.push({
      kind: piece.kind,
      path: piece.path,
      shell,
      x: Math.round(cursor),
      // One line to stand on: the tallest device defines the floor and every
      // other one rests on it, the way they would on a desk.
      y: Math.round(baseline - shell.height),
    })
    cursor += shell.width * (1 - overlap)
  }
  const last = placed.at(-1)
  const width = even(
    last === undefined ? 0 : last.x + last.shell.width + margin,
  )
  const seconds = Math.min(...probes.map((probe) => probe.durationSeconds))
  return { height: even(baseline + margin), pieces: placed, seconds, width }
}

/**
 * The filter graph. Each device is two overlays: its recording at the shell's
 * screen position, then the shell itself on top. The shell's screen area is
 * transparent, so the picture is never scaled twice and never covered.
 */
export function buildMontageFilter(
  layout: MontageLayout,
  options: MontageOptions = {},
): string {
  const background = options.background ?? DEFAULT_BACKGROUND
  const transparent = background === 'transparent'
  const steps: string[] = [
    `color=c=${transparent ? 'black@0.0' : background}:s=${String(layout.width)}x${String(layout.height)}:d=${layout.seconds.toFixed(3)}` +
      `${transparent ? ',format=rgba' : ''}[bg]`,
  ]
  let previous = 'bg'
  for (const [index, piece] of layout.pieces.entries()) {
    const screenX = piece.x + piece.shell.screen.x
    const screenY = piece.y + piece.shell.screen.y
    steps.push(
      `[${String(index)}:v]trim=duration=${layout.seconds.toFixed(3)},setpts=PTS-STARTPTS,` +
        `scale=${String(piece.shell.screen.width)}:${String(piece.shell.screen.height)}:flags=lanczos[v${String(index)}]`,
    )
    steps.push(
      `[${previous}][v${String(index)}]overlay=${String(screenX)}:${String(screenY)}:shortest=0[s${String(index)}]`,
    )
    steps.push(
      `[s${String(index)}][${String(layout.pieces.length + index)}:v]overlay=${String(piece.x)}:${String(piece.y)}[d${String(index)}]`,
    )
    previous = `d${String(index)}`
  }
  steps.push(`[${previous}]null[montage]`)
  return steps.join(';')
}

export function buildMontagePlan(
  layout: MontageLayout,
  shellPaths: readonly string[],
  outputPath: string,
  options: MontageOptions = {},
): FfmpegPlan {
  if (shellPaths.length !== layout.pieces.length) {
    throw new Error(
      `Got ${String(shellPaths.length)} shells for ${String(layout.pieces.length)} devices.`,
    )
  }
  const quality = options.quality ?? DEFAULT_OUTPUT_QUALITY
  const { field, value } = qualityNumber(quality)
  const profile = encoderProfile(quality.encoder)
  const fps = options.fps ?? DEFAULT_FPS
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`--fps must be a positive number, got "${String(fps)}".`)
  }
  const transparent =
    (options.background ?? DEFAULT_BACKGROUND) === 'transparent'
  return {
    arguments: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...layout.pieces.flatMap((piece) => ['-i', piece.path]),
      ...shellPaths.flatMap((path) => ['-i', path]),
      '-filter_complex',
      buildMontageFilter(layout, options),
      '-map',
      '[montage]',
      '-r',
      String(fps),
      // A transparent montage is for putting on someone else's background, so
      // it leaves as lossless alpha rather than as a colour-keyed guess.
      ...(transparent
        ? ['-c:v', 'qtrle', '-pix_fmt', 'argb']
        : [
            '-c:v',
            profile.ffmpegCodec,
            ...(profile.family === 'nvenc'
              ? ['-rc', 'vbr', `-${field}`, String(value), '-b:v', '0']
              : [`-${field}`, String(value)]),
            '-pix_fmt',
            'yuv420p',
          ]),
      '-an',
      outputPath,
    ],
    command: 'ffmpeg',
  }
}
