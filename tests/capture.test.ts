import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Page } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureScreencast, validateCaptureManifest } from '../src/capture.js'

const directories: string[] = []

type TestScreencast = {
  start: (options: {
    onFrame(frame: {
      data: Buffer
      timestamp: number
      viewportHeight: number
      viewportWidth: number
    }): unknown
    quality: number
    size: { height: number; width: number }
  }) => Promise<void>
  stop: () => Promise<void>
}

function testPage(
  screencast: TestScreencast,
  close: (options?: { runBeforeUnload?: boolean }) => Promise<void> = vi
    .fn()
    .mockResolvedValue(undefined),
): Page {
  return { close, screencast } as unknown as Page
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-capture-'))
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

describe('captureScreencast', () => {
  it('writes numbered JPEG frames and monotonic timestamp metadata', async () => {
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const firstFrame = Buffer.from('first jpeg')
    const secondFrame = Buffer.from('second jpeg')
    const stop = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      onFrame({
        data: firstFrame,
        timestamp: 1000,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
      onFrame({
        data: secondFrame,
        timestamp: 1016.667,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })
    const page = testPage({ start, stop })

    const result = await captureScreencast(
      page,
      outputDirectory,
      async () => undefined,
      { now: () => 0 },
    )

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        // Quality 100 measurably dropped frames on a real dense UI; see
        // CAPTURE_QUALITY's doc comment in src/capture.ts.
        quality: 90,
        size: { height: 1600, width: 2560 },
      }),
    )
    expect(stop).toHaveBeenCalledOnce()
    expect(
      await readFile(join(outputDirectory, 'frames', 'frame-000000.jpg')),
    ).toEqual(firstFrame)
    expect(
      await readFile(join(outputDirectory, 'frames', 'frame-000001.jpg')),
    ).toEqual(secondFrame)
    await expect(
      readFile(join(outputDirectory, 'frames', 'frame-000002.jpg')),
    ).rejects.toThrow()
    await expect(readFile(result.timestampsPath, 'utf8')).resolves.toBe(
      JSON.stringify(
        {
          captureSize: { height: 1600, width: 2560 },
          frames: [
            {
              file: 'frame-000000.jpg',
              timestamp: 1000,
              viewport: { height: 1600, width: 2560 },
            },
            {
              file: 'frame-000001.jpg',
              timestamp: 1016.667,
              viewport: { height: 1600, width: 2560 },
            },
          ],
          session: { duration: 0, endedAt: 0, startedAt: 0 },
          version: 1,
        },
        null,
        2,
      ) + '\n',
    )
  })

  it('acks frames synchronously instead of awaiting the disk write', async () => {
    // Playwright only advances the CDP screencast once whatever `onFrame`
    // returns resolves, and swallows any error that promise carries. If
    // `onFrame` returned a promise tied to the (slow) disk write, capture
    // would be throttled to disk speed and a write failure would vanish
    // silently. Enqueuing must therefore be synchronous.
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    let onFrameReturnValue: unknown = 'not called'
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      onFrameReturnValue = onFrame({
        data: Buffer.from('frame'),
        timestamp: 1,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })
    const page = testPage({ start, stop })

    await captureScreencast(page, outputDirectory, async () => undefined, {
      writeFrame: async () =>
        new Promise((resolve) => {
          setTimeout(resolve, 30)
        }),
    })

    expect(onFrameReturnValue).toBeUndefined()
  })

  it('fails loudly instead of buffering forever when the writer stalls', async () => {
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    // Every frame is 7 bytes ('frame-0' .. 'frame-4'); a 15-byte cap allows
    // two frames (14 bytes) and overflows on the third.
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      for (let index = 0; index < 5; index += 1) {
        onFrame({
          data: Buffer.from(`frame-${String(index)}`),
          timestamp: index + 1,
          viewportHeight: 1600,
          viewportWidth: 2560,
        })
      }
    })
    const page = testPage({ start, stop })
    const writeFrame = vi.fn().mockImplementation(
      async () =>
        new Promise<void>(() => {
          // Never resolves: simulates a stalled writer.
        }),
    )

    await expect(
      captureScreencast(page, outputDirectory, async () => undefined, {
        maxQueuedBytes: 15,
        writeFrame,
      }),
    ).rejects.toThrow('fell behind')

    expect(stop).toHaveBeenCalledOnce()
    await expect(access(outputDirectory)).rejects.toThrow()
  })

  it('fails loudly instead of hanging forever when a single write stalls', async () => {
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      onFrame({
        data: Buffer.from('frame'),
        timestamp: 1,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })
    const page = testPage({ start, stop })
    const writeFrame = vi.fn().mockImplementation(
      async () =>
        new Promise<void>(() => {
          // Never resolves, but never overflows the (default) byte bound
          // either: only a per-write timeout can catch this.
        }),
    )

    await expect(
      captureScreencast(page, outputDirectory, async () => undefined, {
        writeFrame,
        writeFrameTimeoutMs: 20,
      }),
    ).rejects.toThrow('did not finish writing')

    expect(stop).toHaveBeenCalledOnce()
  })

  it('cancels a still-running recording action when the capture pipeline fails', async () => {
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      for (let index = 0; index < 5; index += 1) {
        onFrame({
          data: Buffer.from(`frame-${String(index)}`),
          timestamp: index + 1,
          viewportHeight: 1600,
          viewportWidth: 2560,
        })
      }
    })
    const page = testPage({ start, stop }, close)
    const writeFrame = vi.fn().mockImplementation(
      async () =>
        new Promise<void>(() => {
          // Never resolves: the queue overflow below fires first.
        }),
    )
    // record() never settles on its own, standing in for a scripted action
    // still mid-flight when the capture pipeline aborts.
    const record = (): Promise<void> => new Promise<void>(() => undefined)

    await expect(
      captureScreencast(page, outputDirectory, record, {
        maxQueuedBytes: 15,
        writeFrame,
      }),
    ).rejects.toThrow('fell behind')

    expect(close).toHaveBeenCalledWith({ runBeforeUnload: false })
  })

  it('does not close the page when the recording action fails on its own', async () => {
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockResolvedValue(undefined)
    const page = testPage({ start, stop }, close)

    await expect(
      captureScreencast(page, outputDirectory, async () => {
        throw new Error('script failed')
      }),
    ).rejects.toThrow('script failed')

    expect(close).not.toHaveBeenCalled()
  })

  it('ignores a frame delivered after the capture has already closed', async () => {
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    let lateOnFrame:
      | ((frame: {
          data: Buffer
          timestamp: number
          viewportHeight: number
          viewportWidth: number
        }) => unknown)
      | undefined
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      lateOnFrame = onFrame
      onFrame({
        data: Buffer.from('frame'),
        timestamp: 1,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })
    const page = testPage({ start, stop })

    await captureScreencast(page, outputDirectory, async () => undefined)

    expect(() =>
      lateOnFrame?.({
        data: Buffer.from('late'),
        timestamp: 9_999,
        viewportHeight: 1600,
        viewportWidth: 2560,
      }),
    ).not.toThrow()
  })

  it('records session timing around the scripted action', async () => {
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      onFrame({
        data: Buffer.from('frame'),
        timestamp: 100,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_250)

    const result = await captureScreencast(
      testPage({ start, stop }),
      outputDirectory,
      async () => undefined,
      { now },
    )

    expect(
      JSON.parse(await readFile(result.timestampsPath, 'utf8')),
    ).toMatchObject({
      session: { startedAt: 1_000, endedAt: 1_250, duration: 250 },
    })
  })

  it('stops the screencast when the recorded action fails', async () => {
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockResolvedValue(undefined)
    const page = testPage({ start, stop })

    await expect(
      captureScreencast(page, outputDirectory, async () => {
        throw new Error('script failed')
      }),
    ).rejects.toThrow('script failed')

    expect(stop).toHaveBeenCalledOnce()
    await expect(access(outputDirectory)).rejects.toThrow()
  })

  it('restores capture order for a large delivery-order inversion', async () => {
    // Chromium stamps `metadata.timestamp` in capture order on one
    // browser-process sequence and only then hands the bitmap to a thread
    // pool for JPEG encoding, and the CDP event is emitted from the encode's
    // reply (page_handler.cc:178, 1814-1893 of the pinned tree) — so a late
    // encode can deliver a frame after one that was stamped later. Observed
    // inversions so far: 3-9ms, 30.5ms, 82.5ms. The size does not matter and
    // no threshold is needed: the timestamps are the truth, so the manifest
    // is sorted back into capture order rather than the timestamps being
    // flattened onto delivery order.
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      onFrame({
        data: Buffer.from('first'),
        timestamp: 1_000,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
      onFrame({
        data: Buffer.from('second'),
        timestamp: 917, // 83ms inversion — larger than any tolerance ever tried.
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })
    const page = testPage({ start, stop })

    const result = await captureScreencast(
      page,
      outputDirectory,
      async () => undefined,
    )

    expect(result.outOfDeliveryOrderFrameCount).toBe(1)
    expect(result.coincidentTimestampCount).toBe(0)
    const manifest = JSON.parse(await readFile(result.timestampsPath, 'utf8'))
    // Both frames survive, both keep their own stamped time, and the late
    // arrival is first in the timeline because it was captured first.
    expect(
      manifest.frames.map((frame: { file: string }) => frame.file),
    ).toEqual(['frame-000001.jpg', 'frame-000000.jpg'])
    expect(
      manifest.frames.map((frame: { timestamp: number }) => frame.timestamp),
    ).toEqual([917, 1_000])
  })

  it('restores capture order for a small delivery-order inversion too', async () => {
    // Measured on a real acceptance run: 42 inversions in 1416 frames, which
    // the previous forward-clamping turned into 39 gaps of exactly 0.0ms.
    // Small ones are the common case and are handled identically.
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      onFrame({
        data: Buffer.from('first'),
        timestamp: 100,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
      onFrame({
        data: Buffer.from('second'),
        timestamp: 95, // 5ms inversion.
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })

    const result = await captureScreencast(
      testPage({ start, stop }),
      outputDirectory,
      async () => undefined,
    )

    expect(result.outOfDeliveryOrderFrameCount).toBe(1)
    const manifest = JSON.parse(await readFile(result.timestampsPath, 'utf8'))
    expect(
      manifest.frames.map((frame: { timestamp: number }) => frame.timestamp),
    ).toEqual([95, 100])
  })

  it('never lets a delivery-order inversion produce a zero-length gap', async () => {
    // The counter-example test the acceptance of #21 asks for: if forward
    // clamping ever returns, two frames end up sharing a timestamp, the
    // earlier one gets no dwell time in `buildCaptureTimeline`, and it
    // disappears from the video. This asserts the property directly — every
    // consecutive gap strictly positive — over a delivery sequence with
    // three separate inversions, including one that reaches back two frames.
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    const delivered = [1_000, 1_016.4, 1_008.2, 1_033.1, 1_024.9, 1_049.5]
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      for (const [index, timestamp] of delivered.entries()) {
        onFrame({
          data: Buffer.from(`frame-${String(index)}`),
          timestamp,
          viewportHeight: 1600,
          viewportWidth: 2560,
        })
      }
    })

    const result = await captureScreencast(
      testPage({ start, stop }),
      outputDirectory,
      async () => undefined,
    )

    expect(result.outOfDeliveryOrderFrameCount).toBe(2)
    const manifest = JSON.parse(await readFile(result.timestampsPath, 'utf8'))
    const timestamps = manifest.frames.map(
      (frame: { timestamp: number }) => frame.timestamp,
    )
    expect(timestamps).toEqual([...delivered].sort((a, b) => a - b))
    const gaps = timestamps
      .slice(1)
      .map((timestamp: number, index: number) => timestamp - timestamps[index])
    expect(gaps.filter((gap: number) => gap <= 0)).toEqual([])
    expect(manifest.frames).toHaveLength(delivered.length)
  })

  it('folds away, and counts, two frames that share a capture timestamp', async () => {
    // Measured against the pinned Chromium: `metadata.timestamp` carries
    // microsecond resolution (1415 of 1416 frames of a real run had a
    // fractional millisecond), so a genuine tie is not a resolution
    // artifact and should essentially never happen. If it does, both frames
    // cannot be on screen — the earlier one would get a zero-length slot —
    // so the later one wins and the fold is counted rather than silent.
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      onFrame({
        data: Buffer.from('first'),
        timestamp: 5,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
      onFrame({
        data: Buffer.from('second'),
        timestamp: 5,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })

    const result = await captureScreencast(
      testPage({ start, stop }),
      outputDirectory,
      async () => undefined,
    )

    expect(result.coincidentTimestampCount).toBe(1)
    const manifest = JSON.parse(await readFile(result.timestampsPath, 'utf8'))
    expect(manifest.frames).toHaveLength(1)
    expect(manifest.frames[0].file).toBe('frame-000001.jpg')
  })

  it('rejects an existing output directory before starting capture', async () => {
    const outputDirectory = await temporaryDirectory()
    const start = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn().mockResolvedValue(undefined)

    await expect(
      captureScreencast(
        testPage({ start, stop }),
        outputDirectory,
        async () => undefined,
      ),
    ).rejects.toThrow(
      'Capture output directory already exists; choose a unique or cleared --out directory',
    )

    expect(start).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('stops and removes its capture directory when writing a frame fails', async () => {
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const stop = vi.fn().mockResolvedValue(undefined)
    const writeError = new Error('frame write failed')
    const start = vi.fn().mockImplementation(async ({ onFrame }) => {
      onFrame({
        data: Buffer.from('frame'),
        timestamp: 1,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })

    await expect(
      captureScreencast(
        testPage({ start, stop }),
        outputDirectory,
        async () => undefined,
        { writeFrame: async () => Promise.reject(writeError) },
      ),
    ).rejects.toBe(writeError)

    expect(stop).toHaveBeenCalledOnce()
    await expect(access(outputDirectory)).rejects.toThrow()
  })

  it('preserves the original error when stopping capture also fails', async () => {
    const outputDirectory = join(await temporaryDirectory(), 'capture')
    const originalError = new Error('record failed')
    const stop = vi.fn().mockRejectedValue(new Error('stop failed'))
    const start = vi.fn().mockResolvedValue(undefined)

    await expect(
      captureScreencast(
        testPage({ start, stop }),
        outputDirectory,
        async () => {
          throw originalError
        },
      ),
    ).rejects.toBe(originalError)

    expect(stop).toHaveBeenCalledOnce()
    await expect(access(outputDirectory)).rejects.toThrow()
  })
})

describe('validateCaptureManifest', () => {
  it('accepts a complete M1 capture manifest', () => {
    expect(() =>
      validateCaptureManifest({
        captureSize: { height: 1600, width: 2560 },
        frames: [
          {
            file: 'frame-000000.jpg',
            timestamp: 1,
            viewport: { height: 1600, width: 2560 },
          },
        ],
        session: { duration: 1, endedAt: 1, startedAt: 0 },
        version: 1,
      }),
    ).not.toThrow()
  })

  it('rejects two frames sharing a capture timestamp', () => {
    // Not a resolution tie: `metadata.timestamp` carries microsecond
    // resolution (1415 of 1416 frames of a real run were fractional
    // milliseconds). Equal timestamps mean one of the two frames would get a
    // zero-length slot in `buildCaptureTimeline` and vanish from the video,
    // which is precisely the defect forward-clamping used to manufacture.
    // `orderFramesByCaptureTime` folds and counts such a pair before the
    // manifest is written, so anything reaching here is a broken invariant.
    expect(() =>
      validateCaptureManifest({
        captureSize: { height: 1600, width: 2560 },
        frames: [
          {
            file: 'frame-000000.jpg',
            timestamp: 5,
            viewport: { height: 1600, width: 2560 },
          },
          {
            file: 'frame-000001.jpg',
            timestamp: 5,
            viewport: { height: 1600, width: 2560 },
          },
        ],
        session: { duration: 1, endedAt: 1, startedAt: 0 },
        version: 1,
      }),
    ).toThrow('Capture manifest timestamps must strictly increase')
  })

  it.each([
    ['has no frames', []],
    [
      'uses the wrong viewport',
      [
        {
          file: 'frame-000000.jpg',
          timestamp: 1,
          viewport: { height: 1080, width: 1920 },
        },
      ],
    ],
    [
      'has a decreasing timestamp',
      [
        {
          file: 'frame-000000.jpg',
          timestamp: 2,
          viewport: { height: 1600, width: 2560 },
        },
        {
          file: 'frame-000001.jpg',
          timestamp: 1,
          viewport: { height: 1600, width: 2560 },
        },
      ],
    ],
  ])('rejects a capture manifest that %s', (_description, frames) => {
    expect(() =>
      validateCaptureManifest({
        captureSize: { height: 1600, width: 2560 },
        frames,
        session: { duration: 1, endedAt: 1, startedAt: 0 },
        version: 1,
      }),
    ).toThrow()
  })
})
