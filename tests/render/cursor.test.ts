import { describe, expect, it } from 'vitest'

import { MAX_POINTER_STEP_PX } from '../../src/motion.js'
import {
  cursorAt,
  DEFAULT_CURSOR_LOOK,
  IDENTITY_TRANSFORM,
  inferCursorKind,
  pointerAt,
  rippleStarts,
  screenToVideoUV,
} from '../../src/render/cursor.js'
import { drawCursorSprite, spriteGeometry } from '../../src/render/sprite.js'
import { pointerSamples } from '../../src/render/zoom.js'
import { recordedFixture as fixture } from './timed.js'

/**
 * The pointer the browser never drew, measured.
 *
 * **This file exists because a mutation sweep found nothing here to break.**
 * Freezing `pointerAt` on its first sample — a pointer that stands still for
 * the whole video — left the suite green. So did shrinking the arrow from 46px
 * to 4px, freezing the ripple mid-bloom, and pinning `pixelRatio` to 2. Nothing
 * imported `cursorAt`, `pointerAt`, `rippleStarts` or `screenToVideoUV`; the
 * three files that touched `cursor.js` at all took `DEFAULT_CURSOR_LOOK` as an
 * opaque value. Half of what this milestone promises — "cursor and click
 * ripple are drawn here, not recorded" — had no measurement of any kind.
 *
 * The material is a real recording, so the numbers below are what the shipped
 * renderer does to a log a script actually produced, not to a shape invented
 * to make an assertion pass.
 */
const FRAME_MS = 1000 / 60

const events = fixture('run-a')
const samples = pointerSamples(events)

