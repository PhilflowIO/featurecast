import { spawn } from 'node:child_process'

export type FreezeInterval = {
  durationSeconds: number
  endSeconds: number
  startSeconds: number
}

export type MotionWindowSeconds = {
  end: number
  label: string
  start: number
}

export type FreezeRunner = (arguments_: readonly string[]) => Promise<string>

/**
 * Parses ffmpeg's `freezedetect` metadata lines
 * (`lavfi.freezedetect.freeze_start=...`, `...freeze_duration=...`,
 * `...freeze_end=...`) out of its stderr.
 */
export function parseFreezeIntervals(stderr: string): FreezeInterval[] {
  // ffmpeg logs these as `lavfi.freezedetect.freeze_start: 1.366667` at
  // `-v info` (colon, not the `key=value` form `metadata=print` would use).
  const starts = [
    ...stderr.matchAll(/lavfi\.freezedetect\.freeze_start:\s*([\d.]+)/g),
  ].map((match) => Number(match[1]))
  const durations = [
    ...stderr.matchAll(/lavfi\.freezedetect\.freeze_duration:\s*([\d.]+)/g),
  ].map((match) => Number(match[1]))
  const ends = [
    ...stderr.matchAll(/lavfi\.freezedetect\.freeze_end:\s*([\d.]+)/g),
  ].map((match) => Number(match[1]))
  return starts.map((startSeconds, index) => {
    const durationSeconds = durations[index] ?? 0
    return {
      durationSeconds,
      endSeconds: ends[index] ?? startSeconds + durationSeconds,
      startSeconds,
    }
  })
}

/**
 * Detects frozen (near-identical, content-based) runs in a video using
 * ffmpeg's own `freezedetect` filter, chosen over a hand-rolled
 * luma-signature comparison because it is a standard, already-vetted tool
 * for exactly this: ffprobe and adjacent-source-frame hashing (the M1 gates
 * before this) cannot distinguish "30s of motion" from "11s of slideshow"
 * because both can report a valid constant-fps stream with distinct source
 * frames elsewhere in the timeline.
 */
export async function detectFreezes(
  videoPath: string,
  noiseThreshold = 0.001,
  minDurationSeconds = 1,
  runner: FreezeRunner = runFfmpegStderr,
): Promise<FreezeInterval[]> {
  const stderr = await runner([
    '-v',
    'info',
    '-i',
    videoPath,
    '-vf',
    `freezedetect=n=${String(noiseThreshold)}:d=${String(minDurationSeconds)}`,
    '-f',
    'null',
    '-',
  ])
  return parseFreezeIntervals(stderr)
}

/**
 * Fails if any scripted motion window (recorded by the benchmark script,
 * in video-relative seconds) overlaps a detected freeze by more than
 * `maxOverlapSeconds`. A window that was supposed to show continuous
 * motion but is provably frozen for a meaningful stretch means the script
 * scheduled time without producing the visible change M1 asks for.
 *
 * The default tolerance (1.5s) is set well above normal network/render
 * latency for a live third-party app (measured: a table switch against
 * OnlyDash occasionally takes ~1s to visibly repaint) and well below the
 * bug this gate exists to catch (measured on `m1-002`: two dead scroll
 * passes froze for 4.6s and 4.8s respectively — a full order of magnitude
 * more). A table load that takes over 1.5s to show anything is still
 * caught; ordinary fetch latency is not mistaken for a scripting bug.
 */
export function validateNoFrozenMotionWindows(
  freezeIntervals: readonly FreezeInterval[],
  motionWindows: readonly MotionWindowSeconds[],
  maxOverlapSeconds = 1.5,
): void {
  for (const window of motionWindows) {
    for (const freeze of freezeIntervals) {
      const overlapStart = Math.max(window.start, freeze.startSeconds)
      const overlapEnd = Math.min(window.end, freeze.endSeconds)
      const overlap = overlapEnd - overlapStart
      if (overlap > maxOverlapSeconds) {
        throw new Error(
          `Motion window "${window.label}" (${window.start.toFixed(2)}-${window.end.toFixed(2)}s) contains a ${overlap.toFixed(2)}s frozen run (ffmpeg freezedetect ${freeze.startSeconds.toFixed(2)}-${freeze.endSeconds.toFixed(2)}s) — scripted motion produced no visible change`,
        )
      }
    }
  }
}

function runFfmpegStderr(arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', arguments_, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    // `-f null -` exits 0 on a successful decode regardless of whether any
    // freeze was detected; freeze presence is read from stderr, not the
    // exit code.
    child.once('exit', () => {
      resolve(stderr)
    })
  })
}
