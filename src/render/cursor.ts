/**
 * Copyright (c) 2025 Blitz
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * `screenToVideoUV` is derived from pythonlearner1025/Screen-Studio-Effects
 * src/cursor.ts at commit bcaa05c2a39e7ccb4d747bba936f93f15350bc0a. See
 * THIRD-PARTY.md.
 */

import type { TimedEvent } from './events.js'
import type { PointerSample } from './rest.js'

/**
 * Where the recorded pointer coordinates live relative to the captured raster.
 *
 * Upstream writes the device pixel ratio into the code as a literal: line 45-46
 * of its `cursor.ts` read `const videoX = (x - transform.windowX) * 2`, which
 * silently assumes a Retina screen captured at twice its point size. Here it is
 * `pixelRatio`, an argument — our desktop capture records CSS pixels one to one
 * (ratio 1), and the mobile work in M3 may well land on something else.
 */
export type CursorTransform = {
  captureHeight: number
  captureWidth: number
  pixelRatio: number
  windowX: number
  windowY: number
}

export const IDENTITY_TRANSFORM = (
  captureWidth: number,
  captureHeight: number,
): CursorTransform => ({
  captureHeight,
  captureWidth,
  pixelRatio: 1,
  windowX: 0,
  windowY: 0,
})

/** Converts recorded pointer coordinates to normalised raster coordinates. */
export function screenToVideoUV(
  x: number,
  y: number,
  transform: CursorTransform,
): { u: number; v: number } {
  const videoX = (x - transform.windowX) * transform.pixelRatio
  const videoY = (y - transform.windowY) * transform.pixelRatio
  return {
    u: Math.max(0, Math.min(1, videoX / transform.captureWidth)),
    v: Math.max(0, Math.min(1, videoY / transform.captureHeight)),
  }
}

/** How the pointer is drawn. Headless Chromium draws none, so this is all of it. */
export type CursorKind = 'arrow' | 'touch'

export type CursorLook = {
  /** Height of the arrow, or diameter of the touch dot, in output pixels. */
  sizePx?: number
  kind?: CursorKind
  /** How long a click ripple blooms and fades, in milliseconds. */
  rippleMs?: number
  /** Outer radius the ripple reaches, in output pixels. */
  rippleRadiusPx?: number
  /** Draw the pointer at all. A pure-scroll demo may not want one. */
  visible?: boolean
}

export const DEFAULT_CURSOR_LOOK: Required<CursorLook> = {
  kind: 'arrow',
  rippleMs: 520,
  rippleRadiusPx: 78,
  sizePx: 46,
  visible: true,
}

/**
 * The size of the two pointers, which is not one number.
 *
 * 46px is an arrow's height, and an arrow is a small shape with a sharp tip:
 * the eye finds it because it is pointed, not because it is large. A touch dot
 * has no tip — it is a disc, and a disc that small on a 1080-wide portrait
 * frame reads as a speck of dust rather than as a finger. A real fingertip
 * presses roughly 45 CSS pixels of a phone's screen, which is about 125 of a
 * mobile recording's picture pixels; 84 is deliberately under that, big enough
 * to follow across a swipe and small enough not to sit on the content it is
 * pointing at.
 */
const TOUCH_SIZE_PX = 84
const TOUCH_RIPPLE_RADIUS_PX = 132

/**
 * The look for a recording, with the defaults that belong to its pointer.
 *
 * One function rather than two spread objects: the plan decides which pointer
 * a recording gets, and the painter has to raster exactly that one. When both
 * assembled their own look from the same constant they agreed by luck, and a
 * kind-dependent default is precisely the change that would have broken it.
 */
export function cursorLookFor(
  kind: CursorKind,
  overrides: CursorLook = {},
): Required<CursorLook> {
  return {
    ...DEFAULT_CURSOR_LOOK,
    ...(kind === 'touch'
      ? { rippleRadiusPx: TOUCH_RIPPLE_RADIUS_PX, sizePx: TOUCH_SIZE_PX }
      : {}),
    kind,
    ...overrides,
  }
}

