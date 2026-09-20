import { describe, expect, it } from 'vitest'

import type { VideoInfo } from '../../src/probe.js'
import {
  buildMontageFilter,
  buildMontagePlan,
  checkPieceCount,
  montageLayout,
  type MontagePiece,
} from '../../src/render/montage.js'

function probe(width: number, height: number, seconds: number): VideoInfo {
  return { durationSeconds: seconds, height, path: 'x.mp4', width }
}

const THREE: readonly MontagePiece[] = [
  { kind: 'monitor', path: 'desktop.mp4' },
  { kind: 'tablet', path: 'tablet.mp4' },
  { kind: 'phone', path: 'phone.mp4' },
]

const PROBES = [
  probe(1920, 1200, 8.4),
  probe(1600, 1200, 8.0),
  probe(900, 1600, 7.2),
]

describe('montage layout', () => {
  it('holds two to four devices', () => {
    expect(() => {
      checkPieceCount(1)
    }).toThrow(/2 to 4/)
    expect(() => {
      checkPieceCount(5)
    }).toThrow(/2 to 4/)
    expect(() => {
      checkPieceCount(3)
    }).not.toThrow()
  })

  it('stands every device on one line', () => {
    const layout = montageLayout(THREE, PROBES)
    const floors = layout.pieces.map((piece) => piece.y + piece.shell.height)
    expect(new Set(floors).size).toBe(1)
  })

  it('sizes a phone against a monitor, not equal to it', () => {
    const layout = montageLayout(THREE, PROBES)
    const monitor = layout.pieces[0]?.shell.height ?? 0
    const phone = layout.pieces[2]?.shell.height ?? 0
    expect(phone / monitor).toBeCloseTo(0.46, 1)
  })

  it('overlaps, so the picture is narrower than the devices laid end to end', () => {
    const apart = montageLayout(THREE, PROBES, { overlap: 0 })
    const together = montageLayout(THREE, PROBES, { overlap: 0.2 })
    expect(together.width).toBeLessThan(apart.width)
  })

  it('trims to the shortest recording and says so', () => {
    expect(montageLayout(THREE, PROBES).seconds).toBeCloseTo(7.2, 5)
  })

  it('refuses an overlap that would stack devices', () => {
    expect(() => montageLayout(THREE, PROBES, { overlap: 0.6 })).toThrow(
      /below 0.5/,
    )
  })

  it('refuses a probe list that does not match the devices', () => {
    expect(() => montageLayout(THREE, PROBES.slice(0, 2))).toThrow(
      /2 probes for 3 devices/,
    )
  })
})

describe('montage filter', () => {
  it('scales each recording to its own shell screen, never to a common size', () => {
    const layout = montageLayout(THREE, PROBES)
    const filter = buildMontageFilter(layout)
    for (const [index, piece] of layout.pieces.entries()) {
      expect(filter).toContain(
        `[${String(index)}:v]trim=duration=${layout.seconds.toFixed(3)}`,
      )
      expect(filter).toContain(
        `scale=${String(piece.shell.screen.width)}:${String(piece.shell.screen.height)}`,
      )
    }
    const sizes = layout.pieces.map(
      (piece) =>
        `${String(piece.shell.screen.width)}x${String(piece.shell.screen.height)}`,
    )
    expect(new Set(sizes).size).toBe(sizes.length)
  })

  it('puts the recording under its shell, at the shell screen', () => {
    const layout = montageLayout(THREE, PROBES)
    const filter = buildMontageFilter(layout)
    const first = layout.pieces[0]
    if (first === undefined) throw new Error('no first piece')
    expect(filter).toContain(
      `[v0]overlay=${String(first.x + first.shell.screen.x)}:${String(first.y + first.shell.screen.y)}`,
    )
    expect(filter).toContain(
      `[3:v]overlay=${String(first.x)}:${String(first.y)}`,
    )
  })
})

describe('montage plan', () => {
  it('feeds ffmpeg the recordings first and the shells after', () => {
    const layout = montageLayout(THREE, PROBES)
    const plan = buildMontagePlan(
      layout,
      ['a.png', 'b.png', 'c.png'],
      'out.mp4',
    )
    const inputs = plan.arguments.filter(
      (_, index, all) => all[index - 1] === '-i',
    )
    expect(inputs).toEqual([
      'desktop.mp4',
      'tablet.mp4',
      'phone.mp4',
      'a.png',
      'b.png',
      'c.png',
    ])
  })

  it('keeps alpha when the background is transparent', () => {
    const layout = montageLayout(THREE, PROBES)
    const opaque = buildMontagePlan(
      layout,
      ['a.png', 'b.png', 'c.png'],
      'o.mp4',
    )
    const clear = buildMontagePlan(
      layout,
      ['a.png', 'b.png', 'c.png'],
      'o.mov',
      {
        background: 'transparent',
      },
    )
    expect(opaque.arguments).toContain('yuv420p')
    expect(clear.arguments).toContain('argb')
    expect(clear.arguments).not.toContain('yuv420p')
  })

  it('refuses a shell list that does not match the devices', () => {
    const layout = montageLayout(THREE, PROBES)
    expect(() => buildMontagePlan(layout, ['a.png'], 'out.mp4')).toThrow(
      /1 shells for 3 devices/,
    )
  })
})

describe('montage margin', () => {
  it('leaves room around the picture so no shadow is cut off', () => {
    const layout = montageLayout(THREE, PROBES, { height: 1000, margin: 0.05 })
    const first = layout.pieces[0]
    const last = layout.pieces.at(-1)
    if (first === undefined || last === undefined) throw new Error('no pieces')
    expect(first.x).toBe(50)
    expect(layout.width - (last.x + last.shell.width)).toBe(50)
    expect(layout.height - (last.y + last.shell.height)).toBe(50)
  })

  it('refuses a margin that would eat the picture', () => {
    expect(() => montageLayout(THREE, PROBES, { margin: 0.4 })).toThrow(
      /below 0.25/,
    )
  })
})
