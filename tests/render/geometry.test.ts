import { describe, expect, it } from 'vitest'

import { contains, roundOutward, type Rect } from '../../src/render/geometry.js'

const CAPTURE: Rect = { x: 0, y: 0, width: 2560, height: 1600 }

/**
 * The aspect coupling in `roundOutward`, held to the figure its own comment
 * claims.
 *
 * The claim used to be "one part in two thousand" and the measured worst case
 * during a zoom move was 0.17% — 1938x1092 instead of 16:9, three and a half
 * times larger. A comment that overstates a numeric guarantee is worse than no
 * comment: the next reader budgets against it.
 */
describe('rounding a crop to whole even pixels', () => {
  const ASPECTS = [16 / 9, 1, 9 / 16, 4 / 3]

  it('lands exactly on the ratio across a sweep', () => {
    let worst = 0
    let checked = 0
    let counted = 0
    for (const aspect of ASPECTS) {
      for (let width = 320; width <= 2000; width += 7) {
        const height = width / aspect
        for (const offset of [0, 0.3, 0.5, 0.73, 0.99]) {
          const rect: Rect = {
            x: 100 + offset,
            y: 40 + offset,
            width: width + offset,
            height: height + offset,
          }
          // Only rectangles that fit inside the raster with room for the
          // rounding to grow into: at the raster's own edge the ratio yields on
          // purpose, and that case has its own test below.
          if (
            rect.x + rect.width + 20 > CAPTURE.width ||
            rect.y + rect.height + 20 > CAPTURE.height
          ) {
            continue
          }
          counted += 1
          const rounded = roundOutward(rect, CAPTURE, true, aspect)
          expect(rounded.width % 2).toBe(0)
          expect(rounded.height % 2).toBe(0)
          // Rounding may only ever grow the rectangle: whatever it contained
          // before it still contains.
          expect(contains(rounded, rect, 1)).toBe(true)
          const error =
            Math.abs(rounded.width / rounded.height - aspect) / aspect
          worst = Math.max(worst, error)
          checked += 1
        }
      }
    }
    // Both the figure and the size of the sweep behind it: a worst case of zero
    // over four rectangles would say nothing.
    expect(counted).toBeGreaterThan(400)
    expect(checked).toBe(counted)
    expect(worst).toBe(0)
  })

  it('is the case the old rounding got wrong', () => {
    // 1938x1090.125 is the interpolated crop measured mid-zoom that produced
    // 1938x1092 — 0.17% off 16:9 — under the round-the-derived-height rule.
    const aspect = 16 / 9
    const rect: Rect = { x: 311.4, y: 0.2, width: 1937.5, height: 1090.125 }
    const rounded = roundOutward(rect, CAPTURE, true, aspect)
    expect(contains(rounded, rect, 1)).toBe(true)
    expect(rounded.width / rounded.height).toBe(aspect)
    // The old rule produced 1938x1092 here, 0.17% off the ratio.
    expect(rounded).not.toEqual({ x: 311, y: 0, width: 1938, height: 1092 })
  })

  it('gives the ratio back rather than ask for pixels that do not exist', () => {
    // At the raster's own edge there is nothing left to grow into. The crop
    // stays inside the raster and the ratio yields — deliberately, and the only
    // place where it does.
    const rounded = roundOutward(
      { x: 0, y: 0, width: 2559.5, height: 1599.5 },
      CAPTURE,
      true,
      16 / 9,
    )
    expect(rounded.width).toBeLessThanOrEqual(CAPTURE.width)
    expect(rounded.height).toBeLessThanOrEqual(CAPTURE.height)
    expect(rounded.x).toBeGreaterThanOrEqual(0)
    expect(rounded.y).toBeGreaterThanOrEqual(0)
  })
})
