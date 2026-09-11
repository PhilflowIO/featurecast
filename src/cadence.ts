import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { TimestampManifest } from './capture.js'

const STATIC_INTERVAL_THRESHOLD_MS = 20

export type SourceCadenceReport = {
  frameCount: number
  medianIntervalMs: number
  p95IntervalMs: number
  shareUnderTwentyMs: number
}

/** Rejects an adjacent pair of source JPEGs with identical SHA-256 hashes. */
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
      frameCount: manifest.frames.length,
      medianIntervalMs: 0,
      p95IntervalMs: 0,
      shareUnderTwentyMs: 0,
    }
  }

  const sorted = [...intervals].sort((a, b) => a - b)
  const shareUnderTwentyMs =
    intervals.filter((interval) => interval <= STATIC_INTERVAL_THRESHOLD_MS)
      .length / intervals.length

  return {
    frameCount: manifest.frames.length,
    medianIntervalMs: percentile(sorted, 0.5),
    p95IntervalMs: percentile(sorted, 0.95),
    shareUnderTwentyMs,
  }
}

/** Writes `capture-stats.json` next to the frames directory for M1 evidence. */
export async function writeCaptureStats(
  captureDirectory: string,
  manifest: TimestampManifest,
): Promise<SourceCadenceReport> {
  const cadence = computeSourceCadence(manifest)
  await writeFile(
    join(captureDirectory, 'capture-stats.json'),
    `${JSON.stringify(cadence, null, 2)}\n`,
    { flag: 'wx' },
  )
  return cadence
}
