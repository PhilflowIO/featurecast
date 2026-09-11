import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Page, Screencast } from 'playwright'

export const CAPTURE_SIZE = { height: 1600, width: 2560 } as const

/**
 * Upper bound on bytes buffered between the screencast callback and the
 * disk writer (roughly a couple of seconds of backlog for a dense
 * 2560x1600 quality-100 JPEG stream, where individual frames have measured
 * up to ~650KB). A writer that cannot keep up with that for longer is
 * broken, not merely slow, and capture must fail loudly rather than grow
 * memory without bound. This is a byte bound rather than a frame-count
 * bound deliberately: a fixed frame count (the previous design) sized for
 * a light page allows ~700MB of backlog for a dense one, where frames run
 * tens of times larger.
 */
const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024 * 1024
/** How long a single `writeFrame` call may take before it counts as stalled. */
const DEFAULT_WRITE_TIMEOUT_MS = 10_000

export type ScreencastFrame = {
  data: Buffer
  timestamp: number
  viewportHeight: number
  viewportWidth: number
}

export type CaptureDependencies = {
  maxQueuedBytes?: number
  now?: () => number
  writeFrame?: (path: string, data: Buffer) => Promise<void>
  writeFrameTimeoutMs?: number
}

export type TimestampManifest = {
  captureSize: typeof CAPTURE_SIZE
  frames: Array<{
    file: string
    timestamp: number
    viewport: { height: number; width: number }
  }>
  session: {
    duration: number
    endedAt: number
    startedAt: number
  }
  version: 1
}

export type ScreencastCapture = {
  /** Frames whose CDP timestamp regressed by a few ms and was clamped forward; see `captureScreencast`. */
  clampedTimestampCount: number
  /** Source frames folded into the previous distinct frame's duration; see `captureScreencast`. */
  droppedDuplicateFrameCount: number
  framesDirectory: string
  timestampsPath: string
}

type WriterResult = {
  clampedTimestampCount: number
  droppedDuplicateFrameCount: number
}

function frameFileName(index: number): string {
  return `frame-${String(index).padStart(6, '0')}.jpg`
}

/** Rejects if `promise` has not settled within `ms`, without abandoning it. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

type FrameQueue = {
  close: () => void
  drain: () => AsyncGenerator<ScreencastFrame>
  fail: (error: Error) => void
  onFailure: Promise<never>
  push: (frame: ScreencastFrame) => void
}

/**
 * A frame backlog bounded by total buffered bytes. `push` is synchronous
 * and never returns a promise, so it is safe to call directly from
 * Playwright's `onFrame` callback: see the comment in `captureScreencast`
 * for why that is the whole point. Once `fail` has fired, or once `close`
 * has been called, the queue stops accepting frames — both cap memory
 * growth from a stalled writer or a straggling late frame instead of
 * buffering forever, and `onFailure` lets a caller race the write pipeline
 * against the scripted recording action for a fast, loud abort.
 */