describe('the drawn pointer follows the recorded path', () => {
  it('sits exactly on every logged sample at that sample time', () => {
    expect(samples.length).toBeGreaterThan(200)
    for (const sample of samples) {
      expect(pointerAt(samples, sample.timeMs)).toEqual({
        x: sample.x,
        y: sample.y,
      })
    }
  })

  it('travels the whole path, not a fraction of it', () => {
    // The denominator that makes a frozen pointer impossible to miss. Drawn
    // travel is measured at the output grid and compared with the travel the
    // log itself contains; a pointer stuck on its first sample would report 0
    // against 2032.1.
    const logged = samples.slice(1).reduce((total, sample, index) => {
      const previous = samples[index]
      return previous === undefined
        ? total
        : total + Math.hypot(sample.x - previous.x, sample.y - previous.y)
    }, 0)
    const first = samples[0]
    const last = samples[samples.length - 1]
    expect(first).toBeDefined()
    expect(last).toBeDefined()
    if (first === undefined || last === undefined) return

    let drawn = 0
    let previous = pointerAt(samples, first.timeMs)
    for (
      let timeMs = first.timeMs + FRAME_MS;
      timeMs <= last.timeMs;
      timeMs += FRAME_MS
    ) {
      const point = pointerAt(samples, timeMs)
      if (point === undefined || previous === undefined) continue
      drawn += Math.hypot(point.x - previous.x, point.y - previous.y)
      previous = point
    }
    expect(logged).toBeCloseTo(2032.1, 1)
    // Sampling a dense path on a grid can only lose length, never gain it, and
    // the log is already at 60Hz — so the two agree to within a percent.
    expect(drawn).toBeGreaterThan(logged * 0.99)
    expect(drawn).toBeLessThanOrEqual(logged + 1e-6)
  })

  it('never jumps further in one output frame than the recorder allows in one sample', () => {
    // The visible form of M2's acceptance contract: whatever the renderer draws
    // between two frames stays inside the same 20px ceiling the recorder holds
    // between two samples, so interpolation cannot introduce a jump the
    // recording did not have.
    const first = samples[0]
    const last = samples[samples.length - 1]
    if (first === undefined || last === undefined) return
    let worst = 0
    let checked = 0
    for (
      let timeMs = first.timeMs;
      timeMs + FRAME_MS <= last.timeMs;
      timeMs += FRAME_MS
    ) {
      const a = pointerAt(samples, timeMs)
      const b = pointerAt(samples, timeMs + FRAME_MS)
      if (a === undefined || b === undefined) continue
      checked += 1
      worst = Math.max(worst, Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    }
    expect(checked).toBe(336)
    expect(worst).toBeLessThanOrEqual(MAX_POINTER_STEP_PX)
  })

  it('interpolates between samples instead of snapping to one of them', () => {
    const left = samples[40]
    const right = samples[41]
    expect(left).toBeDefined()
    expect(right).toBeDefined()
    if (left === undefined || right === undefined) return
    const middle = pointerAt(samples, (left.timeMs + right.timeMs) / 2)
    expect(middle).toEqual({
      x: (left.x + right.x) / 2,
      y: (left.y + right.y) / 2,
    })
    // And the two neighbours differ, so the midpoint is a real claim rather
    // than the same point three times.
    expect(left).not.toEqual({ x: right.x, y: right.y })
  })
})

describe('the click ripple', () => {
  const ripples = rippleStarts(events)

  it('starts once per interaction, at the interaction', () => {
    const interactions = events.filter(
      ({ event }) => event.type === 'click' || event.type === 'tap',
    )
    expect(interactions.length).toBe(1)
    expect(ripples).toEqual(interactions.map(({ timeMs }) => timeMs))
  })

  it('blooms from 0 to 1 across the look and is absent outside it', () => {
    const start = ripples[0]
    expect(start).toBeDefined()
    if (start === undefined) return
    const look = DEFAULT_CURSOR_LOOK
    expect(cursorAt(start - 1, samples, ripples, look)?.ripplePhase).toBeNull()
    expect(cursorAt(start, samples, ripples, look)?.ripplePhase).toBe(0)
    // A quarter and a half through, named — a phase frozen at any one value
    // fails at least one of these.
    expect(
      cursorAt(start + look.rippleMs / 4, samples, ripples, look)?.ripplePhase,
    ).toBeCloseTo(0.25, 10)
    expect(
      cursorAt(start + look.rippleMs / 2, samples, ripples, look)?.ripplePhase,
    ).toBeCloseTo(0.5, 10)
    expect(
      cursorAt(start + look.rippleMs - 1, samples, ripples, look)?.ripplePhase,
    ).toBeGreaterThan(0.99)
    expect(
      cursorAt(start + look.rippleMs, samples, ripples, look)?.ripplePhase,
    ).toBeNull()
  })

  it('takes its length from the look rather than from a constant', () => {
    const start = ripples[0]
    if (start === undefined) return
    const brief = { ...DEFAULT_CURSOR_LOOK, rippleMs: 100 }
    expect(
      cursorAt(start + 99, samples, ripples, brief)?.ripplePhase,
    ).toBeCloseTo(0.99, 10)
    expect(
      cursorAt(start + 100, samples, ripples, brief)?.ripplePhase,
    ).toBeNull()
  })
})

describe('the look is a set of numbers that reach the drawing', () => {
  it('sizes the sprite from the look, so a smaller pointer is a smaller sprite', () => {
    // `spriteGeometry` is the only place the look becomes pixels, and the
    // hotspot has to stay in the middle whatever the size — a sprite that grew
    // without its hotspot moving would draw the pointer off its own tip.
    const small = spriteGeometry({
      ...DEFAULT_CURSOR_LOOK,
      rippleRadiusPx: 10,
      sizePx: 4,
    })
    const shipped = spriteGeometry(DEFAULT_CURSOR_LOOK)
    expect(small.size).toBe(28)
    expect(shipped.size).toBe(164)
    expect(shipped.hotspotX).toBe(shipped.size / 2)
    expect(shipped.hotspotY).toBe(shipped.size / 2)
    // The canvas follows whichever of the two is larger, because both are drawn
    // into it.
    expect(
      spriteGeometry({
        ...DEFAULT_CURSOR_LOOK,
        rippleRadiusPx: 10,
        sizePx: 200,
      }).size,
    ).toBe(408)
  })

  it('is the look that ships, number by number', () => {
    // The shipped values, written down. Everything else in this file measures
    // behaviour *relative* to the look, which is the right way round — but it
    // also means a changed default slips through every one of those tests. A
    // mutation sweep found exactly that: 46px to 4px, and 520ms to 600ms, both
    // silent.
    expect(DEFAULT_CURSOR_LOOK).toEqual({
      kind: 'arrow',
      rippleMs: 520,
      rippleRadiusPx: 78,
      sizePx: 46,
      visible: true,
    })
  })

  it('draws a bigger arrow for a bigger sizePx, in pixels on the sprite', () => {
    // The number has to reach the drawing, not just the geometry: the sprite
    // canvas is sized off `max(rippleRadiusPx, sizePx)`, so at the shipped look
    // the ripple radius decides the canvas and `sizePx` alone would never move
    // it. What moves is how much of that canvas the arrow covers.
    const inked = (sizePx: number): number => {
      const canvas = drawCursorSprite('arrow', null, {
        ...DEFAULT_CURSOR_LOOK,
        sizePx,
      })
      let painted = 0
      for (let index = 3; index < canvas.pixels.length; index += 4) {
        if ((canvas.pixels[index] ?? 0) > 0) painted += 1
      }
      return painted
    }
    const shipped = inked(DEFAULT_CURSOR_LOOK.sizePx)
    // Named, so a silent change of the arrow's size shows up as a number and
    // not as a vague inequality.
    expect(shipped).toBe(827)
    expect(inked(4)).toBe(28)
    expect(inked(92)).toBe(3138)
  })

  it('draws nothing at all when the look says so', () => {
    expect(
      cursorAt(samples[10]?.timeMs ?? 0, samples, [], {
        ...DEFAULT_CURSOR_LOOK,
        visible: false,
      }),
    ).toBeUndefined()
  })

  it('reads the pointer kind off the recording, not off a default', () => {
    expect(inferCursorKind(events)).toBe('arrow')
    expect(inferCursorKind(fixture('run-touch'))).toBe('touch')
    expect(inferCursorKind(fixture('run-crowded-taps'))).toBe('touch')
  })
})

describe('recorded coordinates become raster coordinates', () => {
  it('scales by the pixel ratio it is given, not by a hard-coded 2', () => {
    // Upstream wrote the ratio in as a literal `* 2`. Our desktop capture
    // records CSS pixels one to one, so a pinned 2 would put the pointer at
    // twice its distance from the top-left corner of every frame.
    const transform = IDENTITY_TRANSFORM(2560, 1600)
    expect(transform.pixelRatio).toBe(1)
    expect(screenToVideoUV(1280, 800, transform)).toEqual({ u: 0.5, v: 0.5 })
    expect(screenToVideoUV(1280, 800, { ...transform, pixelRatio: 2 })).toEqual(
      { u: 1, v: 1 },
    )
  })

  it('clamps to the raster instead of drawing outside it', () => {
    const transform = IDENTITY_TRANSFORM(2560, 1600)
    expect(screenToVideoUV(-100, -100, transform)).toEqual({ u: 0, v: 0 })
    expect(screenToVideoUV(9999, 9999, transform)).toEqual({ u: 1, v: 1 })
  })

  it('subtracts the window origin before scaling', () => {
    const transform = {
      ...IDENTITY_TRANSFORM(2560, 1600),
      windowX: 260,
      windowY: 100,
    }
    expect(screenToVideoUV(1540, 900, transform)).toEqual({ u: 0.5, v: 0.5 })
  })
})
