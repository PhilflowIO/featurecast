import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  CAPTURE_SIZE,
  validateCaptureManifest,
  type TimestampManifest,
} from './capture.js'
import {
  DEFAULT_OUTPUT_QUALITY,
  encoderProfile,
  qualityNumber,
  type OutputQuality,
} from './encoders.js'

export const FRAME_RATE = 60

/** A pixel rectangle. Both stages of the render are one of these. */
export type FrameSize = { height: number; width: number }

/**
 * What the encode is being asked for: the geometry it starts from, and the
 * geometry plus quality it must end at.
 *
 * `capture` is the recorded frame size (`ResolvedDevice.capture`) and
 * `output` is the encoded frame size and quality (`ResolvedDevice.output`),
 * so a resolved device can be handed here field for field. Before this
 * existed both were constants in this file and a device's output layer had
 * nowhere to go.
 */
export type EncodeTarget = {
  capture: FrameSize
  output: FrameSize & { quality: OutputQuality }
}

/**
 * What the pipeline rendered before the device layer could reach this stage:
 * M1's 2560x1600 capture, cropped to 16:9 and scaled to 1920x1080 on the CPU.
 * Kept as the default so callers that do not resolve a device — the M1
 * benchmark, every existing test — produce the identical command.
 */
export const DEFAULT_ENCODE_TARGET: EncodeTarget = {
  capture: CAPTURE_SIZE,
  output: { height: 1080, quality: DEFAULT_OUTPUT_QUALITY, width: 1920 },
}

/**
 * The crop that turns a captured frame into the output's aspect ratio,
 * before the scale to the output's pixel size. Never upscales on its own —
 * it only ever removes pixels — and both edges are rounded down to an even
 * number because yuv420p subsamples chroma by two.
 *
 * The vertical crop is anchored to the top (`y = 0`), not centered: a
 * centered crop on a 2560x1600 capture removes 80px off both the top and the
 * bottom, and most web app chrome (nav bars, in-content toolbars) sits right
 * at the top of the viewport — a centered crop sliced straight through
 * OnlyDash's grid toolbar row. Trimming only the bottom keeps whatever sits
 * at y=0 fully intact. This assumes app chrome lives at the top, which holds
 * for OnlyDash and is a reasonable default for arbitrary target apps, but is
 * not universal. A horizontal crop is centered instead, because the
 * left-and-right case has no equivalent "the important thing is at the edge"
 * argument and cutting one side only would shift the whole frame.
 */
export function cropRectangle(
  capture: FrameSize,
  output: FrameSize,
): { height: number; width: number; x: number; y: number } {
  const evenSize = (value: number): number =>
    Math.max(2, Math.floor(value / 2) * 2)
  const evenOffset = (value: number): number =>
    Math.max(0, Math.floor(value / 2) * 2)
  // Cross-multiplied rather than divided, so the comparison is exact for the
  // integer pixel sizes both sides actually are.
  const captureIsWider =
    capture.width * output.height > capture.height * output.width
  // The kept edge is evened first and the derived edge computed from the
  // evened value, so the aspect the scale filter receives is the aspect of
  // the rectangle ffmpeg is actually given.
  const height = captureIsWider
    ? evenSize(capture.height)
    : evenSize((evenSize(capture.width) * output.height) / output.width)
  const width = captureIsWider
    ? evenSize((height * output.width) / output.height)
    : evenSize(capture.width)
  return {
    height,
    width,
    x: evenOffset((capture.width - width) / 2),
    y: 0,
  }
}

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
) => Promise<void>

export type AssembleResult = {
  durationSeconds: number
}

