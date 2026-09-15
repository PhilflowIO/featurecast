import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Page, Screencast } from 'playwright'

/** A pixel rectangle: the area a capture is asked to record. */
export type CaptureSize = { height: number; width: number }

/**
 * The capture area M1 measured, and the one `desktop-wide` asks for.
 *
 * It is a reference value, not a setting this module reads. The recorded area
 * arrives as an argument (`captureScreencast`'s `size`), sourced from the
 * resolved device's capture layer, so a preset asking for a different area
 * gets that area recorded instead of this one silently substituted. It stays
 * here because M1's acceptance evidence, `demo/m1-capture.ts` and
 * `DEFAULT_ENCODE_TARGET` are all tied to this exact geometry.
 */
export const CAPTURE_SIZE: CaptureSize = { height: 1600, width: 2560 }

/**
 * JPEG quality Chromium encodes every screencast frame at. Chromium drops,
 * rather than queues, a frame whose encode does not finish inside the frame
 * budget, so this is a capture-completeness setting before it is an image
 * one. Measured on the AI box (RTX 3090, real OnlyDash Tasks view scrolled
 * at 60 content changes/s, 12s per run, frames written to a bind mount the
 * way this module does): quality 100 captured 91.2-91.5% of distinct content
 * changes (698KB mean frame), 95 captured 95.2-95.8% (439KB), 90 captured
 * 98.2-99.0% (351KB), 85 and 80 captured 98.2-98.7% — and quality 100 also
 * slowed the wheel driver itself from 59 to 52 events/s. 90 is the highest
 * quality that captures essentially every painted frame; see
 * `docs/CAPTURE-CADENCE.md`.
 */
export const CAPTURE_QUALITY = 90

/**
 * Upper bound on bytes buffered between the screencast callback and the
 * disk writer (roughly a couple of seconds of backlog for a dense
 * 2560x1600 JPEG stream, where individual frames have measured
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
  captureSize: CaptureSize
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
  /**
   * Frames that shared a capture timestamp with the frame before them and
   * could therefore never both be on screen; see `orderFramesByCaptureTime`.
   * Expected to be 0 — Chromium stamps with microsecond resolution.
   */
  coincidentTimestampCount: number
  /** Source frames folded into the previous distinct frame's duration; see `captureScreencast`. */
  droppedDuplicateFrameCount: number
  framesDirectory: string
  /**
   * Frames Chromium delivered later than a frame it had stamped after them,
   * i.e. reordered by the asynchronous JPEG encode; see `captureScreencast`.
   * These are restored to capture order, not clamped — a nonzero count is
   * normal and costs nothing.
   */
  outOfDeliveryOrderFrameCount: number
  timestampsPath: string
}

