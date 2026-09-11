import { describe, expect, it } from 'vitest'

import { DEFAULT_CURSOR_LOOK } from '../../src/render/cursor.js'
import {
  drawCursorSprite,
  spriteGeometry,
  SpriteCache,
} from '../../src/render/sprite.js'

const LOOK = DEFAULT_CURSOR_LOOK
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function alphaSum(png: Buffer): number {
  // Cheap proxy for "something was drawn": compressed size grows with content.
  return png.length
}

describe('cursor sprites', () => {
  it('writes a real PNG with an RGBA header', () => {
    const png = drawCursorSprite('arrow', null, LOOK).toPng()
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE)
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    const { size } = spriteGeometry(LOOK)
    expect(png.readUInt32BE(16)).toBe(size)
    expect(png.readUInt32BE(20)).toBe(size)
    expect(png.readUInt8(24)).toBe(8)
    expect(png.readUInt8(25)).toBe(6)
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe(
      'IEND',
    )
  })

  it('is byte-identical between two draws of the same sprite', () => {
    const first = drawCursorSprite('arrow', 0.25, LOOK).toPng()
    const second = drawCursorSprite('arrow', 0.25, LOOK).toPng()
    expect(first.equals(second)).toBe(true)
  })

  it('draws a ripple that is visibly not the resting pointer', () => {
    const resting = drawCursorSprite('arrow', null, LOOK).toPng()
    const blooming = drawCursorSprite('arrow', 0.3, LOOK).toPng()
    expect(blooming.equals(resting)).toBe(false)
    expect(alphaSum(blooming)).toBeGreaterThan(alphaSum(resting))
  })

  it('draws a touch dot instead of an arrow on a touch recording', () => {
    const arrow = drawCursorSprite('arrow', null, LOOK).toPng()
    const touch = drawCursorSprite('touch', null, LOOK).toPng()
    expect(touch.equals(arrow)).toBe(false)
  })

  it('follows the size parameter instead of a compiled-in size', () => {
    const small = spriteGeometry({ ...LOOK, rippleRadiusPx: 20, sizePx: 12 })
    const large = spriteGeometry({ ...LOOK, rippleRadiusPx: 200, sizePx: 12 })
    expect(large.size).toBeGreaterThan(small.size)
    expect(small.hotspotX).toBe(small.size / 2)
  })

  it('rasterises each distinct phase once', () => {
    const cache = new SpriteCache(LOOK)
    const first = cache.png('arrow', 0.5)
    expect(cache.png('arrow', 0.5)).toBe(first)
    expect(cache.png('arrow', 0.6)).not.toBe(first)
  })
})
