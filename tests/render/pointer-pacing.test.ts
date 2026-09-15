import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MAX_POINTER_STEP_PX } from '../../src/motion.js'
import type { RecordEvent } from '../../src/record.js'
import { parseEventLog } from '../../src/render/events.js'
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
 * Measured on the first real recording (OnlyDash, 2026-09-15, 20.7s): the
 * shipped decisions moved the pointer up to **66px in one output frame**,
 * against the 20px the recorder guarantees between two samples. The owner's
 * verdict on that video was "krasse Diashow". No test in the suite objected,
 * because no test looked here.
 *
 * The bound is the recorder's own cap and not a number chosen here: the
 * renderer may slow the pointer down — that is what a compressed idle stretch
 * around it does — but it may never make it cover more ground per frame than
 * the recording did per sample. There is no material for the extra distance;
 * it can only come from time being taken away.
 */
const FRAME_MS = 1000 / 60

function fixture(name: string): RecordEvent[] {
  return parseEventLog(
    readFileSync(
      join(import.meta.dirname, 'fixtures', `${name}.jsonl`),
      'utf8',
    ),
  )
}

/**
 * The capture of the first real recording, frame times and all.
 *
 * `tests/render/fixtures/capture-onlydash.json` is the frame manifest of
 * `demo/m4-acceptance.ts` run against the OnlyDash guest UI on the RTX 3090 box
 * on 2026-09-15, and `run-onlydash.jsonl` is the event log written beside it.
 * 117 frames for 20.9 seconds — which is not a broken capture but what every
 * recording of a real application looks like: between two interactions the page
 * does not change a pixel while the pointer crosses it, and the capture folds
 * bit-identical frames into their predecessor's dwell time.
 *
 * **A synthetic stand-in was tried first and could not reproduce the defect.**
 * Marking a frame at each interaction puts every gap's end on an interaction,
 * where `protectMs` shields it, so nothing was ever trimmed and the bound below
 * passed by having nothing to measure. The gap structure of a real recording is
 * the thing under test; inventing one invents the answer.
 */
function onlydashCapture(): CaptureInput {
  const manifest = JSON.parse(
    readFileSync(
      join(import.meta.dirname, 'fixtures', 'capture-onlydash.json'),
      'utf8',
    ),
  ) as {
    frames: Array<{ file: string; offsetMs: number }>
    sessionDurationMs: number
    source: { height: number; width: number }
  }
  return {
    frames: manifest.frames.map((frame) => ({
      file: frame.file,
      timestamp: frame.offsetMs,
    })),
    sessionDurationMs: manifest.sessionDurationMs,
    sessionStartedAt: 0,
    source: manifest.source,
  }
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
  const events = fixture('run-onlydash')
  const capture = onlydashCapture()

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
    // The mutation, applied by hand: squeeze every still stretch and protect
    // nothing. The path is the same and the frames to cross it in are gone, so
    // the pointer has to jump — and the bound says so.
    const squeezed = worstPointerStep(
      planRender(capture, events, {
        idle: { compressToMs: 4 * FRAME_MS, protectMs: 0, thresholdMs: 120 },
      }),
    )
    expect(squeezed.worst).toBeGreaterThan(MAX_POINTER_STEP_PX * 2)
  })
})