type WriterResult = {
  droppedDuplicateFrameCount: number
  outOfDeliveryOrderFrameCount: number
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

/**
 * Records `page` while `record()` drives it.
 *
 * `size` is the area to record, and it is a parameter rather than a constant
 * because the device layer already answers that question
 * (`ResolvedDevice.capture`). It is also the value every frame is validated
 * against: what Chromium reports per frame has to be what was ordered, or the
 * capture fails instead of quietly producing a video at a size nothing
 * downstream expects.
 */
export async function captureScreencast(
  page: Page,
  outputDirectory: string,
  size: CaptureSize,
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
    captureSize: { height: size.height, width: size.width },
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
    let previousDeliveredTimestamp: number | undefined
    let previousWrittenFrameData: Buffer | undefined
    let droppedDuplicateFrameCount = 0
    let outOfDeliveryOrderFrameCount = 0

    const writer = (async (): Promise<WriterResult> => {
      for await (const frame of queue.drain()) {
        // Delivery order and capture order are two different things, and the
        // timestamp is the one that carries capture order. Proven from the
        // pinned Chromium source tree (153.0.8010.12):
        // `BuildScreencastFrameMetadata` stamps
        // `.SetTimestamp(base::Time::Now().InSecondsFSinceUnixEpoch())`
        // (`content/browser/devtools/protocol/page_handler.cc:178`) inside
        // `OnFrameFromVideoConsumer` (same file, 1814-1861), which runs once
        // per frame on a single browser-process sequence in the order viz
        // delivers frames — and viz itself refuses to deliver out of order
        // (`media/capture/content/video_capture_oracle.cc:270-277` drops a
        // frame whose number is below the last delivered one). Only *after*
        // stamping does `ScreencastFrameCaptured` hand the bitmap to
        // `base::ThreadPool` for JPEG encoding, and the CDP event is emitted
        // from the encode's reply, `ScreencastFrameEncoded` (same file,
        // 1864-1893). Encodes therefore finish — and frames therefore arrive
        // — in whatever order the thread pool completes them, while the
        // timestamps were assigned strictly in order.
        //
        // The previous version of this code had the polarity backwards: it
        // treated delivery order as authoritative and clamped a regressing
        // timestamp forward onto its predecessor. Measured on a real
        // acceptance run, that produced 42 clamps and 37 resulting zero
        // gaps; `buildCaptureTimeline` gives a zero-gap frame no dwell time
        // at all, so it vanishes from the video and its neighbour holds for
        // twice as long. We now keep every timestamp exactly as Chromium
        // stamped it and restore capture order by sorting the manifest at
        // the end of the session (`orderFramesByCaptureTime`), which
        // destroys no information and creates no zero gaps.
        //
        // Note what `metadata.timestamp` is *not*: it is not the moment the
        // compositor produced or presented the frame. Chromium has that
        // number one field away — the capturer writes the oracle-smoothed
        // presentation time onto the VideoFrame
        // (`components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc:1511`,
        // `frame->set_timestamp(media_ticks - *first_frame_media_ticks_)`)
        // and ships it over mojo as `info->timestamp` (same file, 1527),
        // where `DevToolsVideoConsumer::OnFrameCaptured` puts it back on the
        // frame (`content/browser/devtools/devtools_video_consumer.cc:182-185`)
        // — but `PageHandler` never reads it back out. So the best timebase
        // reachable over CDP is a browser-process arrival stamp, roughly one
        // IPC hop after presentation, and that is what this manifest holds.
        if (
          previousDeliveredTimestamp !== undefined &&
          frame.timestamp < previousDeliveredTimestamp
        ) {
          outOfDeliveryOrderFrameCount += 1
        }
        previousDeliveredTimestamp = Math.max(
          previousDeliveredTimestamp ?? frame.timestamp,
          frame.timestamp,
        )

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
      return { droppedDuplicateFrameCount, outOfDeliveryOrderFrameCount }
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
    // (`result2.catch(() => {})` in the same function). A capture-resolution
    // JPEG write is slow enough to throttle the source to a
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
      quality: CAPTURE_QUALITY,
      size,
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
    const ordered = orderFramesByCaptureTime(manifest.frames)
    manifest.frames = ordered.frames
    validateCaptureManifest(manifest, size)

    await writeFile(timestampsPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
    })

    return {
      ...writerResult,
      coincidentTimestampCount: ordered.coincidentTimestampCount,
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

/**
 * Restores capture order from the timestamps Chromium stamped, which the
 * asynchronous JPEG encode in `PageHandler::ScreencastFrameCaptured` is free
 * to scramble on the way out (see the long comment in `captureScreencast`).
 *
 * The sort is stable, so frames that share a timestamp keep the order they
 * were delivered in; of such a group only the last survives, because an
 * earlier one has zero time on screen by construction. That fold is counted,
 * never silent. Everything here is a pure function of the delivered
 * sequence, so two runs over the same delivery sequence produce the same
 * manifest — the determinism the acceptance run measures end to end.
 */
export function orderFramesByCaptureTime(
  frames: readonly TimestampManifest['frames'][number][],
): {
  coincidentTimestampCount: number
  frames: TimestampManifest['frames']
} {
  const sorted = [...frames].sort((a, b) => a.timestamp - b.timestamp)
  const result: TimestampManifest['frames'] = []
  let coincidentTimestampCount = 0
  for (const frame of sorted) {
    const previous = result.at(-1)
    if (previous !== undefined && previous.timestamp === frame.timestamp) {
      coincidentTimestampCount += 1
      result[result.length - 1] = frame
      continue
    }
    result.push(frame)
  }
  return { coincidentTimestampCount, frames: result }
}

/** `2560x1600`, for error messages. */
function describeSize(size: CaptureSize): string {
  return `${String(size.width)}x${String(size.height)}`
}

/**
 * Ensures capture metadata is sufficient for reproducible acceptance.
 *
 * The geometry check has two halves, and only together do they have teeth:
 *
 * - Every frame's viewport must equal `manifest.captureSize`. That is the
 *   half that catches the browser: `captureSize` is the area that was
 *   ordered, while each frame's viewport is what Chromium reported for the
 *   frame it actually delivered. A capture that silently resized mid-session,
 *   or that started at a size other than the requested one, dies here.
 * - `ordered`, when a caller has one, must equal `manifest.captureSize`. That
 *   is the half that catches *us*: `assembleScreencast` knows the geometry
 *   its encode target assumes and can refuse a manifest recorded at a
 *   different one. `buildCaptureTimeline` has no such expectation of its own
 *   and passes nothing, so it gets the first half only.
 *
 * What used to stand here was a comparison against `CAPTURE_SIZE`, which
 * meant only one capture area on earth could ever validate — the reason
 * `desktop` and `safari` could not be recorded at all.
 */
export function validateCaptureManifest(
  manifest: TimestampManifest,
  ordered?: CaptureSize,
): void {
  if (manifest.version !== 1) {
    throw new Error('Capture manifest must be version 1')
  }
  if (
    ordered !== undefined &&
    (manifest.captureSize.width !== ordered.width ||
      manifest.captureSize.height !== ordered.height)
  ) {
    throw new Error(
      `Capture manifest records ${describeSize(manifest.captureSize)}, but ${describeSize(ordered)} was asked for`,
    )
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
      frame.viewport.width !== manifest.captureSize.width ||
      frame.viewport.height !== manifest.captureSize.height
    ) {
      throw new Error(
        `Capture frame viewport must match the recorded ${describeSize(manifest.captureSize)} viewport`,
      )
    }
    if (
      !Number.isFinite(frame.timestamp) ||
      (previousTimestamp !== undefined && frame.timestamp <= previousTimestamp)
    ) {
      // Strictly increasing, not merely non-decreasing. Two frames sharing a
      // timestamp cannot both be on screen, and `buildCaptureTimeline` would
      // silently give the earlier one no dwell time at all — the exact defect
      // the forward-clamping used to manufacture 37 times per run.
      // `orderFramesByCaptureTime` folds any such pair away and counts it, so
      // reaching here means something upstream broke the invariant.
      throw new Error('Capture manifest timestamps must strictly increase')
    }
    previousTimestamp = frame.timestamp
  }
}
