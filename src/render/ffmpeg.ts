import { join, resolve } from 'node:path'

import type { RenderPlan } from './plan.js'

import type { Size } from './geometry.js'

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
 * The list of source frames to decode, in capture order, each exactly once.
 *
 * Two details are inherited from `buildCaptureTimeline` in `src/assemble.ts`:
 * paths are absolute, because the concat demuxer resolves relative entries
 * against the list file's own directory rather than the process cwd; and every
 * entry carries a duration, without which the demuxer hands the rawvideo muxer
 * non-monotonic timestamps and floods the log.
 *
 * What is *not* inherited is any notion of output timing. This list says
 * nothing about when a frame is shown or how long for. Retiming — idle
 * trimming included — happens in `sourceFrameForOutput`, in our own code, on
 * the same decision data the crops come from. There is exactly one mechanism
 * that decides what time it is, so there is nothing for a second one to
 * disagree with.
 */
export function buildSourceList(
  framesDirectory: string,
  plan: RenderPlan,
): string {
  if (plan.frames.length === 0) {
    throw new Error('Render plan contains no frames')
  }
  const lines = ['ffconcat version 1.0']
  for (const frame of plan.frames) {
    const file = resolve(join(framesDirectory, frame.file)).replaceAll(
      "'",
      "'\\\\''",
    )
    lines.push(`file '${file}'`, 'duration 1')
  }
  return `${lines.join('\n')}\n`
}

/**
 * Which source frame is on screen at each output frame.
 *
 * The plan already carries every source frame's output timestamp, with idle
 * stretches compressed. An output frame shows the last source frame whose
 * output time has arrived — a held frame simply repeats, a trimmed stretch
 * simply skips. The result is a non-decreasing index, which is what lets the
 * renderer stream the decoder once, forwards, without ever seeking.
 */
export function sourceFrameForOutput(plan: RenderPlan): Int32Array {
  const frameCount = Math.max(
    1,
    Math.round((plan.idle.outputDurationMs / 1000) * plan.fps),
  )
  const indices = new Int32Array(frameCount)
  let source = 0
  for (let n = 0; n < frameCount; n += 1) {
    const timeMs = (n * 1000) / plan.fps
    while (
      source + 1 < plan.frames.length &&
      (plan.frames[source + 1]?.outputMs ?? Infinity) <= timeMs
    ) {
      source += 1
    }
    indices[n] = source
  }
  return indices
}

export type FfmpegPlan = {
  arguments: string[]
  command: 'ffmpeg'
}

/**
 * The decoder: JPEG frames in, packed RGB out, one frame per file, in order.
 *
 * `-fps_mode passthrough` is what guarantees the one-to-one mapping; anything
 * that resamples the frame rate here would put ffmpeg back in charge of time.
 */
export function buildDecodePlan(listPath: string): FfmpegPlan {
  return {
    arguments: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    command: 'ffmpeg',
  }
}

/**
 * The encoder: finished frames in, one constant-rate video out.
 *
 * The frames arriving on stdin are already cropped, scaled and carry the
 * pointer, so there is no filter graph left to get wrong — only the colour
 * conversion. mjpeg decodes full-range, so the range remap belongs on the
 * scale filter; relabelling alone would crush blacks. Same reasoning as
 * `src/assemble.ts`.
 *
 * `-fflags +bitexact -flags +bitexact` keeps libavformat's version string out
 * of the container, so that two renders of the same decision data produce not
 * merely equivalent video but the identical file. That is the determinism
 * claim this milestone owes, and it is checkable with a hash.
 */
export function buildEncodePlan(
  output: Size,
  fps: number,
  outputPath: string,
  encoder: EncoderOptions = {},
): FfmpegPlan {
  const { crf, preset, videoCodec } = { ...DEFAULT_ENCODER, ...encoder }
  return {
    arguments: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${output.width}x${output.height}`,
      '-framerate',
      String(fps),
      '-i',
      '-',
      '-vf',
      'scale=in_range=full:out_range=tv,format=yuv420p',
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
      String(fps),
      '-fflags',
      '+bitexact',
      '-flags',
      '+bitexact',
      outputPath,
    ],
    command: 'ffmpeg',
  }
}
