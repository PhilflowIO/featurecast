/**
 * The render pipeline: decode once, compose here, encode per format.
 *
 * One ffmpeg reads the captured JPEGs and hands us packed RGB. For every
 * output frame we pick the source frame the plan says is on screen, crop and
 * scale it ourselves, blend the pointer on top, and push the finished picture
 * into one ffmpeg per format. The decoder is read strictly forwards — the
 * source index the plan produces never goes backwards — so a whole render is
 * one pass over the capture no matter how many formats are asked for.
 *
 * Nothing here decides anything. Every rectangle and every pointer position
 * comes out of `decisions.json`; this file only turns those numbers into
 * pixels. That is the property the milestone owes: identical decision data
 * implies an identical video, because there is no step in between that is free
 * to differ between two runs.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { availableParallelism } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { Worker } from 'node:worker_threads'

import { planBands } from './bands.js'
import {
  compositeSprite,
  createRaster,
  rasterByteLength,
  resample,
  type Raster,
} from './compose.js'
import { CONTROL, STOP, type WorkerSetup } from './compose-worker.js'
import type { Rect, Size } from './geometry.js'
import type { FormatPlan, FrameDecision, RenderPlan } from './plan.js'
import type { SpriteCache, SpriteGeometry } from './sprite.js'

/**
 * How many threads compose by default.
 *
 * Two cores are left alone: one for this thread, which still has a decoder to
 * drain and three encoders to feed, and one for the encoders themselves.
 *
 * The ceiling of six that used to sit here was measured when composition was a
 * bilinear kernel costing about 28ms per output frame for all three formats,
 * where the encoder writes really were what the next frame waited on. The
 * windowed-sinc kernel in `compose.ts` costs roughly ten times that, so
 * composition now dominates the pipeline by an order of magnitude and a
 * ceiling of six would cap the machine rather than the encoder. There is no
 * ceiling any more; what is left is the two cores reserved above.
 *
 * The floor of one is not a fallback: a machine with three cores composes on a
 * single thread, and at this kernel's cost that machine cannot hold the
 * milestone's two-minute budget for a minute of video. That is a hardware
 * assumption and it is written down in the README rather than left implicit.
 */
export function defaultThreads(): number {
  return Math.max(1, availableParallelism() - 2)
}

export type CursorPainter = {
  geometry: SpriteGeometry
  sprites: SpriteCache
}

/**
 * One finished output frame, from one source frame and one decision.
 *
 * Pure in everything it touches: the same source pixels and the same decision
 * always fill `target` with the same bytes.
 */
export function composeFrame(
  source: Raster,
  decision: FrameDecision,
  cursor: CursorPainter | null,
  target: Raster,
): void {
  resample(source, decision.crop, target)
  if (cursor === null || decision.cursor === null) return
  const sprite = cursor.sprites.rgba(
    decision.cursor.kind,
    decision.cursor.ripplePhase,
  )
  compositeSprite(
    target,
    sprite,
    Math.round(decision.cursor.screenX - cursor.geometry.hotspotX),
    Math.round(decision.cursor.screenY - cursor.geometry.hotspotY),
  )
}

/**
 * Reads fixed-size frames out of a byte stream.
 *
 * The decoder writes frames back to back with no framing of their own, so the
 * only thing that says where one ends is its size — which is why a short read
 * at the end is an error rather than a partial frame quietly composed.
 */
export class RawFrameReader {
  private readonly chunks: Buffer[] = []
  private buffered = 0
  private ended = false
  private error: Error | null = null
  private waiting: (() => void) | null = null

  constructor(
    private readonly stream: Readable,
    private readonly frameBytes: number,
  ) {
    stream.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk)
      this.buffered += chunk.length
      if (this.buffered >= this.frameBytes) {
        stream.pause()
        this.wake()
      }
    })
    stream.on('end', () => {
      this.ended = true
      this.wake()
    })
    stream.on('error', (error: Error) => {
      this.error = error
      this.wake()
    })
    stream.pause()
  }

  private wake(): void {
    const waiting = this.waiting
    this.waiting = null
    if (waiting !== null) waiting()
  }

  /** The next whole frame, or `null` once the stream is exhausted. */
  async next(): Promise<Buffer | null> {
    while (this.buffered < this.frameBytes) {
      if (this.error !== null) throw this.error
      if (this.ended) {
        if (this.buffered === 0) return null
        throw new Error(
          `Decoder ended mid-frame: ${this.buffered} of ${this.frameBytes} ` +
            'bytes. The capture directory and the frame list disagree.',
        )
      }
      await new Promise<void>((resolvePromise) => {
        this.waiting = resolvePromise
        this.stream.resume()
      })
    }
    const joined = Buffer.concat(this.chunks)
    this.chunks.length = 0
    const frame = joined.subarray(0, this.frameBytes)
    const rest = joined.subarray(this.frameBytes)
    if (rest.length > 0) this.chunks.push(Buffer.from(rest))
    this.buffered = rest.length
    return frame
  }
}

