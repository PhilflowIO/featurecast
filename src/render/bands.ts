/**
 * How the frame work is cut up between threads.
 *
 * Composition is the renderer's whole cost — measured at 28 ms per output frame
 * for the three default formats out of a 2560x1600 capture, against about 10 ms
 * for everything else put together. Run on one thread that is 145 seconds for a
 * 48 second video, over the milestone's two-minute budget, and it also starves
 * the decoder: the process that reads the capture sits blocked on a full pipe
 * while the only thread that could drain it is busy scaling pixels. That is the
 * same shape of mistake as putting real per-frame work on a frame-delivery
 * callback, and it has the same cure — get it off that thread.
 *
 * The split is by output row, across all formats at once, because rows are the
 * unit that is genuinely independent: an output row reads the source rows its
 * own position maps to and writes only its own bytes. Work is weighted by row
 * width, so a 1920-wide landscape row counts more than a 1080-wide square one
 * and the threads finish together instead of one carrying the frame.
 *
 * Nothing here affects the picture. Any assignment of rows to threads produces
 * the same bytes, which is why the video does not depend on how many cores the
 * machine had — and why a test can render the same input at one thread and at
 * four and demand identical files.
 */

import type { Size } from './geometry.js'

/** One thread's share of one format's frame: rows `[start, end)`. */
export type Band = {
  format: number
  rowEnd: number
  rowStart: number
}

/**
 * Cuts every format's frame into `threads` shares of equal weighted height.
 *
 * Deterministic and total: every row of every format lands in exactly one band,
 * in order, whatever the thread count.
 */
export function planBands(outputs: readonly Size[], threads: number): Band[][] {
  if (threads < 1)
    throw new Error(`Thread count must be positive, got ${threads}`)
  const totalWeight = outputs.reduce(
    (sum, output) => sum + output.width * output.height,
    0,
  )
  const perThread = totalWeight / threads

  const plan: Band[][] = Array.from({ length: threads }, () => [])
  let weightSoFar = 0
  for (const [format, output] of outputs.entries()) {
    const rowWeight = output.width
    let row = 0
    while (row < output.height) {
      const thread = Math.min(threads - 1, Math.floor(weightSoFar / perThread))
      // How many rows are left before this thread's share is used up.
      const remaining = (thread + 1) * perThread - weightSoFar
      const rows = Math.max(
        1,
        Math.min(output.height - row, Math.round(remaining / rowWeight)),
      )
      plan[thread]?.push({ format, rowEnd: row + rows, rowStart: row })
      weightSoFar += rows * rowWeight
      row += rows
    }
  }
  return plan
}
