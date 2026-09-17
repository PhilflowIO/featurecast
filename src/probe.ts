import { spawn } from 'node:child_process'

import { FRAME_RATE } from './assemble.js'

/**
 * Tolerance for the assembled video's reported duration versus the
 * manifest span, and for its frame count versus `duration * FRAME_RATE`.
 *
 * A 2% relative tolerance used to live here to absorb drift from the
 * mjpeg demuxer's default 25 fps timebase quantizing our ffconcat
 * `duration` directives. That quantization is now fixed at the source
 * (`option framerate 1000` per entry in `buildCaptureTimeline`, plus `-t`
 * bounding the encoded output in `buildFfmpegArguments`) — a synthetic
 * 20-frame probe with both applied shows 0 lost frames and 0 mismatches,
 * so a ±1-frame tolerance is tight enough without hiding the class of bug
 * a looser one would: a demuxer/timebase regression that drops or
 * duplicates real source frames while still landing within a percentage
 * window of the total duration.
 */
const DURATION_TOLERANCE_SECONDS = 1 / FRAME_RATE
const FRAME_COUNT_TOLERANCE = 1

export type CommandOutputRunner = (
  command: string,
  arguments_: readonly string[],
) => Promise<string>

type OutputProbeStream = {
  avg_frame_rate?: unknown
  duration?: unknown
  height?: unknown
  nb_frames?: unknown
  r_frame_rate?: unknown
  width?: unknown
}

type OutputProbe = {
  streams?: OutputProbeStream[]
}

export function buildFfprobeArguments(videoPath: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration',
    '-of',
    'json',
    videoPath,
  ]
}

/**
 * Validates the JSON emitted by the exact ffprobe command above against the
 * capture's own manifest span. `nb_frames > 0` alone previously accepted an
 * 83 ms clip; this also requires the reported duration to match the
 * recorded window within a tight tolerance and the frame count to match a
 * genuinely constant 60 fps encode of that duration.
 */
export function validateOutputProbe(
  probe: OutputProbe,
  expectedDurationSeconds: number,
): void {
  const stream = probe.streams?.[0]
  if (stream === undefined) {
    throw new Error('Output probe must contain a video stream')
  }
  if (stream.width !== 1920 || stream.height !== 1080) {
    throw new Error('Output probe must report a 1920x1080 video stream')
  }
  if (stream.avg_frame_rate !== '60/1' || stream.r_frame_rate !== '60/1') {
    throw new Error('Output probe must report a constant 60 fps stream')
  }
  if (typeof stream.nb_frames !== 'string' || Number(stream.nb_frames) <= 0) {
    throw new Error('Output probe must report a positive frame count')
  }
  if (typeof stream.duration !== 'string') {
    throw new Error('Output probe must report a stream duration')
  }
  const durationSeconds = Number(stream.duration)
  if (!Number.isFinite(durationSeconds)) {
    throw new Error('Output probe must report a numeric stream duration')
  }
  if (
    Math.abs(durationSeconds - expectedDurationSeconds) >
    DURATION_TOLERANCE_SECONDS
  ) {
    throw new Error(
      `Output duration ${String(durationSeconds)}s does not match the ${String(expectedDurationSeconds)}s capture span within ${String(DURATION_TOLERANCE_SECONDS)}s`,
    )
  }
  const nbFrames = Number(stream.nb_frames)
  const expectedFrames = Math.round(expectedDurationSeconds * FRAME_RATE)
  if (Math.abs(nbFrames - expectedFrames) > FRAME_COUNT_TOLERANCE) {
    throw new Error(
      `Output frame count ${String(nbFrames)} does not match the ${String(expectedFrames)} frames expected for a constant ${String(FRAME_RATE)} fps encode of ${String(expectedDurationSeconds)}s`,
    )
  }
}

/** Runs the machine-readable M1 probe and validates the assembled video. */
export async function probeOutput(
  videoPath: string,
  expectedDurationSeconds: number,
  runner: CommandOutputRunner = runCommandOutput,
): Promise<void> {
  const stdout = await runner('ffprobe', buildFfprobeArguments(videoPath))
  let probe: OutputProbe
  try {
    probe = JSON.parse(stdout) as OutputProbe
  } catch {
    throw new Error('ffprobe must emit valid JSON')
  }
  validateOutputProbe(probe, expectedDurationSeconds)
}

function runCommandOutput(
  command: string,
  arguments_: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`${command} exited with code ${String(code)}`))
    })
  })
}

/**
 * What a finished video *is*, as opposed to whether it is the one M1 expected.
 *
 * `validateOutputProbe` above answers a yes/no question about one particular
 * deliverable — 1920x1080, 60 fps, this many seconds. The comparison command
 * has a different need: it takes two arbitrary videos and has to lay them out
 * next to each other, which means it has to *read* their size and length
 * rather than assert one. Same ffprobe invocation, same parsing, different
 * question — so it lives here next to the other one instead of growing a
 * second spelling of `ffprobe -show_entries` somewhere else.
 */
export type VideoInfo = {
  durationSeconds: number
  height: number
  /** Echoed back so an error message can name the file it is about. */
  path: string
  width: number
}

export function parseVideoInfo(json: string, path: string): VideoInfo {
  let probe: OutputProbe
  try {
    probe = JSON.parse(json) as OutputProbe
  } catch {
    throw new Error(`ffprobe did not emit valid JSON for ${path}`)
  }
  const stream = probe.streams?.[0]
  if (stream === undefined) {
    throw new Error(`${path} contains no video stream`)
  }
  const width = Number(stream.width)
  const height = Number(stream.height)
  const durationSeconds = Number(stream.duration)
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`${path} reports no picture size`)
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    // A missing duration is the interesting case: it is what a stream copy
    // out of a container without a length leaves behind, and a comparison
    // built on it would freeze one side for a computed NaN seconds and
    // produce a clip that looks fine until somebody watches the end of it.
    throw new Error(
      `${path} reports no usable duration. Re-encode it, or the side-by-side ` +
        'cannot know which of the two clips is the longer one.',
    )
  }
  return { durationSeconds, height, path, width }
}

/** Reads one video's size and length with the same ffprobe call M1 uses. */
export async function readVideoInfo(
  videoPath: string,
  runner: CommandOutputRunner = runCommandOutput,
): Promise<VideoInfo> {
  return parseVideoInfo(
    await runner('ffprobe', buildFfprobeArguments(videoPath)),
    videoPath,
  )
}
