import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MAX_POINTER_STEP_PX } from '../../src/motion.js'
import {
  parseEventLog,
  parseEventTimes,
  toTimedEvents,
  type TimedEvent,
} from '../../src/render/events.js'
import {
  planRender,
  type CaptureInput,
  type RenderPlan,
} from '../../src/render/plan.js'

/**
 * How far the drawn pointer moves between two output frames — measured on the
 * decision data the renderer ships, not on the function that produces it.
 *
 * **This is the instrument that was missing, and the layer matters.**
 * `tests/render/cursor.test.ts` measures `pointerAt` and passes: interpolating
 * a 60Hz log at 60Hz cannot produce a jump, so the function is smooth by
 * construction and an assertion on it can only ever be green. What the viewer
 * sees is `FrameDecision.cursor`, which is that function evaluated on a
 * timeline the idle trimmer has already bent — and bending the timeline is
 * precisely what turns a smooth path into a series of jumps.
 *
 * Measured on the recording the owner watched (2026-09-15, 20.7s): the shipped
 * decisions moved the pointer up to **330px in one output frame**, against the
 * 20px the recorder guarantees between two samples. The owner's verdict on that
 * video was "krasse Diashow". No test in the suite objected, because no test
 * looked here. It reads 16.7px now.
 *
 * The bound is the recorder's own cap and not a number chosen here: the
 * renderer may slow the pointer down — that is what a compressed idle stretch
 * around it does — but it may never make it cover more ground per frame than
 * the recording did per sample. There is no material for the extra distance;
 * it can only come from time being taken away.
 */
function fixture(name: string, originMs: number): TimedEvent[] {
  const directory = join(import.meta.dirname, 'fixtures')
  return toTimedEvents(
    parseEventLog(readFileSync(join(directory, `${name}.jsonl`), 'utf8')),
    parseEventTimes(
      readFileSync(join(directory, `${name}.times.jsonl`), 'utf8'),
    ),
    originMs,
  )
}

/**
 * The capture of the first recording that showed the defect, frame times and
 * all: 117 frames for 20.9 seconds, recorded on the RTX 3090 box on
 * 2026-09-15.
 *
 * **What these three files contain is timing, and only timing.** A frame
 * manifest (file name plus timestamp), a pointer path, and the clock the two
 * share. No URL, no selector, no text, no pixel — nothing that says which
 * application was on screen. That is why they could stay when everything else
 * moved to the repository's own corpus, and it is worth knowing before anyone
 * assumes a recorded artifact carries a recording.
 *
 * **Why they were not re-recorded against the corpus.** They were, and the
 * result was an instrument that no longer moves: on a 31s corpus recording the
 * bound reads 18.8px and the counter-example below reads 19.3px, so a green
 * result would have proven nothing. The corpus's own still stretches sit
 * closer to its interactions, where `protectMs` shields them, and the
 * mutation then trims *less* rather than more. The gap structure of this
 * particular recording is the thing under test; swapping it for one that
 * cannot fail would swap the test for a decoration.
 *
 * **A synthetic stand-in was tried before that and could not reproduce it
 * either.** Marking a frame at each interaction puts every gap's end on an
 * interaction, so nothing was ever trimmed and the bound passed by having
 * nothing to measure.
 */
function benchCapture(): CaptureInput {
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dirname, 'fixtures', 'capture-bench.json'),
      'utf8',
    ),
  ) as CaptureInput
  return manifest
}

function worstPointerStep(plan: RenderPlan): {
  atMs: number
  frames: number
  worst: number
} {
  let worst = 0
  let atMs = 0
  let frames = 0
  for (const format of plan.formats) {
    for (const [index, decision] of format.frames.entries()) {
      const previous = format.frames[index - 1]
      if (previous === undefined) continue
      if (decision.cursor === null || previous.cursor === null) continue
      frames += 1
      // In *capture* pixels, deliberately. `screenX` moves when the camera
      // moves as well, so a big step in it accuses the wrong suspect — the
      // first attempt at this bound did exactly that and blamed the zoom.
      const step = Math.max(
        Math.abs(decision.cursor.sourceX - previous.cursor.sourceX),
        Math.abs(decision.cursor.sourceY - previous.cursor.sourceY),
      )
      if (step > worst) {
        worst = step
        atMs = decision.timeMs
      }
    }
  }
  return { atMs, frames, worst }
}

describe('the drawn pointer never moves further in one output frame than the recording moved in one sample', () => {
  const capture = benchCapture()
  const events = fixture('run-bench', capture.sessionStartedAt)

  it('holds over the recording the owner watched', () => {
    const plan = planRender(capture, events)
    const { frames, worst } = worstPointerStep(plan)
    // Denominators, so a plan that drew no pointer or trimmed nothing cannot
    // pass by having nothing to measure.
    expect(frames).toBeGreaterThan(1000)
    expect(plan.idle.removedMs).toBeGreaterThan(0)
    expect(worst).toBeLessThanOrEqual(MAX_POINTER_STEP_PX)
  })

  it('breaks when the pointer is trimmed through, which is why it passes', () => {
    // The mutation, applied by hand: let the trimmer treat any stretch the
    // picture held still as trimmable, whatever the pointer was doing in it —
    // which is what it did before, and what the owner watched. The path is the
    // same and the frames to cross it in are gone, so the pointer has to jump,
    // and the bound says so.
    //
    // This is the shape the instrument has to fail in. An earlier version
    // mutated `compressToMs` and `protectMs` instead, and once the fix was in
    // place that mutation stopped biting: the pointer rule held the line no
    // matter how hard the stretch was squeezed, so the counter-example proved
    // nothing about the bound above.
    const squeezed = worstPointerStep(
      planRender(capture, events, {
        idle: {
          pointerStillPxPerMs: Number.POSITIVE_INFINITY,
          maxPointerSpeedPxPerMs: Number.POSITIVE_INFINITY,
        },
      }),
    )
    expect(squeezed.worst).toBeGreaterThan(MAX_POINTER_STEP_PX * 2)
  })
})