function createFrameQueue(maxBytes: number): FrameQueue {
  const items: ScreencastFrame[] = []
  let queuedBytes = 0
  let wake: (() => void) | undefined
  let closed = false
  let failure: Error | undefined
  let rejectOnFailure: (error: Error) => void = () => undefined
  const onFailure = new Promise<never>((_resolve, reject) => {
    rejectOnFailure = reject
  })
  // Nobody may ever await `onFailure` (the happy path never fails), so give
  // it a no-op handler to avoid an unhandled-rejection warning; the real
  // rejection is still observed by whoever explicitly awaits it.
  onFailure.catch(() => undefined)

  function fail(error: Error): void {
    if (failure) return
    failure = error
    rejectOnFailure(error)
    wake?.()
    wake = undefined
  }

  function push(frame: ScreencastFrame): void {
    if (failure || closed) return
    if (queuedBytes + frame.data.length > maxBytes) {
      fail(
        new Error(
          `Frame writer fell behind capture: ${String(maxBytes)} bytes buffered without being written`,
        ),
      )
      return
    }
    queuedBytes += frame.data.length
    items.push(frame)
    wake?.()
    wake = undefined
  }

  function close(): void {
    closed = true
    wake?.()
    wake = undefined
  }

  async function* drain(): AsyncGenerator<ScreencastFrame> {
    for (;;) {
      if (failure) throw failure
      const next = items.shift()
      if (next !== undefined) {
        queuedBytes -= next.data.length
        yield next
        continue
      }
      if (closed) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }

  return { close, drain, fail, onFailure, push }
}

export async function captureScreencast(
  page: Page,
  outputDirectory: string,
  record: () => Promise<void>,
  dependencies: CaptureDependencies = {},
): Promise<ScreencastCapture> {
  const framesDirectory = join(outputDirectory, 'frames')
  const timestampsPath = join(outputDirectory, 'timestamps.json')
  const screencast = page.screencast
  const writeFrame = dependencies.writeFrame ?? writeCaptureFrame
  const now = dependencies.now ?? Date.now
  const maxQueuedBytes = dependencies.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
  const writeFrameTimeoutMs =
    dependencies.writeFrameTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS
  const manifest: TimestampManifest = {
    captureSize: CAPTURE_SIZE,
    frames: [],
    session: { duration: 0, endedAt: 0, startedAt: 0 },
    version: 1,
  }
  let stopAttempted = false
  let queue: FrameQueue | undefined

  await mkdir(dirname(outputDirectory), { recursive: true })
  await createCaptureDirectory(outputDirectory)

  try {
    await mkdir(framesDirectory)

    const stop = async (): Promise<void> => {
      if (!stopAttempted) {
        stopAttempted = true
        await screencast.stop()
      }
    }

    queue = createFrameQueue(maxQueuedBytes)
    let frameIndex = 0
    let previousTimestamp: number | undefined
    let previousWrittenFrameData: Buffer | undefined
    let droppedDuplicateFrameCount = 0
    let clampedTimestampCount = 0

    const writer = (async (): Promise<WriterResult> => {
      for await (const rawFrame of queue.drain()) {
        // CDP's screencast timestamp is not monotonic under fast
        // (hardware-GL, see renderer.ts) capture. This is proven, not
        // guessed: instrumenting playwright-core's own
        // `CRPage._onScreencastFrame` (the Chromium `Page.screencastFrame`
        // handler, which computes
        // `frameSwapWallTime: payload.metadata.timestamp ? payload.metadata.timestamp * 1e3 : Date.now()`)
        // against a real acceptance run logged every frame's raw CDP
        // `metadata.timestamp` alongside `Date.now()`. Result: 0 of 671
        // frames were missing `metadata.timestamp` (so the `Date.now()`
        // fallback — mixing a browser-clock timestamp with a Node-clock one
        // — never fired; that hypothesis is refuted for this pipeline).
        // Every one of the 6 regressions that run produced (3.7-18.1ms)
        // carried a genuine, non-fallback `metadata.timestamp` on both the
        // regressing frame and its predecessor, and the *next* frame after
        // each regression always jumped forward past both — i.e. Chromium
        // itself hands two adjacent screencast frames real capture
        // timestamps that are briefly out of order. `onFrame` still fires
        // in true delivery order (Playwright's own guarantee this file
        // already relies on below), so this is JPEG-encode-completion
        // reordering inside Chromium's screencast pipeline (frames are
        // encoded asynchronously; encode completion, which drives CDP
        // delivery order, can occasionally finish a hair out of step with
        // the compositor's own capture-time stamps) — not a Node/browser
        // clock-mixing artifact, and not GC pauses. Delivery order is the
        // trustworthy signal; clamping the *timestamp* forward to match
        // delivery order is therefore correct regardless of the
        // regression's size: worst case, one frame's duration is
        // misattributed by that many ms, negligible in a 20s+ video. Every
        // regression is clamped and counted, with no ceiling that throws;
        // real session corruption would show as timestamps off by seconds
        // or more, which would still surface as a nonsensical
        // `capture-stats.json` clampedTimestampCount relative to
        // frameCount, not silently.
        let frame = rawFrame
        if (
          previousTimestamp !== undefined &&
          frame.timestamp < previousTimestamp
        ) {
          clampedTimestampCount += 1
          frame = { ...frame, timestamp: previousTimestamp }
        }
        previousTimestamp = frame.timestamp

        // `page.screencast` is documented to emit a frame only when the page
        // repaints, but in practice it occasionally redelivers a
        // byte-identical frame even mid-scroll (observed against a real
        // dense UI: 1 duplicate pair in 226 frames of a ~20s run, gap ~21ms
        // either side, i.e. not during an idle pause). That is a source-side
        // artifact, not a bug in this writer, so we fold it into the
        // previous frame's on-screen duration instead of writing a second,
        // pointless copy — `buildCaptureTimeline` already derives each
        // frame's duration from the gap to the *next distinct* frame.
        if (
          previousWrittenFrameData !== undefined &&
          frame.data.equals(previousWrittenFrameData)
        ) {
          droppedDuplicateFrameCount += 1
          continue
        }
        previousWrittenFrameData = frame.data

        const file = frameFileName(frameIndex)
        frameIndex += 1
        await withTimeout(
          writeFrame(join(framesDirectory, file), frame.data),
          writeFrameTimeoutMs,
          `Frame writer stalled: ${file} did not finish writing within ${String(writeFrameTimeoutMs)}ms`,
        )
        manifest.frames.push({
          file,
          timestamp: frame.timestamp,
          viewport: {
            height: frame.viewportHeight,
            width: frame.viewportWidth,
          },
        })
      }
      return { clampedTimestampCount, droppedDuplicateFrameCount }
    })().catch((error: unknown) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error))
      queue?.fail(normalized)
      throw normalized
    })
    // The final `await writer` below always observes this rejection; this
    // extra handler only suppresses Node's unhandled-rejection warning for
    // the case where `queue.onFailure` wins the race instead.
    writer.catch(() => undefined)

    // Playwright awaits whatever `onFrame` returns before it will ack the
    // next CDP screencast frame (playwright-core's `Screencast.onScreencastFrame`
    // races client promises via `Promise.race(asyncResults)`), and it
    // silently discards any error that promise carries
    // (`result2.catch(() => {})` in the same function). A quality-100 JPEG
    // write at capture resolution is slow enough to throttle the source to a
    // few frames per second if awaited here, and a validation error thrown
    // inside this callback would simply vanish. Returning nothing (not a
    // promise) makes Playwright ack synchronously instead — see the
    // `Promise<any>|any` signature and the sync example in
    // `Screencast.start`'s own type doc. `onFrame` therefore only enqueues;
    // the writer above is a separate consumer, and its errors are surfaced
    // explicitly through `writer`/`queue.onFailure`.
    await screencast.start({
      onFrame: (frame) => {
        queue?.push({
          data: frame.data,
          timestamp: frame.timestamp,
          viewportHeight: frame.viewportHeight,
          viewportWidth: frame.viewportWidth,
        })
      },
      quality: 100,
      size: CAPTURE_SIZE,
    })
    manifest.session.startedAt = now()

    let recordSettled = false
    const recordPromise = record().finally(() => {
      recordSettled = true
    })
    recordPromise.catch(() => undefined)
    try {
      await Promise.race([recordPromise, queue.onFailure])
    } catch (raceError) {
      if (!recordSettled) {
        // The capture pipeline failed (queue overflow, a stalled write, a
        // non-monotonic timestamp) while the scripted action was still
        // running. Nothing downstream of this failure is going to use
        // whatever `record()` does next, so close the page instead of
        // leaving it to keep clicking, scrolling, and waiting against a
        // capture that has already been abandoned — every pending
        // Playwright call in `record()` then rejects promptly instead of
        // running to completion for no reason.
        await page.close({ runBeforeUnload: false }).catch(() => undefined)
      }
      throw raceError
    }

    manifest.session.endedAt = now()
    manifest.session.duration =
      manifest.session.endedAt - manifest.session.startedAt
    await stop()
    queue.close()
    const writerResult = await writer
    validateCaptureManifest(manifest)

    await writeFile(timestampsPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    })

    return {
      ...writerResult,
      framesDirectory,
      timestampsPath,
    }
  } catch (error) {
    if (!stopAttempted) {
      await stopCaptureSafely(screencast)
    }
    queue?.close()
    await removeCaptureDirectorySafely(outputDirectory)
    throw error
  }
}

