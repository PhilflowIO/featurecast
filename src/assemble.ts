import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { validateCaptureManifest, type TimestampManifest } from './capture.js'

const OUTPUT_SIZE = { height: 1080, width: 1920 }
export const FRAME_RATE = 60

/**
 * The encoders this stage can drive. `libx264` runs on the CPU and stays the
 * default; the two NVENC entries hand the encode to the 3090's dedicated
 * encoder block.
 *
 * NVENC exists here because the measured CPU cost is the problem, not a
 * convenience: PLAN.md records 1 minute 45 for 8 seconds of 1080p60 through
 * the post-processing chain on CPU. It is nonetheless *not* the default, and
 * deliberately so — nobody has yet run M6's acceptance measurement ("die
 * Laufzeit fuer 30 Sekunden 1080p60 wird gemessen und notiert") or looked at
 * an NVENC-encoded result next to a libx264 one. Until that has happened,
 * the path whose output has actually been seen is the one that runs unless a
 * caller explicitly asks for the other.
 */
export const ENCODERS = ['libx264', 'h264_nvenc', 'hevc_nvenc'] as const

export type Encoder = (typeof ENCODERS)[number]

/** The encoder used unless a caller names another one. */
export const DEFAULT_ENCODER: Encoder = 'libx264'

/**
 * Constant-quality level handed to NVENC.
 *
 * This is the one number that has to be chosen rather than copied. The CPU
 * path passes no rate-control flag at all, so it runs libx264's own default:
 * constant quality at CRF 23 with no bitrate ceiling. NVENC's default is the
 * opposite kind of promise — a bitrate target — and a screencast of a dense
 * scrolling UI is exactly the material that target starves. `-rc vbr -cq 23
 * -b:v 0` restores the shape of the CPU path's promise (constant quality, no
 * ceiling; `-b:v 0` is required, since a non-zero bitrate overrides `-cq`)
 * and 23 mirrors the CRF the CPU path implicitly uses.
 *
 * What is *not* claimed: that CQ 23 and CRF 23 are perceptually equal. The
 * two scales belong to different encoders and the correspondence is
 * unmeasured here. That open question is the same reason `DEFAULT_ENCODER`
 * is still the CPU.
 */
const NVENC_CONSTANT_QUALITY = 23

/**
 * Resolves an encoder name from outside (CLI flag, config file) and refuses
 * anything else by name, the way `resolveDeviceDescriptor` does for device
 * presets: a typo that silently fell back to the CPU path would be found
 * only by noticing the encode took two minutes.
 */
export function resolveEncoder(name: string): Encoder {
  const match = ENCODERS.find((encoder) => encoder === name)
  if (match !== undefined) return match
  throw new Error(
    `Unknown encoder "${name}". Available: ${ENCODERS.join(', ')}`,
  )
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
  encoder: Encoder = DEFAULT_ENCODER,
): string[] {
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
    // The crop is anchored to the top (`0:0`), not centered (`0:80`): a
    // centered crop on a 2560x1600 capture removes 80px off both the top
    // and bottom, and most web app chrome (nav bars, in-content toolbars)
    // sits right at the top of the viewport — a centered crop sliced
    // straight through OnlyDash's grid toolbar row. Trimming only the
    // bottom 160px keeps whatever sits at y=0 fully intact. This assumes
    // app chrome lives at the top, which holds for OnlyDash and is a
    // reasonable default for arbitrary target apps, but is not universal;
    // PLAN.md's 2560x1600-with-1.33x-zoom-reserve default and
    // docs/DEVICES.md's already-16:9 2560x1440 desktop preset disagree on
    // whether to over-capture and crop at all — see docs/CAPTURE-CADENCE.md.
    `crop=2560:1440:0:0,scale=${OUTPUT_SIZE.width}:${OUTPUT_SIZE.height}:flags=lanczos:in_range=full:out_range=tv,fps=${FRAME_RATE},format=yuv420p`,
    '-c:v',
    encoder,
    // Rate control is spelled out only for NVENC, and only because its
    // default differs in kind from libx264's. Everything below this point —
    // the pixel format, the range tag, the frame rate, the hard duration
    // bound — is shared, and the colour handling in the filter chain above
    // (`in_range=full:out_range=tv`) runs before the encoder sees a pixel,
    // so both paths carry the identical colour promise.
    ...(encoder === 'libx264'
      ? []
      : ['-rc', 'vbr', '-cq', String(NVENC_CONSTANT_QUALITY), '-b:v', '0']),
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
  encoder: Encoder = DEFAULT_ENCODER,
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
    buildFfmpegArguments(timelinePath, outputPath, durationSeconds, encoder),
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
