import { describe, expect, it, vi } from 'vitest'

import { recordPageFor } from '../src/surface.js'

type Call = [string, ...unknown[]]

/** Two spies shaped like the two objects the facade composes. */
function doubles(): {
  calls: Call[]
  cdp: Parameters<typeof recordPageFor>[2]['cdp']
  frame: Parameters<typeof recordPageFor>[0]
  page: Parameters<typeof recordPageFor>[1]
} {
  const calls: Call[] = []
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
    }
  const frame = {
    evaluate: vi.fn(async () => 'from-the-app'),
    goto: record('frame.goto'),
    locator: vi.fn((selector: string) => ({
      boundingBox: async () => ({ height: 10, width: 20, x: 1, y: 2 }),
      evaluate: async () => `evaluated:${selector}`,
    })),
  }
  const page = {
    keyboard: { type: record('page.keyboard.type') },
    mouse: {
      click: record('page.mouse.click'),
      move: record('page.mouse.move'),
      wheel: record('page.mouse.wheel'),
    },
    touchscreen: { tap: record('page.touchscreen.tap') },
    viewportSize: () => ({ height: 1920, width: 1080 }),
    waitForTimeout: record('page.waitForTimeout'),
  }
  const cdp = {
    send: vi.fn(async (method: string, params: unknown) => {
      calls.push(['cdp.send', method, params])
    }),
  }
  return {
    calls,
    cdp: cdp as unknown as Parameters<typeof recordPageFor>[2]['cdp'],
    frame: frame as unknown as Parameters<typeof recordPageFor>[0],
    page: page as unknown as Parameters<typeof recordPageFor>[1],
  }
}

describe('the recording surface', () => {
  it('divides wheel deltas by the scale, so a scroll means picture pixels', async () => {
    const { calls, cdp, frame, page } = doubles()
    const surface = recordPageFor(frame, page, {
      cdp,
      hasTouch: true,
      scale: 2.75,
    })
    await surface.mouse.wheel(0, 550)
    expect(calls).toEqual([['page.mouse.wheel', 0, 200]])
  })

  it('leaves wheel deltas alone for a direct capture', async () => {
    const { calls, cdp, frame, page } = doubles()
    const surface = recordPageFor(frame, page, {
      cdp,
      hasTouch: false,
      scale: 1,
    })
    await surface.mouse.wheel(0, 550)
    expect(calls).toEqual([['page.mouse.wheel', 0, 550]])
  })

  it('does not scale pointer coordinates, which are already picture pixels', async () => {
    // Playwright reports element boxes in main-frame coordinates and takes
    // input there. Scaling these too would double-apply the transform.
    const { calls, cdp, frame, page } = doubles()
    const surface = recordPageFor(frame, page, {
      cdp,
      hasTouch: true,
      scale: 2.75,
    })
    await surface.mouse.move(540, 960, { steps: 4 })
    await surface.mouse.click(540, 960)
    await surface.touchscreen.tap(540, 960)
    expect(calls).toEqual([
      ['page.mouse.move', 540, 960, { steps: 4 }],
      ['page.mouse.click', 540, 960],
      ['page.touchscreen.tap', 540, 960],
    ])
  })

  it('queries and navigates the application, not the page around it', async () => {
    const { calls, cdp, frame, page } = doubles()
    const surface = recordPageFor(frame, page, {
      cdp,
      hasTouch: true,
      scale: 2.75,
    })
    await surface.goto('https://app.example.com/x')
    expect(await surface.evaluate(() => 'ignored')).toBe('from-the-app')
    expect(await surface.locator('#thing').evaluate(() => undefined, 0)).toBe(
      'evaluated:#thing',
    )
    expect(calls).toEqual([['frame.goto', 'https://app.example.com/x']])
  })

  it('spells a swipe out as press, path and lift over the protocol', async () => {
    // Playwright's Touchscreen can only tap. A lift carries no coordinate by
    // protocol, which is the one shape of these three calls that is not
    // obvious from the names.
    const { calls, cdp, frame, page } = doubles()
    const surface = recordPageFor(frame, page, {
      cdp,
      hasTouch: true,
      scale: 2.75,
    })
    await surface.touchscreen.down(540, 1300)
    await surface.touchscreen.move(540, 1000)
    await surface.touchscreen.up(540, 1000)
    expect(calls).toEqual([
      [
        'cdp.send',
        'Input.dispatchTouchEvent',
        { touchPoints: [{ x: 540, y: 1300 }], type: 'touchStart' },
      ],
      [
        'cdp.send',
        'Input.dispatchTouchEvent',
        { touchPoints: [{ x: 540, y: 1000 }], type: 'touchMove' },
      ],
      [
        'cdp.send',
        'Input.dispatchTouchEvent',
        { touchPoints: [], type: 'touchEnd' },
      ],
    ])
  })

  it('does not scale gesture coordinates either — they are picture pixels', async () => {
    const { calls, cdp, frame, page } = doubles()
    const surface = recordPageFor(frame, page, {
      cdp,
      hasTouch: true,
      scale: 2.75,
    })
    await surface.touchscreen.move(540, 1000)
    expect(calls[0]?.[2]).toEqual({
      touchPoints: [{ x: 540, y: 1000 }],
      type: 'touchMove',
    })
  })

  it('reports the recorded area as the viewport, not the application width', async () => {
    const { cdp, frame, page } = doubles()
    const surface = recordPageFor(frame, page, {
      cdp,
      hasTouch: true,
      scale: 2.75,
    })
    expect(surface.viewportSize()).toEqual({ height: 1920, width: 1080 })
  })
})