async function createCaptureDirectory(outputDirectory: string): Promise<void> {
  try {
    await mkdir(outputDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        'Capture output directory already exists; choose a unique or cleared --out directory',
      )
    }
    throw error
  }
}

async function writeCaptureFrame(path: string, data: Buffer): Promise<void> {
  await writeFile(path, data, { flag: 'wx' })
}

async function stopCaptureSafely(screencast: Screencast): Promise<void> {
  try {
    await screencast.stop()
  } catch {
    // Preserve the original capture failure.
  }
}

async function removeCaptureDirectorySafely(
  outputDirectory: string,
): Promise<void> {
  try {
    await rm(outputDirectory, { force: true, recursive: true })
  } catch {
    // Preserve the original capture failure.
  }
}

/** Ensures capture metadata is sufficient for reproducible M1 acceptance. */
export function validateCaptureManifest(manifest: TimestampManifest): void {
  if (
    manifest.version !== 1 ||
    manifest.captureSize.width !== CAPTURE_SIZE.width ||
    manifest.captureSize.height !== CAPTURE_SIZE.height
  ) {
    throw new Error('Capture manifest must use the expected 2560x1600 viewport')
  }
  if (manifest.frames.length === 0) {
    throw new Error('Capture manifest must contain a positive frame count')
  }
  if (
    !Number.isFinite(manifest.session.startedAt) ||
    !Number.isFinite(manifest.session.endedAt) ||
    !Number.isFinite(manifest.session.duration) ||
    manifest.session.duration < 0 ||
    manifest.session.endedAt - manifest.session.startedAt !==
      manifest.session.duration
  ) {
    throw new Error('Capture manifest must contain valid session timing')
  }

  let previousTimestamp: number | undefined
  for (const frame of manifest.frames) {
    if (
      frame.viewport.width !== CAPTURE_SIZE.width ||
      frame.viewport.height !== CAPTURE_SIZE.height
    ) {
      throw new Error(
        'Capture frame viewport must match the expected 2560x1600 viewport',
      )
    }
    if (
      !Number.isFinite(frame.timestamp) ||
      (previousTimestamp !== undefined && frame.timestamp < previousTimestamp)
    ) {
      throw new Error('Capture manifest timestamps must not decrease')
    }
    previousTimestamp = frame.timestamp
  }
}
