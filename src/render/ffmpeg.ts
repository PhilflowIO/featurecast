import { join, resolve } from 'node:path'

import {
  DEFAULT_OUTPUT_QUALITY,
  encoderProfile,
  qualityNumber,
  type OutputQuality,
} from '../encoders.js'

import type { RenderPlan } from './plan.js'

import type { Size } from './geometry.js'

/**
 * Which encoder and at what quality — the same value the device layer carries
 * and the assemble stage already speaks.
 *
 * **This module used to name ffmpeg itself.** It exported its own
 * `DEFAULT_ENCODER` holding `videoCodec: 'libx264'` and `crf: 18`, against
 * `src/encoders.ts`'s `DEFAULT_ENCODER` of `'x264'` and a quality of 23 — the
 * same exported name, a different type, and two answers to one question. The
 * consequence was not cosmetic: `-crf` was written unconditionally, and NVENC
 * does not understand `-crf`. `--encoder nvenc-h264` would have been accepted
 * by the chain and produced a command the GPU rejects.
 *
 * `src/encoders.ts` states the house rule this now follows: featurecast's own
 * names in every interface, exactly one table at the boundary to ffmpeg, and
 * nothing else in the repository carrying an ffmpeg codec string.
 */
export type EncoderOptions = OutputQuality

export const DEFAULT_ENCODER: OutputQuality = DEFAULT_OUTPUT_QUALITY

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
 * `setparams` is what actually puts that conversion in the file. With a
 * `rawvideo`/`rgb24` input there is no colour description on the incoming
 * frames for `-color_range tv` to attach itself to, and the H.264 VUI comes out
 * empty: `ffprobe` reported `color_range=unknown, color_space=unknown` on every
 * video this milestone produced, while M1's output of the same material was
 * tagged. The pixels were right either way — measured, a per-frame fit of the
 * composed RGB against the decoded video gives slope 0.998-1.009 — but an
 * untagged `yuv420p` file is read as full range by anything that guesses, and
 * then the levels get stretched. Labelling the frames in the filter chain is
 * the fix; the output-side `-colorspace`/`-color_primaries` flags were measured
 * to tag only part of it on this ffmpeg, so the label belongs here. bt709 and
 * not M1's bt470bg: this is HD material, and bt470bg is what ffmpeg falls back
 * to when nobody says.
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
  quality: OutputQuality = DEFAULT_ENCODER,
): FfmpegPlan {
  const { field, value } = qualityNumber(quality)
  const profile = encoderProfile(quality.encoder)
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
      'scale=in_range=full:out_range=tv,format=yuv420p,' +
        'setparams=range=tv:colorspace=bt709:color_primaries=bt709:' +
        'color_trc=bt709',
      '-c:v',
      profile.ffmpegCodec,
      // Rate control spelled out per family, from the same table
      // `src/assemble.ts` reads. NVENC needs three flags rather than one:
      // its own default is a bitrate target, which a dense scrolling
      // screencast starves, and `-b:v 0` is load-bearing because a non-zero
      // bitrate overrides `-cq`. `-preset` is gone — `medium` was libx264's
      // own default, so saying it changed nothing, and on the NVENC path the
      // word means something else entirely.
      ...(profile.family === 'nvenc'
        ? ['-rc', 'vbr', `-${field}`, String(value), '-b:v', '0']
        : [`-${field}`, String(value)]),
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
