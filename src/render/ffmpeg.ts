import { join, resolve } from 'node:path'

import type { FormatPlan, RenderPlan } from './plan.js'
import type { SpriteGeometry } from './sprite.js'

/** Where an invisible cursor is parked: far enough out to never clip in. */
const OFFSCREEN = -20000

export type EncoderOptions = {
  /** x264 constant-rate factor. Lower is better and bigger. */
  crf?: number
  preset?: string
  /** Encoder name. NVENC on the 3090 box is issue #7, not this milestone. */
  videoCodec?: string
}

export const DEFAULT_ENCODER: Required<EncoderOptions> = {
  crf: 18,
  preset: 'medium',
  videoCodec: 'libx264',
}

/**
 * The retimed frame list.
 *
 * Mirrors the two hard-won details documented on `buildCaptureTimeline` in
 * `src/assemble.ts`: paths are absolute, because the concat demuxer resolves
 * relative entries against the list file's own directory rather than the
 * process cwd; and every entry carries `option framerate 1000`, because
 * without it the mjpeg demuxer assumes 25 fps and quantises our
 * millisecond-resolution durations onto 40 ms boundaries.
 *
 * The durations come from the plan's *output* timestamps, so idle trimming is
 * already baked into this list — there is no second mechanism that could
 * disagree with the crop decisions about what time it is.
 */
export function buildRenderTimeline(
  framesDirectory: string,
  plan: RenderPlan,
): string {
  if (plan.frames.length === 0) {
    throw new Error('Render plan contains no frames')
  }
  const lines = ['ffconcat version 1.0']
  const escape = (file: string): string =>
    resolve(join(framesDirectory, file)).replaceAll("'", "'\\\\''")
  for (const [index, frame] of plan.frames.entries()) {
    lines.push(`file '${escape(frame.file)}'`, 'option framerate 1000')
    const next = plan.frames[index + 1]
    const end = next?.outputMs ?? plan.idle.outputDurationMs
    const duration = (end - frame.outputMs) / 1000
    if (duration > 0) lines.push(`duration ${duration}`)
  }
  const last = plan.frames[plan.frames.length - 1]
  if (last === undefined)
    throw new Error('unreachable: frame list is non-empty')
  lines.push(`file '${escape(last.file)}'`, 'option framerate 1000')
  return `${lines.join('\n')}\n`
}

/**
 * The per-frame geometry, as a command script for ffmpeg's `sendcmd`.
 *
 * `crop` and `overlay` both accept their geometry as runtime commands, so one
 * pass over the frames can carry a different crop rectangle and a different
 * cursor position on every single frame while the filter chain downstream
 * stays a fixed size. Only changed values are written, which is why a
 * recording without a single zoom produces a handful of lines instead of
 * thousands.
 */
export function buildGeometryCommands(
  format: FormatPlan,
  fps: number,
  sprite: SpriteGeometry | null,
): string {
  const lines: string[] = []
  let previous: string[] | null = null
  for (const frame of format.frames) {
    const commands = [
      `crop w ${frame.crop.width}`,
      `crop h ${frame.crop.height}`,
      `crop x ${frame.crop.x}`,
      `crop y ${frame.crop.y}`,
    ]
    if (sprite !== null) {
      const visible = frame.cursor !== null
      commands.push(
        `overlay x ${visible ? (frame.cursor?.screenX ?? 0) - sprite.hotspotX : OFFSCREEN}`,
        `overlay y ${visible ? (frame.cursor?.screenY ?? 0) - sprite.hotspotY : OFFSCREEN}`,
      )
    }
    const changed =
      previous === null
        ? commands
        : commands.filter((command, index) => command !== previous?.[index])
    previous = commands
    if (changed.length === 0) continue
    const start = (frame.n / fps).toFixed(6)
    const end = ((frame.n + 0.5) / fps).toFixed(6)
    lines.push(`${start}-${end} [enter] ${changed.join(', ')};`)
  }
  return `${lines.join('\n')}\n`
}

export type FfmpegPlan = {
  arguments: string[]
  command: 'ffmpeg'
}

/**
 * The encode for one format. One pass: retimed frames in, crop and scale
 * driven per frame, cursor composited on top, constant-rate video out.
 */
export function buildFfmpegPlan(
  format: FormatPlan,
  plan: RenderPlan,
  paths: {
    commands: string
    cursorPattern: string | null
    outputPath: string
    timeline: string
  },
  encoder: EncoderOptions = {},
): FfmpegPlan {
  const { crf, preset, videoCodec } = { ...DEFAULT_ENCODER, ...encoder }
  const chain = [
    `fps=${plan.fps}`,
    `sendcmd=f=${paths.commands}`,
    `crop=${format.base.width}:${format.base.height}:${format.base.x}:${format.base.y}`,
    // mjpeg decodes full-range; the range remap belongs on the scale filter,
    // relabelling alone would crush blacks. Same reasoning as src/assemble.ts.
    `scale=${format.output.width}:${format.output.height}:flags=lanczos:in_range=full:out_range=tv`,
  ]
  const filters: string[] = []
  const args = [
    '-hide_banner',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    paths.timeline,
  ]
  if (paths.cursorPattern === null) {
    filters.push(`[0:v]${chain.join(',')},format=yuv420p[v]`)
  } else {
    args.push(
      '-framerate',
      String(plan.fps),
      '-start_number',
      '0',
      '-i',
      paths.cursorPattern,
    )
    filters.push(
      `[0:v]${chain.join(',')}[base]`,
      `[base][1:v]overlay=x=${OFFSCREEN}:y=${OFFSCREEN}:eval=frame:format=auto,format=yuv420p[v]`,
    )
  }
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[v]',
    '-c:v',
    videoCodec,
    '-crf',
    String(crf),
    '-preset',
    preset,
    '-pix_fmt',
    'yuv420p',
    '-color_range',
    'tv',
    '-r',
    String(plan.fps),
    // The timeline repeats its last entry so the true final frame keeps its
    // duration; `-t` is what actually bounds the output.
    '-t',
    String(plan.idle.outputDurationMs / 1000),
    paths.outputPath,
  )
  return { arguments: args, command: 'ffmpeg' }
}
