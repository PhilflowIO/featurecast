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
        quality: 100,
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

  it('rejects a screencast timestamp regression beyond the jitter tolerance', async () => {
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
        // 79ms regression, well beyond the 50ms jitter tolerance.
        timestamp: 21,
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })
    const page = testPage({ start, stop })

    await expect(
      captureScreencast(page, outputDirectory, async () => undefined),
    ).rejects.toThrow('beyond the 50ms jitter tolerance')
    expect(stop).toHaveBeenCalledOnce()
    await expect(access(outputDirectory)).rejects.toThrow()
  })

  it('clamps a small timestamp regression forward instead of failing', async () => {
    // Measured directly against hardware-GL capture on this box: ~1-2% of
    // frames report a timestamp a few ms *before* the previous one (CDP
    // metadata jitter, not out-of-order delivery or corruption).
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
        timestamp: 95, // 5ms regression, within the 50ms tolerance.
        viewportHeight: 1600,
        viewportWidth: 2560,
      })
    })

    const result = await captureScreencast(
      testPage({ start, stop }),
      outputDirectory,
      async () => undefined,
    )

    expect(result.clampedTimestampCount).toBe(1)
    const manifest = JSON.parse(await readFile(result.timestampsPath, 'utf8'))
    expect(manifest.frames[1].timestamp).toBe(100)
  })

  it('tolerates two distinct frames sharing a millisecond-resolution timestamp', async () => {
    // Hardware-GL capture (see renderer.ts) delivers frames fast enough
    // that two genuinely distinct frames can report the same CDP
    // timestamp; that is a resolution tie, not corruption, and must not
    // abort the capture.
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

    expect(
      JSON.parse(await readFile(result.timestampsPath, 'utf8')).frames,
    ).toHaveLength(2)
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

  it('accepts two frames sharing a millisecond-resolution timestamp', () => {
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
    ).not.toThrow()
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
