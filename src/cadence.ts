import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { TimestampManifest } from './capture.js'
import type { RendererInfo } from './renderer.js'

const STATIC_INTERVAL_THRESHOLD_MS = 20

export type SourceCadenceReport = {
  /**
   * Frames that shared a capture timestamp with their neighbour and were
   * folded away by `orderFramesByCaptureTime`; see `capture.ts`. Expected 0.
   */
  coincidentTimestampCount: number
  /**
   * Byte-identical redelivered source frames `captureScreencast` folded
   * into the previous frame's duration instead of writing to disk (see
   * `capture.ts`). Recorded here because `validateNoDuplicateAdjacentFrames`
   * below can no longer observe them by design — it only ever sees the
   * frames that survived deduplication, so without this field the drop
   * count would be invisible.
   */
  droppedDuplicateFrameCount: number
  frameCount: number
  /**
   * Frames Chromium's screencast delivered out of the order it stamped them
   * in, restored to capture order by `orderFramesByCaptureTime`; see
   * `capture.ts`. Reported because it is the only remaining trace of the
   * reordering, and because a sudden jump in it would mean the encode
   * pipeline changed depth under us.
   */
  outOfDeliveryOrderFrameCount: number
  medianIntervalMs: number
  p95IntervalMs: number
  /** WebGL renderer string active during capture; see `renderer.ts`. */
  renderer?: RendererInfo
  shareUnderTwentyMs: number
}

/** A scripted stretch of the recording (absolute `Date.now()`-domain ms) that was meant to show visible motion. */
export type MotionWindow = {
  end: number
  label: string
  start: number
  /** For a scroll window: the element that was scrolled, so target choice is auditable across runs. */
  target?: string
}

export type MotionWindowCadence = SourceCadenceReport & {
  durationSeconds: number
  end: number
  label: string
  start: number
  target?: string
}

/** Per-motion-window cadence, so a slow window is attributable to the action that caused it. */
export function computeMotionWindowCadence(
  manifest: TimestampManifest,
  windows: readonly MotionWindow[],
): MotionWindowCadence[] {
  return windows.map((window) => {
    const framesInWindow = manifest.frames.filter(
      (frame) =>
        frame.timestamp >= window.start && frame.timestamp <= window.end,
    )
    const cadence = computeSourceCadence({
      ...manifest,
      frames: framesInWindow,
    })
    return {
      ...cadence,
      durationSeconds: (window.end - window.start) / 1000,
      end: window.end,
      label: window.label,
      start: window.start,
      ...(window.target === undefined ? {} : { target: window.target }),
    }
  })
}

/**
 * Rejects an adjacent pair of source JPEGs with identical SHA-256 hashes.
 * This is a post-condition safety net, not the primary defense: real
 * deduplication happens in `captureScreencast`'s writer before a frame ever
 * reaches disk (see `droppedDuplicateFrameCount` above), so this should
 * always pass on output from a working capture.
 *
 * Note that "adjacent" here means adjacent by file name, i.e. adjacent in
 * *delivery* order. Since `orderFramesByCaptureTime` sorts the manifest by
 * capture timestamp, file-name order and timeline order are no longer the
 * same sequence; this check is therefore a net over the delivery stream,
 * which is exactly where the redelivery artifact it looks for happens.
 */
export async function validateNoDuplicateAdjacentFrames(
  framesDirectory: string,
): Promise<void> {
  const frameFiles = (await readdir(framesDirectory))
    .filter((file) => file.endsWith('.jpg'))
    .sort()
  let previous: { file: string; hash: string } | undefined

  for (const file of frameFiles) {
    const hash = createHash('sha256')
      .update(await readFile(join(framesDirectory, file)))
      .digest('hex')
    if (previous?.hash === hash) {
      throw new Error(
        `Duplicate adjacent source frames: ${previous.file} and ${file}`,
      )
    }
    previous = { file, hash }
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.floor(fraction * sorted.length),
  )
  const value = sorted[index]
  if (value === undefined) {
    throw new Error('unreachable: percentile index out of bounds')
  }
  return value
}

/**
 * Reports how densely the source screencast actually delivered frames:
 * median and p95 inter-frame interval, and the share of gaps at or under
 * 20 ms (i.e. close to 60 fps). This is the evidence for whether a capture
 * run was throttled (see the backpressure fix in `capture.ts`) or the page
 * was genuinely idle — `page.screencast` only emits a frame when the page
 * repaints, so sparse frames during an interactive script are a real signal,
 * not capture noise.
 */
export function computeSourceCadence(
  manifest: TimestampManifest,
  droppedDuplicateFrameCount = 0,
  outOfDeliveryOrderFrameCount = 0,
  coincidentTimestampCount = 0,
): SourceCadenceReport {
  const intervals: number[] = []
  for (let index = 1; index < manifest.frames.length; index += 1) {
    const current = manifest.frames[index]
    const previous = manifest.frames[index - 1]
    if (current === undefined || previous === undefined) {
      throw new Error('unreachable: manifest frame array index out of bounds')
    }
    intervals.push(current.timestamp - previous.timestamp)
  }

  if (intervals.length === 0) {
    return {
      coincidentTimestampCount,
      droppedDuplicateFrameCount,
      frameCount: manifest.frames.length,
      medianIntervalMs: 0,
      outOfDeliveryOrderFrameCount,
      p95IntervalMs: 0,
      shareUnderTwentyMs: 0,
    }
  }

  const sorted = [...intervals].sort((a, b) => a - b)
  const shareUnderTwentyMs =
    intervals.filter((interval) => interval <= STATIC_INTERVAL_THRESHOLD_MS)
      .length / intervals.length

  return {
    coincidentTimestampCount,
    droppedDuplicateFrameCount,
    frameCount: manifest.frames.length,
    medianIntervalMs: percentile(sorted, 0.5),
    outOfDeliveryOrderFrameCount,
    p95IntervalMs: percentile(sorted, 0.95),
    shareUnderTwentyMs,
  }
}

/** Writes `capture-stats.json` next to the frames directory for M1 evidence. */
export async function writeCaptureStats(
  captureDirectory: string,
  manifest: TimestampManifest,
  droppedDuplicateFrameCount = 0,
  renderer?: RendererInfo,
  outOfDeliveryOrderFrameCount = 0,
  coincidentTimestampCount = 0,
): Promise<SourceCadenceReport> {
  const cadence = computeSourceCadence(
    manifest,
    droppedDuplicateFrameCount,
    outOfDeliveryOrderFrameCount,
    coincidentTimestampCount,
  )
  const report: SourceCadenceReport =
    renderer === undefined ? cadence : { ...cadence, renderer }
  await writeFile(
    join(captureDirectory, 'capture-stats.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: 'wx' },
  )
  return report
}
