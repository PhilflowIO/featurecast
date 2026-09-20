import { describe, expect, it } from 'vitest'

import {
  SHELL_KINDS,
  drawShell,
  isShellKind,
  shellGeometry,
} from '../../src/render/shell.js'

/**
 * A shell is only useful if it holds the recording it was built for. The
 * failure this guards is the one every mockup template has: a fixed frame
 * that a 9:16 phone take has to be letterboxed into, which throws away the
 * reason the phone was filmed separately.
 */

function alphaAt(
  canvas: ReturnType<typeof drawShell>,
  x: number,
  y: number,
): number {
  return canvas.pixels[(y * canvas.width + x) * 4 + 3] ?? 0
}

describe('device shells', () => {
  it.each(SHELL_KINDS)('gives a %s the screen it was asked for', (kind) => {
    const shell = shellGeometry(kind, 1280, 800)
    expect(shell.screen.width).toBe(1280)
    expect(shell.screen.height).toBe(800)
  })

  it.each(SHELL_KINDS)('keeps the %s screen inside the body', (kind) => {
    const shell = shellGeometry(kind, 900, 1600)
    expect(shell.screen.x).toBeGreaterThan(0)
    expect(shell.screen.y).toBeGreaterThan(0)
    expect(shell.screen.x + shell.screen.width).toBeLessThan(shell.width)
    expect(shell.screen.y + shell.screen.height).toBeLessThan(shell.height)
  })

  it('follows the recording instead of a fixed frame', () => {
    const wide = shellGeometry('tablet', 1600, 1000)
    const tall = shellGeometry('tablet', 1000, 1600)
    expect(wide.screen.width / wide.screen.height).toBeCloseTo(1.6, 5)
    expect(tall.screen.width / tall.screen.height).toBeCloseTo(0.625, 5)
    expect(wide.width).toBeGreaterThan(tall.width)
  })

  it('refuses a screen with no size', () => {
    expect(() => shellGeometry('phone', 0, 100)).toThrow(/positive screen size/)
    expect(() => shellGeometry('phone', 100, -1)).toThrow(
      /positive screen size/,
    )
  })

  it('names the kinds it can draw, and only those', () => {
    expect(isShellKind('phone')).toBe(true)
    expect(isShellKind('watch')).toBe(false)
  })

  it('leaves the screen area transparent and the body opaque', () => {
    const shell = shellGeometry('monitor', 320, 200)
    const canvas = drawShell(shell)
    const middleX = shell.screen.x + Math.floor(shell.screen.width / 2)
    const middleY = shell.screen.y + Math.floor(shell.screen.height / 2)
    expect(alphaAt(canvas, middleX, middleY)).toBe(0)
    // Two pixels outside the screen edge is bezel, whatever the corner radius.
    expect(alphaAt(canvas, middleX, shell.screen.y - 2)).toBeGreaterThan(200)
  })

  it('draws the same bytes twice', () => {
    const shell = shellGeometry('phone', 180, 320)
    expect(drawShell(shell).toPng().equals(drawShell(shell).toPng())).toBe(true)
  })
})
