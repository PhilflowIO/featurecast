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

export type WindowMotionQuality = {
  frozenSeconds: number
  frozenShare: number
  label: string
  seconds: number
}

export type MotionQualityReport = {
  frozenSecondsInMotionWindows: number
  frozenShareOfMotionWindows: number
  totalFrozenSeconds: number
  totalFrozenShareOfRun: number
  totalMotionWindowSeconds: number
  totalRunSeconds: number
  windows: WindowMotionQuality[]
}

/**
 * A per-window "does this ONE window overlap a freeze beyond a tolerance"
 * check cannot fail a video shaped like N short windows, each individually
 * under the tolerance, that are frozen almost the whole time anyway — proven
 * with a synthetic 19x[1.0s still + 0.05s motion] case: 19s of 19.95s frozen,
 * every one of 19 ~1.05s windows individually "passing" a 1.5s-overlap
 * check, while the real acceptance video this was modeled on measured
 * 92.3% duplicate output frames and 13.7s of 29.4s inside freezes >=1s.
 * Judging aggregate motion quality — the frozen share of scripted
 * motion-window time, and of the whole run — catches that shape and the
 * single-long-freeze shape the same way, while still passing a run where
 * most motion-window time is genuinely frozen-free.
 */
export function computeMotionQuality(
  freezeIntervals: readonly FreezeInterval[],
  motionWindows: readonly MotionWindowSeconds[],
  totalRunSeconds: number,
): MotionQualityReport {
  const windows = motionWindows.map((window) => {
    const seconds = window.end - window.start
    let frozenSeconds = 0
    for (const freeze of freezeIntervals) {
      const overlapStart = Math.max(window.start, freeze.startSeconds)
      const overlapEnd = Math.min(window.end, freeze.endSeconds)
      frozenSeconds += Math.max(0, overlapEnd - overlapStart)
    }
    return {
      frozenSeconds,
      frozenShare: seconds > 0 ? frozenSeconds / seconds : 0,
      label: window.label,
      seconds,
    }
  })
  const frozenSecondsInMotionWindows = windows.reduce(
    (total, window) => total + window.frozenSeconds,
    0,
  )
  const totalMotionWindowSeconds = windows.reduce(
    (total, window) => total + window.seconds,
    0,
  )
  const totalFrozenSeconds = freezeIntervals.reduce(
    (total, freeze) => total + (freeze.endSeconds - freeze.startSeconds),
    0,
  )
  return {
    frozenSecondsInMotionWindows,
    frozenShareOfMotionWindows:
      totalMotionWindowSeconds > 0
        ? frozenSecondsInMotionWindows / totalMotionWindowSeconds
        : 0,
    totalFrozenSeconds,
    totalFrozenShareOfRun:
      totalRunSeconds > 0 ? totalFrozenSeconds / totalRunSeconds : 0,
    totalMotionWindowSeconds,
    totalRunSeconds,
    windows,
  }
}

/** Above this, scripted motion time is mostly frozen — a scripting bug, not load latency. */
const DEFAULT_MAX_FROZEN_SHARE_OF_MOTION_WINDOWS = 0.4
/** Above this, the recording as a whole is mostly a slideshow, whether or not it was ever "claimed" as motion. */
const DEFAULT_MAX_FROZEN_SHARE_OF_RUN = 0.5

/**
 * Fails on aggregate frozen share, not on any single window's overlap
 * against a fixed tolerance — see `computeMotionQuality`'s doc comment for
 * why a per-window threshold cannot catch a slideshow shaped as many short
 * windows.
 */
export function validateMotionQuality(
  quality: MotionQualityReport,
  maxFrozenShareOfMotionWindows = DEFAULT_MAX_FROZEN_SHARE_OF_MOTION_WINDOWS,
  maxFrozenShareOfRun = DEFAULT_MAX_FROZEN_SHARE_OF_RUN,
): void {
  if (quality.frozenShareOfMotionWindows > maxFrozenShareOfMotionWindows) {
    throw new Error(
      `${(quality.frozenShareOfMotionWindows * 100).toFixed(1)}% of scripted motion-window time (${quality.frozenSecondsInMotionWindows.toFixed(1)}s of ${quality.totalMotionWindowSeconds.toFixed(1)}s) is frozen — exceeds the ${(maxFrozenShareOfMotionWindows * 100).toFixed(0)}% limit`,
    )
  }
  if (quality.totalFrozenShareOfRun > maxFrozenShareOfRun) {
    throw new Error(
      `${(quality.totalFrozenShareOfRun * 100).toFixed(1)}% of the whole run (${quality.totalFrozenSeconds.toFixed(1)}s of ${quality.totalRunSeconds.toFixed(1)}s) is frozen — exceeds the ${(maxFrozenShareOfRun * 100).toFixed(0)}% limit`,
    )
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
