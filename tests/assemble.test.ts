import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assembleScreencast,
  buildCaptureTimeline,
  buildFfmpegArguments,
} from '../src/assemble.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-assemble-'))
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

describe('buildCaptureTimeline', () => {
  it('builds a duration-preserving timeline anchored to session.startedAt', () => {
    // frame 0 arrives 20ms after startedAt: that leading gap must be
    // credited to frame 0's own duration, not silently folded onto the
    // last frame the way the previous implementation did.
    expect(
      buildCaptureTimeline('/tmp/capture/frames', {
        captureSize: { height: 1600, width: 2560 },
        frames: [
          {
            file: 'frame-000000.jpg',
            timestamp: 1_020,
            viewport: { height: 1600, width: 2560 },
          },
          {
            file: 'frame-000001.jpg',
            timestamp: 1_060,
            viewport: { height: 1600, width: 2560 },
          },
          {
            file: 'frame-000002.jpg',
            timestamp: 1_200,
            viewport: { height: 1600, width: 2560 },
          },
        ],
        session: { duration: 400, endedAt: 1_400, startedAt: 1_000 },
        version: 1,
      }),
    ).toBe(
      'ffconcat version 1.0\n' +
        "file '/tmp/capture/frames/frame-000000.jpg'\n" +
        'option framerate 1000\n' +
        'duration 0.06\n' +
        "file '/tmp/capture/frames/frame-000001.jpg'\n" +
        'option framerate 1000\n' +
        'duration 0.14\n' +
        "file '/tmp/capture/frames/frame-000002.jpg'\n" +
        'option framerate 1000\n' +
        'duration 0.2\n' +
        "file '/tmp/capture/frames/frame-000002.jpg'\n" +
        'option framerate 1000\n',
    )
  })

  // Regression test for the TS2532 fix: a single-frame manifest has no
  // frame-to-frame gaps at all, which is exactly the array-index edge case
  // that crashed `manifest.frames[index].timestamp` under
  // `noUncheckedIndexedAccess`.
  it('handles a single-frame manifest without a frame-to-frame gap', () => {
    expect(
      buildCaptureTimeline('/tmp/capture/frames', {
        captureSize: { height: 1600, width: 2560 },
        frames: [
          {
            file: 'frame-000000.jpg',
            timestamp: 1_020,
            viewport: { height: 1600, width: 2560 },
          },
        ],
        session: { duration: 250, endedAt: 1_250, startedAt: 1_000 },
        version: 1,
      }),
    ).toBe(
      'ffconcat version 1.0\n' +
        "file '/tmp/capture/frames/frame-000000.jpg'\n" +
        'option framerate 1000\n' +
        'duration 0.25\n' +
        "file '/tmp/capture/frames/frame-000000.jpg'\n" +
        'option framerate 1000\n',
    )
  })
})

describe('buildFfmpegArguments', () => {
  it('builds a constant-60-fps 1920x1080 ffmpeg command bounded to the manifest span', () => {
    expect(
      buildFfmpegArguments(
        '/tmp/capture/timeline.ffconcat',
        '/tmp/output.mp4',
        20,
      ),
    ).toEqual([
      '-hide_banner',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      '/tmp/capture/timeline.ffconcat',
      '-vf',
      'crop=2560:1440:0:0,scale=1920:1080:flags=lanczos:in_range=full:out_range=tv,fps=60,format=yuv420p',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-color_range',
      'tv',
      '-r',
      '60',
      '-t',
      '20',
      '/tmp/output.mp4',
    ])
  })
})

describe('assembleScreencast', () => {
  it('runs ffmpeg through an injected runner and reports the manifest duration', async () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const captureDirectory = join(await temporaryDirectory(), 'capture')
    await mkdir(join(captureDirectory, 'frames'), { recursive: true })
    await writeFile(
      join(captureDirectory, 'timestamps.json'),
      JSON.stringify({
        captureSize: { height: 1600, width: 2560 },
        frames: [
          {
            file: 'frame-000000.jpg',
            timestamp: 1,
            viewport: { height: 1600, width: 2560 },
          },
        ],
        session: { duration: 2_000, endedAt: 2_001, startedAt: 1 },
        version: 1,
      }),
    )

    const result = await assembleScreencast(
      captureDirectory,
      '/tmp/output.mp4',
      runner,
    )

    expect(runner).toHaveBeenCalledWith(
      'ffmpeg',
      buildFfmpegArguments(
        join(captureDirectory, 'timeline.ffconcat'),
        '/tmp/output.mp4',
        2,
      ),
    )
    expect(result).toEqual({ durationSeconds: 2 })
  })
})