/** What to draw at one moment, in source-capture pixels. */
export type CursorFrame = {
  kind: CursorKind
  /** 0..1 while a click ripple is blooming, null when there is none. */
  ripplePhase: number | null
  x: number
  y: number
}

/**
 * Pointer position at an arbitrary moment, interpolated between the logged
 * samples. The log is a dense 60 Hz path with a guaranteed 20px ceiling
 * between neighbours, so straight interpolation is accurate here; there is no
 * need for the upstream re-smoothing pass, which exists to rescue sparse,
 * irregular OS-level cursor events.
 */
export function pointerAt(
  samples: readonly PointerSample[],
  timeMs: number,
): { x: number; y: number } | undefined {
  if (samples.length === 0) return undefined
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first === undefined || last === undefined) return undefined
  if (timeMs <= first.timeMs) return { x: first.x, y: first.y }
  if (timeMs >= last.timeMs) return { x: last.x, y: last.y }

  let low = 0
  let high = samples.length - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    const sample = samples[mid]
    if (sample === undefined) break
    if (sample.timeMs <= timeMs) low = mid
    else high = mid
  }
  const left = samples[low]
  const right = samples[high]
  if (left === undefined || right === undefined) return undefined
  const span = right.timeMs - left.timeMs
  if (span <= 0) return { x: right.x, y: right.y }
  const t = (timeMs - left.timeMs) / span
  return {
    x: left.x + (right.x - left.x) * t,
    y: left.y + (right.y - left.y) * t,
  }
}

/**
 * How far the drawn pointer travels between two moments, in capture pixels.
 *
 * This is the question idle trimming has to ask before it calls a stretch
 * still. Its own signal is whether the *picture* changed, and a page at rest
 * with a pointer crossing it does not change a pixel — the capture folds those
 * frames together, a long gap opens between two surviving frames, and the
 * trimmer compresses the very stretch the pointer needed to cross. Measured on
 * the first real recording, that turned a path the recorder walked at 20px per
 * sample into one the renderer drew at 338px per output frame.
 *
 * The path is measured, not the displacement: a pointer that goes out and comes
 * back has moved, even though it ends where it began. Samples outside the
 * window are ignored except for the interpolated positions at its edges, which
 * is what the renderer actually draws there.
 */
export function pointerTravelPx(
  samples: readonly PointerSample[],
  startMs: number,
  endMs: number,
): number {
  const from = pointerAt(samples, startMs)
  const to = pointerAt(samples, endMs)
  if (from === undefined || to === undefined) return 0
  let travel = 0
  let previous = from
  for (const sample of samples) {
    if (sample.timeMs <= startMs) continue
    if (sample.timeMs >= endMs) break
    travel += Math.hypot(sample.x - previous.x, sample.y - previous.y)
    previous = sample
  }
  return travel + Math.hypot(to.x - previous.x, to.y - previous.y)
}

/** Moments at which a ripple starts, taken from the clicks and taps. */
export function rippleStarts(events: readonly TimedEvent[]): number[] {
  const starts: number[] = []
  for (const { event, timeMs } of events) {
    if (event.type === 'click' || event.type === 'tap') starts.push(timeMs)
  }
  return starts
}

/**
 * Picks the kind of pointer that fits the recording: a tap anywhere in the log
 * means a touch device, where an arrow would be a lie.
 */
export function inferCursorKind(events: readonly TimedEvent[]): CursorKind {
  return events.some(({ event }) => event.type === 'tap') ? 'touch' : 'arrow'
}

/** What to draw at one moment. Pure in time. */
export function cursorAt(
  timeMs: number,
  samples: readonly PointerSample[],
  ripples: readonly number[],
  look: Required<CursorLook>,
): CursorFrame | undefined {
  if (!look.visible) return undefined
  const position = pointerAt(samples, timeMs)
  if (position === undefined) return undefined
  let ripplePhase: number | null = null
  for (const start of ripples) {
    if (timeMs < start || timeMs >= start + look.rippleMs) continue
    ripplePhase = (timeMs - start) / look.rippleMs
    break
  }
  return { kind: look.kind, ripplePhase, x: position.x, y: position.y }
}
