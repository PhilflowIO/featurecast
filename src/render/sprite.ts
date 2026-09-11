import { deflateSync } from 'node:zlib'

import type { CursorKind, CursorLook } from './cursor.js'

/**
 * Cursor sprites, drawn here rather than in the browser.
 *
 * Headless Chromium renders no pointer at all, so there is nothing to capture
 * and nothing to burn in — the pointer is a render parameter. These are plain
 * RGBA rasters written as PNG with Node's own zlib; no image dependency, and
 * the same input always yields the same bytes.
 */

type Rgba = readonly [number, number, number, number]

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** An 8-bit RGBA raster with straight (non-premultiplied) alpha. */
export class Canvas {
  readonly height: number
  readonly pixels: Uint8ClampedArray
  readonly width: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.pixels = new Uint8ClampedArray(width * height * 4)
  }

  blend(x: number, y: number, color: Rgba, coverage: number): void {
    if (
      coverage <= 0 ||
      x < 0 ||
      y < 0 ||
      x >= this.width ||
      y >= this.height
    ) {
      return
    }
    const alpha = (color[3] / 255) * coverage
    if (alpha <= 0) return
    const index = (y * this.width + x) * 4
    const dstAlpha = (this.pixels[index + 3] ?? 0) / 255
    const outAlpha = alpha + dstAlpha * (1 - alpha)
    if (outAlpha <= 0) return
    for (let channel = 0; channel < 3; channel += 1) {
      const src = color[channel] ?? 0
      const dst = this.pixels[index + channel] ?? 0
      this.pixels[index + channel] =
        (src * alpha + dst * dstAlpha * (1 - alpha)) / outAlpha
    }
    this.pixels[index + 3] = outAlpha * 255
  }

  toPng(): Buffer {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(this.width, 0)
    header.writeUInt32BE(this.height, 4)
    header.writeUInt8(8, 8) // bit depth
    header.writeUInt8(6, 9) // truecolour with alpha
    const stride = this.width * 4
    const raw = Buffer.alloc((stride + 1) * this.height)
    for (let y = 0; y < this.height; y += 1) {
      raw[y * (stride + 1)] = 0 // filter: none
      for (let i = 0; i < stride; i += 1) {
        raw[y * (stride + 1) + 1 + i] = this.pixels[y * stride + i] ?? 0
      }
    }
    return Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  }
}

type Point = { x: number; y: number }

/** Samples per axis inside each pixel. Three is enough to hide the stair-steps. */
const SUPERSAMPLE = 3

function insidePolygon(
  points: readonly Point[],
  x: number,
  y: number,
): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i]
    const b = points[j]
    if (a === undefined || b === undefined) continue
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside
    }
  }
  return inside
}

export function fillPolygon(
  canvas: Canvas,
  points: readonly Point[],
  color: Rgba,
): void {
  if (points.length < 3) return
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.max(0, Math.floor(Math.min(...xs)))
  const maxX = Math.min(canvas.width - 1, Math.ceil(Math.max(...xs)))
  const minY = Math.max(0, Math.floor(Math.min(...ys)))
  const maxY = Math.min(canvas.height - 1, Math.ceil(Math.max(...ys)))
  const step = 1 / SUPERSAMPLE
  const samples = SUPERSAMPLE * SUPERSAMPLE
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let hits = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          if (
            insidePolygon(points, x + (sx + 0.5) * step, y + (sy + 0.5) * step)
          ) {
            hits += 1
          }
        }
      }
      canvas.blend(x, y, color, hits / samples)
    }
  }
}

export function fillRing(
  canvas: Canvas,
  centerX: number,
  centerY: number,
  outerRadius: number,
  innerRadius: number,
  color: Rgba,
): void {
  if (outerRadius <= 0) return
  const minX = Math.max(0, Math.floor(centerX - outerRadius))
  const maxX = Math.min(canvas.width - 1, Math.ceil(centerX + outerRadius))
  const minY = Math.max(0, Math.floor(centerY - outerRadius))
  const maxY = Math.min(canvas.height - 1, Math.ceil(centerY + outerRadius))
  const step = 1 / SUPERSAMPLE
  const samples = SUPERSAMPLE * SUPERSAMPLE
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let hits = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const dx = x + (sx + 0.5) * step - centerX
          const dy = y + (sy + 0.5) * step - centerY
          const distance = Math.sqrt(dx * dx + dy * dy)
          if (distance <= outerRadius && distance >= innerRadius) hits += 1
        }
      }
      canvas.blend(x, y, color, hits / samples)
    }
  }
}