/**
 * Duration attributed to each source frame in the ffconcat timeline, i.e.
 * how long it stays on screen before the next frame (or session end)
 * replaces it.
 *
 * Every duration here is strictly positive, and that is load-bearing rather
 * than incidental: a frame with a zero-length slot gets no `duration` line,
 * ffmpeg's concat demuxer steps straight past it, and its predecessor holds
 * for twice as long — a visible stutter, not a rounding detail. The
 * guarantee comes from `validateCaptureManifest`, which both entry points
 * into this file run first and which requires strictly increasing capture
 * timestamps. Repeating the check here would be unreachable code, so it is
 * deliberately not repeated; `tests/assemble.test.ts` pins the property from
 * the outside instead.
 *
 * `durations[0]` is anchored to `session.startedAt`, not to
 * `frames[0].timestamp`: the first frame typically arrives some
 * milliseconds after capture starts (nothing was paintable yet), and that
 * gap has to be credited to frame 0's dwell time — it is the only image
 * available for it. The previous version left this gap out of every
 * frame's duration entirely, so `finalDuration` (session span minus the sum
 * of inter-frame gaps) silently absorbed it onto the *last* frame instead,
 * i.e. the very first frame played too briefly and the tail played too
 * long by the same amount.
 */
function frameDurationsSeconds(
  frames: TimestampManifest['frames'],
  session: TimestampManifest['session'],
): number[] {
  const durations: number[] = []
  for (let index = 1; index < frames.length; index += 1) {
    const current = frames[index]
    const previous = frames[index - 1]
    if (current === undefined || previous === undefined) {
      throw new Error('unreachable: manifest frame array index out of bounds')
    }
    const previousStart =
      index === 1
        ? Math.min(session.startedAt, previous.timestamp)
        : previous.timestamp
    durations.push((current.timestamp - previousStart) / 1000)
  }
  return durations
}

/**
 * Creates an ffconcat input that retains the screencast's uneven source
 * timing. ffmpeg then samples it into a constant 60-fps output timeline.
 *
 * Frame paths are written as absolute paths. ffmpeg's concat demuxer
 * resolves relative entries against the *list file's own directory*, not
 * the process cwd — a relative `framesDirectory` (as used for a relative
 * `--out`) would otherwise get prefixed twice, e.g. `capture/frames/x.jpg`
 * listed from inside `capture/timeline.ffconcat` resolves to
 * `capture/capture/frames/x.jpg` and ffmpeg fails to open it.
 *
 * Each `file` entry also carries `option framerate 1000`. Without it the
 * mjpeg demuxer assumes 25 fps for every segment regardless of our
 * `duration` directive, quantizing frame boundaries to 40 ms ticks before
 * `fps=60` resamples them — reproduced with a synthetic 20-frame probe
 * (`/tmp 20250911 m1-verify/synth-probe.ts`): 8 of 20 source frames lost,
 * 12 of 36 output frames showing the wrong source frame, up to 110.7 ms of
 * content error. `option framerate 1000` gives each segment a 1 ms
 * timebase, fine enough for our millisecond-resolution durations; the same
 * probe with it applied shows 0 lost frames and 0 mismatches.
 */
export function buildCaptureTimeline(
  framesDirectory: string,
  manifest: TimestampManifest,
): string {
  validateCaptureManifest(manifest)
  const durations = frameDurationsSeconds(manifest.frames, manifest.session)
  const elapsed = durations.reduce((total, duration) => total + duration, 0)
  const finalDuration = Math.max(0, manifest.session.duration / 1000 - elapsed)
  const lines = ['ffconcat version 1.0']
  const lastFrame = manifest.frames.at(-1)
  if (lastFrame === undefined) {
    throw new Error('unreachable: validateCaptureManifest requires frames')
  }
  const framePath = (file: string): string =>
    resolve(join(framesDirectory, file)).replaceAll("'", "'\\\\''")

  for (const [index, frame] of manifest.frames.entries()) {
    lines.push(`file '${framePath(frame.file)}'`, 'option framerate 1000')
    const duration = durations[index] ?? finalDuration
    if (duration > 0) {
      lines.push(`duration ${duration}`)
    }
  }
  // The concat demuxer uses the final file's duration only when it is
  // repeated; `-t` on the ffmpeg command (not this repeat) is what actually
  // bounds the output, since this repeated entry has no `duration` of its
  // own and would otherwise let ffmpeg read a few extra frames past the end.
  lines.push(`file '${framePath(lastFrame.file)}'`, 'option framerate 1000')
  return `${lines.join('\n')}\n`
}

