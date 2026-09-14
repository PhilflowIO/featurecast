import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assembleScreencast,
  buildCaptureTimeline,
  buildFfmpegArguments,
  resolveEncoder,
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

  it('refuses to build a timeline in which a frame gets no time on screen', () => {
    // The counter-example for #21's acceptance, at the place where the harm
    // is done. `capture.ts` used to clamp a delivery-order inversion by
    // moving the regressing timestamp onto its predecessor's; measured on a
    // real acceptance run that produced 42 clamps and 39 gaps of exactly
    // 0.0ms in 1416 frames. A zero gap means no `duration` line, ffmpeg
    // steps straight past that frame, and its predecessor holds for twice as
    // long — a visible stutter. If clamping (or anything else that flattens
    // two capture times onto each other) ever comes back, this throws.
    expect(() =>
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
            timestamp: 1_060,
            viewport: { height: 1600, width: 2560 },
          },
        ],
        session: { duration: 400, endedAt: 1_400, startedAt: 1_000 },
        version: 1,
      }),
    ).toThrow(/timestamps must strictly increase/)
  })

  it('credits the leading gap to frame 0 even when it arrived before startedAt', () => {
    // `session.startedAt` is read after `screencast.start()` resolves, so a
    // frame can carry a capture timestamp from before it. Anchoring frame
    // 0's duration to `startedAt` unconditionally would then make that
    // duration negative or zero and drop the frame. The anchor is the
    // earlier of the two, so frame 0 keeps exactly the time between itself
    // and frame 1.
    expect(
      buildCaptureTimeline('/tmp/capture/frames', {
        captureSize: { height: 1600, width: 2560 },
        frames: [
          {
            file: 'frame-000000.jpg',
            timestamp: 980,
            viewport: { height: 1600, width: 2560 },
          },
          {
            file: 'frame-000001.jpg',
            timestamp: 1_000,
            viewport: { height: 1600, width: 2560 },
          },
        ],
        session: { duration: 400, endedAt: 1_400, startedAt: 1_000 },
        version: 1,
      }),
    ).toContain('duration 0.02\n')
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

describe('buildFfmpegArguments with NVENC', () => {
  it('encodes on the GPU without changing anything else about the command', () => {
    // The point of the NVENC path is the encoder, and nothing but the
    // encoder. Rather than restate the whole command, this strips the
    // NVENC-only rate-control block and asserts what is left is the CPU
    // command with the codec name swapped — so a future edit that quietly
    // drops `-color_range tv`, the `out_range=tv` remap, `fps=60`, or the
    // `-t` bound on one path but not the other fails here.
    const cpu = buildFfmpegArguments('/tmp/t.ffconcat', '/tmp/out.mp4', 20)
    const gpu = buildFfmpegArguments(
      '/tmp/t.ffconcat',
      '/tmp/out.mp4',
      20,
      'h264_nvenc',
    )
    const rateControl = ['-rc', 'vbr', '-cq', '23', '-b:v', '0']
    const start = gpu.indexOf('-rc')
    expect(gpu.slice(start, start + rateControl.length)).toEqual(rateControl)
    const withoutRateControl = [
      ...gpu.slice(0, start),
      ...gpu.slice(start + rateControl.length),
    ]
    expect(withoutRateControl).toEqual(
      cpu.map((argument) => (argument === 'libx264' ? 'h264_nvenc' : argument)),
    )
  })

  it('pins NVENC to constant quality instead of its default bitrate target', () => {
    // NVENC's own default is a bitrate target, which is a different kind of
    // promise from the CPU path's (libx264's default CRF, no ceiling) and
    // starves exactly the dense scrolling material this tool records.
    // `-b:v 0` is load-bearing: a non-zero bitrate overrides `-cq`.
    const gpu = buildFfmpegArguments(
      '/tmp/t.ffconcat',
      '/tmp/out.mp4',
      20,
      'h264_nvenc',
    )
    expect(gpu).toContain('-cq')
    expect(gpu[gpu.indexOf('-cq') + 1]).toBe('23')
    expect(gpu[gpu.indexOf('-b:v') + 1]).toBe('0')
  })

  it('keeps the colour promise on the GPU path', () => {
    // mjpeg decodes full-range; the scale filter does the actual remap and
    // `-color_range tv` makes the container metadata agree. Neither is
    // encoder-specific and neither may be lost when the encode moves.
    const gpu = buildFfmpegArguments(
      '/tmp/t.ffconcat',
      '/tmp/out.mp4',
      20,
      'hevc_nvenc',
    )
    expect(gpu).toContain('hevc_nvenc')
    expect(gpu[gpu.indexOf('-vf') + 1]).toContain('in_range=full:out_range=tv')
    expect(gpu[gpu.indexOf('-color_range') + 1]).toBe('tv')
    expect(gpu[gpu.indexOf('-pix_fmt') + 1]).toBe('yuv420p')
    expect(gpu[gpu.indexOf('-r') + 1]).toBe('60')
    expect(gpu[gpu.indexOf('-t') + 1]).toBe('20')
  })

  it('stays on the CPU unless a caller asks for the GPU', () => {
    // Nobody has measured or looked at an NVENC result yet, so the path
    // whose output has been seen is the one that runs by default.
    expect(
      buildFfmpegArguments('/tmp/t.ffconcat', '/tmp/out.mp4', 20),
    ).toContain('libx264')
  })
})

describe('resolveEncoder', () => {
  it('accepts every encoder this stage can drive', () => {
    // Named literally rather than looped over `ENCODERS`: a test that reads
    // its expectations out of the same constant it is checking cannot fail
    // when that constant loses an entry.
    expect(resolveEncoder('libx264')).toBe('libx264')
    expect(resolveEncoder('h264_nvenc')).toBe('h264_nvenc')
    expect(resolveEncoder('hevc_nvenc')).toBe('hevc_nvenc')
  })

  it('names the available encoders when given an unknown one', () => {
    // A typo that silently fell back to the CPU would only be noticed by
    // the encode taking two minutes.
    expect(() => resolveEncoder('h264_nvidia')).toThrow(
      /Unknown encoder "h264_nvidia"\. Available: libx264, h264_nvenc, hevc_nvenc/,
    )
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

  it('passes a requested encoder through to the ffmpeg invocation', async () => {
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

    await assembleScreencast(
      captureDirectory,
      '/tmp/output.mp4',
      runner,
      'h264_nvenc',
    )

    expect(runner).toHaveBeenCalledWith(
      'ffmpeg',
      buildFfmpegArguments(
        join(captureDirectory, 'timeline.ffconcat'),
        '/tmp/output.mp4',
        2,
        'h264_nvenc',
      ),
    )
  })
})
