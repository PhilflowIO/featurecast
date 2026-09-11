import { spawn } from 'node:child_process'

import { FRAME_RATE } from './assemble.js'

/**
 * Tolerance for the assembled video's reported duration versus the
 * manifest span, and for its frame count versus `duration * FRAME_RATE`.
 * Both are `max(floor, expected * relative)`. This is deliberately not a
 * couple of milliseconds: the ffconcat `duration` directive is quantized by
 * the mjpeg demuxer's default 25 fps timebase before `fps=60` resamples it
 * (ffmpeg logs "25 fps, 25 tbr, 25 tbn" for the concat input regardless of
 * the per-file durations we write), so some drift between the requested and
 * assembled duration is expected, not a bug. Measured on a real ~24.6 s,
 * 188-source-frame OnlyDash capture: 7 extra output frames (0.123 s, 0.5%
 * relative). A 2% relative tolerance still fails hard on real regressions —
 * the bug this gate replaced produced an 83 ms clip against a 20 s span, off
 * by orders of magnitude more than 2%.
 */
const DURATION_TOLERANCE_FLOOR_SECONDS = 0.15
const DURATION_TOLERANCE_RELATIVE = 0.02
const FRAME_COUNT_TOLERANCE_FLOOR = 2
const FRAME_COUNT_TOLERANCE_RELATIVE = 0.02

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
  const durationTolerance = Math.max(
    DURATION_TOLERANCE_FLOOR_SECONDS,
    expectedDurationSeconds * DURATION_TOLERANCE_RELATIVE,
  )
  if (Math.abs(durationSeconds - expectedDurationSeconds) > durationTolerance) {
    throw new Error(
      `Output duration ${String(durationSeconds)}s does not match the ${String(expectedDurationSeconds)}s capture span within ${String(durationTolerance)}s`,
    )
  }
  const nbFrames = Number(stream.nb_frames)
  const expectedFrames = Math.round(expectedDurationSeconds * FRAME_RATE)
  const frameCountTolerance = Math.max(
    FRAME_COUNT_TOLERANCE_FLOOR,
    Math.round(expectedFrames * FRAME_COUNT_TOLERANCE_RELATIVE),
  )
  if (Math.abs(nbFrames - expectedFrames) > frameCountTolerance) {
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