async function write(stream: Writable, data: Uint8Array): Promise<void> {
  if (stream.write(data)) return
  await new Promise<void>((resolvePromise, reject) => {
    const onDrain = (): void => {
      stream.off('error', onError)
      resolvePromise()
    }
    const onError = (error: Error): void => {
      stream.off('drain', onDrain)
      reject(error)
    }
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}

/**
 * A promise for one child's clean exit.
 *
 * Must be created the moment the child is spawned, not when we get round to
 * waiting for it. `close` is emitted once; a decoder that finishes while we are
 * still composing has already emitted it by then, and a listener attached
 * afterwards waits for an event that has been and gone. That was a real hang,
 * with all three videos on disk and the render never returning.
 */
function exited(child: ChildProcess, what: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${what} exited with code ${String(code)}`))
    })
  })
}

/** Two crops are the same picture only if they are the same rectangle. */
function sameRect(a: Rect, b: Rect | null): boolean {
  return (
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  )
}

export type PipelineFormat = {
  format: FormatPlan
  outputPath: string
}

export type PipelineSpawn = (
  command: string,
  arguments_: readonly string[],
) => ChildProcess

export type PipelineOptions = {
  cursor: CursorPainter | null
  decode: { arguments: readonly string[]; command: string }
  encode: ReadonlyArray<{
    arguments: readonly string[]
    command: string
    format: FormatPlan
  }>
  plan: RenderPlan
  source: Size
  /** Output frame index to source frame index, non-decreasing. */
  sourceForOutput: Int32Array
  spawn?: PipelineSpawn
  /**
   * Composition threads. One means "do it on this thread", which is the
   * reference implementation and what the small fixtures in the test suite use.
   * Any count produces the same bytes; see `planBands`.
   */
  threads?: number
}

/**
 * Runs one decode, composes every output frame for every format, and feeds the
 * encoders. Returns when all of them have exited cleanly.
 */
export async function runComposePipeline(
  options: PipelineOptions,
): Promise<void> {
  const spawnProcess = options.spawn ?? defaultSpawn
  const decoder = spawnProcess(options.decode.command, options.decode.arguments)
  const failures: Error[] = []
  const remember = (error: unknown): void => {
    failures.push(error instanceof Error ? error : new Error(String(error)))
  }
  // Attached now, before a single frame moves: see `exited`.
  const decoderExit = exited(decoder, 'ffmpeg (decode)')
  const encoders = options.encode.map((entry) => {
    const child = spawnProcess(entry.command, entry.arguments)
    return {
      child,
      exit: exited(child, `ffmpeg (${entry.format.label})`),
      format: entry.format,
      target: createRaster(entry.format.output),
    }
  })

  const threads = options.threads ?? defaultThreads()
  let pool: Pool | null = null
  try {
    if (decoder.stdout === null) {
      throw new Error('Decoder was started without a readable stdout')
    }
    const reader = new RawFrameReader(
      decoder.stdout,
      rasterByteLength(options.source),
    )
    const frameCount = options.sourceForOutput.length
    const formats = encoders.map((encoder) => encoder.format)
    pool = threads > 1 ? startPool(options.source, formats, threads) : null
    if (pool !== null) await pool.ready

    const sourceRaster: Raster = {
      data: new Uint8Array(0),
      height: options.source.height,
      width: options.source.width,
    }
    let decoded = -1
    let slot = 0

    /**
     * The last picture composed for each format, without the pointer on it.
     *
     * A capture runs at whatever rate the browser painted — m1-008 is 1332
     * frames for 2873 output frames — so every second source frame is shown
     * twice or more, and while the camera is at rest the crop for those two
     * output frames is the same rectangle too. Same source pixels and same
     * crop is the same picture, bit for bit, and composing it twice is work
     * with a known answer. Roughly half of a typical recording is that case;
     * with a windowed-sinc kernel costing 250ms a frame, recomputing it is the
     * difference between making the milestone's two-minute budget and missing
     * it by a factor of two.
     *
     * The pointer is not part of this: it moves at 60Hz and is painted onto
     * the copy afterwards, which is also why the copy is kept clean.
     */
    const pristine = encoders.map((encoder) =>
      createRaster(encoder.format.output),
    )
    const lastCrops: Array<Rect | null> = encoders.map(() => null)
    let lastSource = -1

    /** Reads forward to `wanted`, leaving that frame in `into`. */
    const fill = async (wanted: number, into: number): Promise<Buffer> => {
      let frame: Buffer | null = null
      while (decoded < wanted) {
        frame = await reader.next()
        if (frame === null) {
          throw new Error(
            `Decoder ran out of frames at source index ${String(wanted)}; ` +
              `the plan expects ${String(options.plan.frames.length)}.`,
          )
        }
        decoded += 1
      }
      if (frame === null) throw new Error('unreachable: nothing decoded')
      if (pool !== null) pool.sources[into]?.set(frame)
      return frame
    }

    let current = await fill(options.sourceForOutput[0] ?? 0, slot)
    for (let n = 0; n < frameCount; n += 1) {
      const wanted = options.sourceForOutput[n] ?? 0
      const decisions = encoders.map((encoder) => {
        const decision = encoder.format.frames[n]
        if (decision === undefined) {
          throw new Error(
            `Format ${encoder.format.label} has no decision for output ` +
              `frame ${String(n)}`,
          )
        }
        return decision
      })

      const unchanged =
        wanted === lastSource &&
        decisions.every((decision, index) =>
          sameRect(decision.crop, lastCrops[index] ?? null),
        )

      if (unchanged) {
        // Nothing to compose, but the decoder still has to be drained: it is
        // blocked on a full pipe whether or not we had work to do.
        const next = options.sourceForOutput[n + 1]
        if (next !== undefined && next > wanted) {
          const nextSlot = pool === null ? 0 : 1 - slot
          current = await fill(next, nextSlot)
          slot = nextSlot
        }
      } else if (pool === null) {
        sourceRaster.data = current
        for (const [index, encoder] of encoders.entries()) {
          const decision = decisions[index]
          if (decision === undefined) throw new Error('unreachable: decision')
          // Without the pointer, exactly as the pool composes: it goes on
          // below, the same way for one thread and for many.
          composeFrame(sourceRaster, decision, null, encoder.target)
        }
        const next = options.sourceForOutput[n + 1]
        if (next !== undefined && next > wanted) current = await fill(next, 0)
      } else {
        pool.start(slot, decisions)
        // The read-ahead is what keeps the decoder off the critical path: it
        // runs on this thread while the pool scales the frame we already have,
        // so ffmpeg is never left blocked on a full pipe with nobody draining.
        const next = options.sourceForOutput[n + 1]
        let nextSlot = slot
        if (next !== undefined && next > wanted) {
          nextSlot = 1 - slot
          current = await fill(next, nextSlot)
        }
        await pool.finished()
        slot = nextSlot
      }

      for (const [index, encoder] of encoders.entries()) {
        const decision = decisions[index]
        const target = pool === null ? encoder.target : pool.targets[index]
        const keep = pristine[index]
        if (decision === undefined || target === undefined) {
          throw new Error('unreachable: missing target')
        }
        if (keep === undefined) throw new Error('unreachable: missing copy')
        if (unchanged) target.data.set(keep.data)
        else keep.data.set(target.data)
        paintCursor(target, decision, options.cursor)
        if (encoder.child.stdin === null) {
          throw new Error('Encoder was started without a writable stdin')
        }
        await write(encoder.child.stdin, target.data)
        lastCrops[index] = decision.crop
      }
      lastSource = wanted
    }
  } catch (error) {
    remember(error)
  }

  // Every pipe we hold open is a `close` event that never fires: the child has
  // exited long ago and Node is still waiting on the stdio streams. Closing our
  // ends is what lets the processes actually finish.
  pool?.stop()
  for (const encoder of encoders) encoder.child.stdin?.end()
  decoder.stdin?.end()
  decoder.stdout?.resume()
  await Promise.all([
    decoderExit.catch((error: unknown) => {
      // A decoder killed by its own closed pipe after an encoder failed is a
      // consequence, not the cause; the first failure is the one that matters.
      if (failures.length === 0) remember(error)
    }),
    ...encoders.map((encoder) => encoder.exit.catch(remember)),
  ])
  const first = failures[0]
  if (first !== undefined) throw first
}

function defaultSpawn(
  command: string,
  arguments_: readonly string[],
): ChildProcess {
  return spawn(command, [...arguments_], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
}

/** The pointer, blended on by this thread: a 160x160 sprite is not worth a job. */
function paintCursor(
  target: Raster,
  decision: FrameDecision,
  cursor: CursorPainter | null,
): void {
  if (cursor === null || decision.cursor === null) return
  compositeSprite(
    target,
    cursor.sprites.rgba(decision.cursor.kind, decision.cursor.ripplePhase),
    Math.round(decision.cursor.screenX - cursor.geometry.hotspotX),
    Math.round(decision.cursor.screenY - cursor.geometry.hotspotY),
  )
}

type Pool = {
  finished: () => Promise<void>
  ready: Promise<void>
  sources: Uint8Array[]
  start: (slot: number, decisions: readonly FrameDecision[]) => void
  stop: () => void
  targets: Raster[]
}

/**
 * Starts the composition threads and the shared memory they work in.
 *
 * Two source slots, so the read-ahead can fill one while the threads are still
 * reading the other. One target per format, written by the threads and read
 * back by this one. A three-slot control block and a flat array of crop
 * rectangles: that is the entire protocol, and none of it carries a decision —
 * the crops are copied straight out of the plan.
 */
function startPool(
  source: Size,
  formats: readonly FormatPlan[],
  threads: number,
): Pool {
  const control = new SharedArrayBuffer(CONTROL.length * 4)
  const crops = new SharedArrayBuffer(formats.length * 4 * 8)
  const controlView = new Int32Array(control)
  const cropView = new Float64Array(crops)
  const sourceSlots = [0, 1].map(
    () => new SharedArrayBuffer(rasterByteLength(source)),
  )
  const targetBuffers = formats.map(
    (format) => new SharedArrayBuffer(rasterByteLength(format.output)),
  )
  const bands = planBands(
    formats.map((format) => format.output),
    threads,
    // A format with no zoom reserve has a crop exactly the size of its own
    // frame at every moment, so it is always the copy path rather than the
    // filter: 0.18ms against 179ms, measured on a 2560x1600 capture. That is
    // the ratio, rounded to a fiftieth so nobody reads it as exact.
    formats.map((format) => (format.maxZoom > 1 ? 1 : 1 / 50)),
  )

  const workers: Worker[] = []
  const ready: Array<Promise<void>> = []
  for (let index = 0; index < threads; index += 1) {
    const setup: WorkerSetup = {
      bands: bands[index] ?? [],
      control,
      crops,
      sourceSize: source,
      sourceSlots,
      targets: formats.map((format, at) => {
        const buffer = targetBuffers[at]
        if (buffer === undefined) throw new Error('unreachable: target buffer')
        return {
          buffer,
          height: format.output.height,
          width: format.output.width,
        }
      }),
    }
    const worker = new Worker(new URL('compose-worker.ts', import.meta.url), {
      workerData: setup,
    })
    worker.unref()
    workers.push(worker)
    ready.push(
      new Promise<void>((resolvePromise, reject) => {
        worker.once('message', () => {
          resolvePromise()
        })
        worker.once('error', reject)
      }),
    )
  }

  return {
    finished: async (): Promise<void> => {
      for (;;) {
        const done = Atomics.load(controlView, CONTROL.done)
        if (done >= threads) return
        const wait = Atomics.waitAsync(controlView, CONTROL.done, done)
        if (wait.async) await wait.value
      }
    },
    ready: Promise.all(ready).then(() => undefined),
    sources: sourceSlots.map((buffer) => new Uint8Array(buffer)),
    start: (slot: number, decisions: readonly FrameDecision[]): void => {
      for (const [index, decision] of decisions.entries()) {
        cropView[index * 4] = decision.crop.x
        cropView[index * 4 + 1] = decision.crop.y
        cropView[index * 4 + 2] = decision.crop.width
        cropView[index * 4 + 3] = decision.crop.height
      }
      Atomics.store(controlView, CONTROL.done, 0)
      Atomics.store(controlView, CONTROL.slot, slot)
      Atomics.add(controlView, CONTROL.generation, 1)
      Atomics.notify(controlView, CONTROL.generation)
    },
    stop: (): void => {
      Atomics.store(controlView, CONTROL.generation, STOP)
      Atomics.notify(controlView, CONTROL.generation)
      for (const worker of workers) void worker.terminate()
    },
    targets: formats.map((format, at) => {
      const buffer = targetBuffers[at]
      if (buffer === undefined) throw new Error('unreachable: target buffer')
      return {
        data: new Uint8Array(buffer),
        height: format.output.height,
        width: format.output.width,
      }
    }),
  }
}
