import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { TimestampManifest } from '../src/capture.js'
import {
  computeMotionWindowCadence,
  computeSourceCadence,
  validateNoDuplicateAdjacentFrames,
  writeCaptureStats,
} from '../src/cadence.js'
import type { RendererInfo } from '../src/renderer.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-cadence-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

function manifestWithTimestamps(timestamps: number[]): TimestampManifest {
  return {
    captureSize: { height: 1600, width: 2560 },
    frames: timestamps.map((timestamp, index) => ({
      file: `frame-${String(index).padStart(6, '0')}.jpg`,
      timestamp,
      viewport: { height: 1600, width: 2560 },
    })),
    session: {
      duration: (timestamps.at(-1) ?? 0) - (timestamps[0] ?? 0),
      endedAt: timestamps.at(-1) ?? 0,
      startedAt: timestamps[0] ?? 0,
    },
    version: 1,
  }
}

describe('validateNoDuplicateAdjacentFrames', () => {
  it('rejects successive identical source JPEG frames by SHA-256', async () => {
    const directory = await temporaryDirectory()
    const framesDirectory = join(directory, 'frames')
    await mkdir(framesDirectory)
    await writeFile(join(framesDirectory, 'frame-000000.jpg'), 'same')
    await writeFile(join(framesDirectory, 'frame-000001.jpg'), 'same')

    await expect(
      validateNoDuplicateAdjacentFrames(framesDirectory),
    ).rejects.toThrow(
      'Duplicate adjacent source frames: frame-000000.jpg and frame-000001.jpg',
    )
  })

  it('accepts frames that differ byte-for-byte', async () => {
    const directory = await temporaryDirectory()
    const framesDirectory = join(directory, 'frames')
    await mkdir(framesDirectory)
    await writeFile(join(framesDirectory, 'frame-000000.jpg'), 'one')
    await writeFile(join(framesDirectory, 'frame-000001.jpg'), 'two')

    await expect(
      validateNoDuplicateAdjacentFrames(framesDirectory),
    ).resolves.toBeUndefined()
  })
})

describe('computeSourceCadence', () => {
  it('reports median and p95 inter-frame interval and the near-60fps share', () => {
    // Ten frames roughly 16.7ms apart (60fps) followed by one 300ms gap.
    const timestamps = Array.from({ length: 11 }, (_, index) =>
      index < 10 ? index * 16.667 : 10 * 16.667 + 300,
    )

    const report = computeSourceCadence(manifestWithTimestamps(timestamps))

    expect(report.frameCount).toBe(11)
    expect(report.medianIntervalMs).toBeCloseTo(16.667, 1)
    expect(report.p95IntervalMs).toBeGreaterThan(report.medianIntervalMs)
    expect(report.shareUnderTwentyMs).toBeCloseTo(9 / 10, 5)
  })

  it('returns zeroed stats for a single-frame manifest', () => {
    const report = computeSourceCadence(manifestWithTimestamps([1]))

    expect(report).toEqual({
      coincidentTimestampCount: 0,
      droppedDuplicateFrameCount: 0,
      frameCount: 1,
      medianIntervalMs: 0,
      outOfDeliveryOrderFrameCount: 0,
      p95IntervalMs: 0,
      shareUnderTwentyMs: 0,
    })
  })

  it('records the caller-supplied dropped-duplicate-frame count', () => {
    const report = computeSourceCadence(
      manifestWithTimestamps([0, 16.667, 33.334]),
      5,
    )

    expect(report.droppedDuplicateFrameCount).toBe(5)
  })
})

describe('writeCaptureStats', () => {
  it('writes capture-stats.json next to the frames directory', async () => {
    const captureDirectory = await temporaryDirectory()
    const manifest = manifestWithTimestamps([0, 16.667, 33.334])

    const report = await writeCaptureStats(captureDirectory, manifest)

    const written = JSON.parse(
      await readFile(join(captureDirectory, 'capture-stats.json'), 'utf8'),
    )
    expect(written).toEqual(report)
    expect(report.frameCount).toBe(3)
  })

  it('includes the renderer info when supplied', async () => {
    const captureDirectory = await temporaryDirectory()
    const manifest = manifestWithTimestamps([0, 16.667, 33.334])
    const renderer: RendererInfo = {
      launchArgs: ['--use-gl=angle'],
      renderer: 'ANGLE (AMD, AMD Radeon 860M Graphics)',
      softwareRendering: false,
    }

    const report = await writeCaptureStats(
      captureDirectory,
      manifest,
      0,
      renderer,
    )

    expect(report.renderer).toEqual(renderer)
  })
})

describe('computeMotionWindowCadence', () => {
  it('computes cadence separately per motion window', () => {
    const manifest = manifestWithTimestamps([
      0, 16.667, 33.334, 1_000, 1_016.667, 1_033.334,
    ])

    const [first, second] = computeMotionWindowCadence(manifest, [
      { end: 40, label: 'first', start: 0 },
      { end: 1_040, label: 'second', start: 990 },
    ])

    expect(first?.frameCount).toBe(3)
    expect(first?.label).toBe('first')
    expect(second?.frameCount).toBe(3)
    expect(second?.label).toBe('second')
  })
})
