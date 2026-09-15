import { describe, expect, it } from 'vitest'

import { DEFAULT_FORMATS, resolveFormat } from '../../src/render/format.js'
import { baseRect } from '../../src/render/geometry.js'

const CAPTURE = { width: 2560, height: 1600 }

describe('output formats', () => {
  it('anchors the resting 16:9 crop at the top, where app chrome lives', () => {
    const rect = baseRect(CAPTURE, 16 / 9)
    expect(rect).toEqual({ x: 0, y: 0, width: 2560, height: 1440 })
  })

  it('delivers 1920x1080 with the 1.33x of zoom reserve PLAN.md promises', () => {
    const format = resolveFormat(DEFAULT_FORMATS[0]!, CAPTURE)
    expect(format.output).toEqual({ width: 1920, height: 1080 })
    expect(format.base).toEqual({ x: 0, y: 0, width: 2560, height: 1440 })
    expect(format.maxZoom).toBeCloseTo(2560 / 1920, 9)
    expect(format.upscaleClamp).toBeUndefined()
  })

  it('refuses to invent pixels for a portrait cut of a landscape capture', () => {
    // The tallest 9:16 rectangle inside 2560x1600 is 900x1600. A 1080x1920
    // delivery would have to be blown up, so it is clamped and said out loud.
    const format = resolveFormat(DEFAULT_FORMATS[1]!, CAPTURE)
    expect(format.base).toEqual({ x: 830, y: 0, width: 900, height: 1600 })
    expect(format.output.width).toBeLessThanOrEqual(format.base.width)
    expect(format.output.height).toBeLessThanOrEqual(format.base.height)
    expect(format.upscaleClamp).toMatch(/upscaling/)
  })

  it('delivers a square at the requested size, which the capture can pay for', () => {
    const format = resolveFormat(DEFAULT_FORMATS[2]!, CAPTURE)
    expect(format.base).toEqual({ x: 480, y: 0, width: 1600, height: 1600 })
    expect(format.output).toEqual({ width: 1080, height: 1080 })
    expect(format.upscaleClamp).toBeUndefined()
  })
})