/**
 * The arrow outline, in units of its own height with the tip at the origin.
 * A classic pointer: long left edge, notch, tail.
 */
const ARROW_PATH: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 0, y: 0.735 },
  { x: 0.196, y: 0.57 },
  { x: 0.325, y: 0.87 },
  { x: 0.452, y: 0.815 },
  { x: 0.322, y: 0.525 },
  { x: 0.53, y: 0.505 },
]

const WHITE: Rgba = [255, 255, 255, 255]
const INK: Rgba = [17, 20, 24, 235]

function easeOutCubic(t: number): number {
  const u = 1 - t
  return 1 - u * u * u
}

export type SpriteGeometry = {
  hotspotX: number
  hotspotY: number
  size: number
}

/** Sprite canvas size and where the pointer tip sits inside it. */
export function spriteGeometry(look: Required<CursorLook>): SpriteGeometry {
  const radius = Math.ceil(Math.max(look.rippleRadiusPx, look.sizePx))
  const size = radius * 2 + 8 + ((radius * 2 + 8) % 2)
  return { hotspotX: size / 2, hotspotY: size / 2, size }
}

/**
 * Draws one pointer sprite: the ripple, if one is blooming, and the pointer
 * itself, with the hotspot at the sprite's centre.
 */
export function drawCursorSprite(
  kind: CursorKind,
  ripplePhase: number | null,
  look: Required<CursorLook>,
): Canvas {
  const { hotspotX, hotspotY, size } = spriteGeometry(look)
  const canvas = new Canvas(size, size)

  if (ripplePhase !== null && ripplePhase >= 0 && ripplePhase < 1) {
    const outer = look.rippleRadiusPx * easeOutCubic(ripplePhase)
    const thickness = Math.max(2, look.rippleRadiusPx * 0.08)
    const alpha = Math.round(215 * Math.pow(1 - ripplePhase, 1.5))
    fillRing(
      canvas,
      hotspotX,
      hotspotY,
      outer,
      Math.max(0, outer - thickness),
      [255, 255, 255, alpha],
    )
    fillRing(canvas, hotspotX, hotspotY, Math.max(0, outer - thickness), 0, [
      255,
      255,
      255,
      Math.round(alpha * 0.16),
    ])
  }

  if (kind === 'touch') {
    const radius = look.sizePx / 2
    fillRing(canvas, hotspotX, hotspotY, radius, 0, [255, 255, 255, 170])
    fillRing(canvas, hotspotX, hotspotY, radius, radius - 2.5, INK)
    return canvas
  }

  const scale = look.sizePx
  const outline = Math.max(1.5, scale * 0.055)
  const path = ARROW_PATH.map((point) => ({
    x: hotspotX + point.x * scale,
    y: hotspotY + point.y * scale,
  }))
  // An outline drawn as eight offset copies of the same polygon. Cheap, and
  // the sprite is rasterised a few dozen times per render, not per frame.
  for (let angle = 0; angle < 8; angle += 1) {
    const radians = (angle * Math.PI) / 4
    fillPolygon(
      canvas,
      path.map((point) => ({
        x: point.x + Math.cos(radians) * outline,
        y: point.y + Math.sin(radians) * outline,
      })),
      INK,
    )
  }
  fillPolygon(canvas, path, WHITE)
  return canvas
}

/**
 * Caches sprites by kind and ripple phase. At 60 fps a 520 ms ripple has about
 * thirty distinct phases, so a whole render needs a few dozen rasterisations
 * rather than one per frame.
 */
export class SpriteCache {
  private readonly cache = new Map<string, Buffer>()

  constructor(private readonly look: Required<CursorLook>) {}

  png(kind: CursorKind, ripplePhase: number | null): Buffer {
    const key = `${kind}|${ripplePhase === null ? 'rest' : ripplePhase.toFixed(6)}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const png = drawCursorSprite(kind, ripplePhase, this.look).toPng()
    this.cache.set(key, png)
    return png
  }

  get geometry(): SpriteGeometry {
    return spriteGeometry(this.look)
  }
}
