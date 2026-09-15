import { describe, expect, it } from 'vitest'

import {
  compositeSprite,
  createRaster,
  rasterByteLength,
  resample,
  type Raster,
  type RgbaRaster,
} from '../../src/render/compose.js'
import { composeFrame } from '../../src/render/pipeline.js'
import type { FrameDecision } from '../../src/render/plan.js'
import { SpriteCache } from '../../src/render/sprite.js'
import { DEFAULT_CURSOR_LOOK } from '../../src/render/cursor.js'

/** A source raster whose every pixel encodes its own coordinates. */
function gradient(width: number, height: number): Raster {
  const raster = createRaster({ width, height })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3
      raster.data[index] = x % 256
      raster.data[index + 1] = y % 256
      raster.data[index + 2] = (x + y) % 256
    }
  }
  return raster
}

function pixel(raster: Raster, x: number, y: number): [number, number, number] {
  const index = (y * raster.width + x) * 3
  return [
    raster.data[index] ?? 0,
    raster.data[index + 1] ?? 0,
    raster.data[index + 2] ?? 0,
  ]
}

describe('reading a crop out of the source raster', () => {
  it('copies a crop of the target size exactly, pixel for pixel', () => {
    const source = gradient(64, 48)
    const target = createRaster({ width: 32, height: 24 })
    resample(source, { x: 10, y: 6, width: 32, height: 24 }, target)
    for (const [x, y] of [
      [0, 0],
      [31, 23],
      [17, 9],
    ] as const) {
      expect(pixel(target, x, y)).toEqual(pixel(source, x + 10, y + 6))
    }
  })

  it('refuses to magnify, because zoom is a crop and never an upscale', () => {
    const source = gradient(64, 48)
    const target = createRaster({ width: 32, height: 24 })
    expect(() =>
      resample(source, { x: 0, y: 0, width: 16, height: 12 }, target),
    ).toThrow(/never an upscale/)
  })

  it('is a pure function of the source and the rectangle', () => {
    const source = gradient(64, 48)
    const crop = { x: 4, y: 3, width: 48, height: 36 }
    const first = createRaster({ width: 32, height: 24 })
    const second = createRaster({ width: 32, height: 24 })
    resample(source, crop, first)
    resample(source, crop, second)
    expect([...first.data]).toEqual([...second.data])
  })

  it('lands a moved crop on moved content, not on a smeared neighbour', () => {
    // The defect this file exists to end: a crop shifted by one source pixel
    // must move the picture by exactly the corresponding amount, on the frame
    // it was asked for and no other.
    const source = gradient(64, 48)
    const still = createRaster({ width: 32, height: 24 })
    const moved = createRaster({ width: 32, height: 24 })
    resample(source, { x: 10, y: 6, width: 32, height: 24 }, still)
    resample(source, { x: 11, y: 6, width: 32, height: 24 }, moved)
    expect(pixel(moved, 0, 0)).toEqual(pixel(still, 1, 0))
  })

  it('counts the bytes one decoded frame occupies', () => {
    expect(rasterByteLength({ width: 2560, height: 1600 })).toBe(
      2560 * 1600 * 3,
    )
  })
})

describe('drawing the pointer onto a frame', () => {
  function solidSprite(size: number, alpha: number): RgbaRaster {
    const data = new Uint8ClampedArray(size * size * 4)
    for (let i = 0; i < size * size; i += 1) {
      data[i * 4] = 255
      data[i * 4 + 1] = 0
      data[i * 4 + 2] = 0
      data[i * 4 + 3] = alpha
    }
    return { data, height: size, width: size }
  }

  it('blends by the sprite’s own alpha', () => {
    const target = createRaster({ width: 8, height: 8 })
    target.data.fill(100)
    compositeSprite(target, solidSprite(2, 128), 1, 1)
    expect(pixel(target, 1, 1)).toEqual([
      Math.round(255 * (128 / 255) + 100 * (1 - 128 / 255)),
      Math.round(100 * (1 - 128 / 255)),
      Math.round(100 * (1 - 128 / 255)),
    ])
    expect(pixel(target, 0, 0)).toEqual([100, 100, 100])
  })

  it('clips at every edge instead of wrapping to the next row', () => {
    const target = createRaster({ width: 8, height: 8 })
    target.data.fill(0)
    compositeSprite(target, solidSprite(4, 255), -2, -2)
    expect(pixel(target, 0, 0)).toEqual([255, 0, 0])
    expect(pixel(target, 1, 1)).toEqual([255, 0, 0])
    expect(pixel(target, 2, 2)).toEqual([0, 0, 0])
    // Nothing may leak onto the far side of the row.
    expect(pixel(target, 7, 0)).toEqual([0, 0, 0])
  })

  it('draws nothing at all when the sprite is entirely off the frame', () => {
    const target = createRaster({ width: 8, height: 8 })
    target.data.fill(42)
    compositeSprite(target, solidSprite(4, 255), -20000, -20000)
    expect([...target.data].every((value) => value === 42)).toBe(true)
  })
})

describe('one composed output frame', () => {
  const sprites = new SpriteCache(DEFAULT_CURSOR_LOOK)
  const cursor = { geometry: sprites.geometry, sprites }

  function decision(overrides: Partial<FrameDecision> = {}): FrameDecision {
    return {
      crop: { x: 8, y: 4, width: 64, height: 48 },
      cursor: null,
      n: 0,
      timeMs: 0,
      ...overrides,
    }
  }

  it('places the pointer by its tip, not by the sprite’s corner', () => {
    const source = gradient(128, 96)
    const withCursor = createRaster({ width: 64, height: 48 })
    const without = createRaster({ width: 64, height: 48 })
    composeFrame(source, decision(), cursor, without)
    composeFrame(
      source,
      decision({
        cursor: {
          kind: 'arrow',
          ripplePhase: null,
          screenX: 32,
          screenY: 24,
        },
      }),
      cursor,
      withCursor,
    )
    expect([...withCursor.data]).not.toEqual([...without.data])
    // The arrow's tip is at the hotspot and its body extends down and right,
    // so the pixel above the hotspot is still untouched background.
    expect(pixel(withCursor, 32, 20)).toEqual(pixel(without, 32, 20))
    expect(pixel(withCursor, 33, 26)).not.toEqual(pixel(without, 33, 26))
  })

  it('produces identical bytes from identical decisions', () => {
    const source = gradient(128, 96)
    const a = createRaster({ width: 64, height: 48 })
    const b = createRaster({ width: 64, height: 48 })
    const same = decision({
      cursor: { kind: 'arrow', ripplePhase: 0.25, screenX: 20, screenY: 30 },
    })
    composeFrame(source, same, cursor, a)
    composeFrame(source, same, cursor, b)
    expect([...a.data]).toEqual([...b.data])
  })

  it('draws no pointer when the decision carries none', () => {
    const source = gradient(128, 96)
    const painted = createRaster({ width: 64, height: 48 })
    const plain = createRaster({ width: 64, height: 48 })
    composeFrame(source, decision(), cursor, painted)
    composeFrame(source, decision(), null, plain)
    expect([...painted.data]).toEqual([...plain.data])
  })
})