export function buildFfmpegArguments(
  timelinePath: string,
  outputPath: string,
  durationSeconds: number,
  target: EncodeTarget = DEFAULT_ENCODE_TARGET,
): string[] {
  const { encoder } = target.output.quality
  const { field, value } = qualityNumber(target.output.quality)
  const crop = cropRectangle(target.capture, target.output)
  return [
    '-hide_banner',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    timelinePath,
    '-vf',
    // mjpeg decodes full-range (yuvj420p/pc); `-pix_fmt yuv420p` alone only
    // relabels the pixel format without remapping levels, so playback that
    // assumes yuv420p's usual limited (tv) range reads crushed/washed-out
    // black and white points. `in_range=full:out_range=tv` on the scale
    // filter does the actual remap; `-color_range tv` below makes the
    // container metadata match what the pixels now are.
    //
    // Whether over-capturing and cropping is right at all is still open:
    // PLAN.md's 2560x1600-with-1.33x-zoom-reserve default and
    // docs/DEVICES.md's already-16:9 2560x1440 desktop preset disagree —
    // see docs/CAPTURE-CADENCE.md. This stage does not settle that; it
    // renders whatever capture and output geometry it is handed.
    `crop=${String(crop.width)}:${String(crop.height)}:${String(crop.x)}:${String(crop.y)},` +
      `scale=${String(target.output.width)}:${String(target.output.height)}` +
      `:flags=lanczos:in_range=full:out_range=tv,fps=${String(FRAME_RATE)},format=yuv420p`,
    '-c:v',
    encoderProfile(encoder).ffmpegCodec,
    // Rate control is spelled out on both paths now that the number comes
    // from the resolved device rather than from a constant here. `-crf 23`
    // is what libx264 was already doing implicitly, so the CPU output is
    // unchanged. NVENC needs three flags rather than one because its own
    // default is a different kind of promise — a bitrate target, which a
    // dense scrolling screencast starves; `-b:v 0` is load-bearing, since a
    // non-zero bitrate overrides `-cq`. Everything below this point — the
    // pixel format, the range tag, the frame rate, the hard duration bound —
    // is shared, and the colour handling in the filter chain above
    // (`in_range=full:out_range=tv`) runs before the encoder sees a pixel,
    // so both paths carry the identical colour promise.
    ...(encoderProfile(encoder).family === 'nvenc'
      ? ['-rc', 'vbr', `-${field}`, String(value), '-b:v', '0']
      : [`-${field}`, String(value)]),
    '-pix_fmt',
    'yuv420p',
    '-color_range',
    'tv',
    '-r',
    String(FRAME_RATE),
    // Bounds the encoded output to the manifest's own span. The ffconcat
    // demuxer's repeated trailing `file` line (needed so the true last
    // frame's `duration` is honored) otherwise lets ffmpeg read a few extra
    // frames past the intended end (measured: +3 frames without `-t`).
    '-t',
    String(durationSeconds),
    outputPath,
  ]
}

export async function assembleScreencast(
  captureDirectory: string,
  outputPath: string,
  runner: CommandRunner = runCommand,
  target: EncodeTarget = DEFAULT_ENCODE_TARGET,
): Promise<AssembleResult> {
  const manifest = JSON.parse(
    await readFile(join(captureDirectory, 'timestamps.json'), 'utf8'),
  ) as TimestampManifest
  validateCaptureManifest(manifest)
  const timelinePath = join(captureDirectory, 'timeline.ffconcat')
  await writeFile(
    timelinePath,
    buildCaptureTimeline(join(captureDirectory, 'frames'), manifest),
    { flag: 'wx' },
  )
  const durationSeconds = manifest.session.duration / 1000
  await runner(
    'ffmpeg',
    buildFfmpegArguments(timelinePath, outputPath, durationSeconds, target),
  )
  return { durationSeconds }
}

function runCommand(
  command: string,
  arguments_: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with code ${String(code)}`))
    })
  })
}
