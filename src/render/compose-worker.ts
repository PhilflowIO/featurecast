/**
 * One composition thread.
 *
 * It owns nothing and decides nothing: it waits for the main thread to say
 * "frame ready in slot N with these crops", fills its share of rows in shared
 * memory, and says it is done. The crops come from `decisions.json` by way of a
 * shared Float64Array; no plan, no clock and no event log is visible from here,
 * which is the point — there is no state in this thread that could differ
 * between two runs.
 */

import { parentPort, workerData } from 'node:worker_threads'

import type { Band } from './bands.js'
// The one place in the codebase that imports a `.ts` path on purpose. A worker
// thread does not inherit the parent's module loader, so this file and
// everything it reaches have to resolve under plain Node. Every other import
// here is type-only and disappears, and `compose.ts` has no runtime imports of
// its own, so this single specifier is the whole graph.
import { resample, type Raster } from './compose.ts'
import type { Rect } from './geometry.js'

/** Layout of the shared control block, in Int32 slots. */
export const CONTROL = {
  /** Bumped by the main thread when a frame is ready. Workers wait on it. */
  generation: 0,
  /** Incremented by each worker as it finishes. */
  done: 1,
  /** Which source slot the ready frame is in. */
  slot: 2,
  length: 3,
} as const

/** The generation value that means "no more frames, shut down". */
export const STOP = -1

export type WorkerSetup = {
  bands: readonly Band[]
  control: SharedArrayBuffer
  crops: SharedArrayBuffer
  sourceSize: { height: number; width: number }
  sourceSlots: readonly SharedArrayBuffer[]
  targets: ReadonlyArray<{
    buffer: SharedArrayBuffer
    height: number
    width: number
  }>
}

export function runWorker(setup: WorkerSetup, signalReady: () => void): void {
  const control = new Int32Array(setup.control)
  const crops = new Float64Array(setup.crops)
  const sources: Raster[] = setup.sourceSlots.map((buffer) => ({
    data: new Uint8Array(buffer),
    height: setup.sourceSize.height,
    width: setup.sourceSize.width,
  }))
  const targets: Raster[] = setup.targets.map((target) => ({
    data: new Uint8Array(target.buffer),
    height: target.height,
    width: target.width,
  }))

  signalReady()
  let seen = 0
  for (;;) {
    Atomics.wait(control, CONTROL.generation, seen)
    const generation = Atomics.load(control, CONTROL.generation)
    if (generation === STOP) return
    if (generation === seen) continue
    seen = generation

    const source = sources[Atomics.load(control, CONTROL.slot)]
    if (source === undefined)
      throw new Error('unreachable: unknown source slot')
    for (const band of setup.bands) {
      const target = targets[band.format]
      if (target === undefined) {
        throw new Error(
          `unreachable: no target for format ${String(band.format)}`,
        )
      }
      const at = band.format * 4
      const crop: Rect = {
        x: crops[at] ?? 0,
        y: crops[at + 1] ?? 0,
        width: crops[at + 2] ?? 0,
        height: crops[at + 3] ?? 0,
      }
      resample(source, crop, target, band.rowStart, band.rowEnd)
    }

    Atomics.add(control, CONTROL.done, 1)
    Atomics.notify(control, CONTROL.done)
  }
}

if (parentPort !== null) {
  const port = parentPort
  runWorker(workerData as WorkerSetup, () => {
    port.postMessage('ready')
  })
}
