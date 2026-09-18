import { describe, expect, it } from 'vitest'

import { resolveDevice } from '../src/devices.js'
import {
  FRAMED_SHELL_PATH,
  framedGeometry,
  framedShellHtml,
  framedShellUrl,
} from '../src/framed.js'

describe('framed geometry', () => {
  it('lays the application out at the device width, not the recorded one', () => {
    const iphone = resolveDevice('iphone')
    const geometry = framedGeometry(iphone.capture, iphone.device)
    // The whole point of the strategy: what the app lays out at is the
    // phone's own width, while the recording is 1620 wide — 1.5 times the
    // 1080 it is delivered at.
    expect(geometry.inner.width).toBe(393)
    expect(iphone.capture.width).toBe(1620)
    expect(geometry.scale).toBeCloseTo(1620 / 393, 10)
  })

  it('fills the recorded height rather than letterboxing the profile', () => {
    const iphone = resolveDevice('iphone')
    const geometry = framedGeometry(iphone.capture, iphone.device)
    // 2880 / 4.122 = 699, a little taller than the profile's own 659. Scaled
    // back up it has to land on the recorded height, or the video carries a
    // strip of shell background.
    expect(geometry.inner.height).toBeCloseTo(698.67, 1)
    // Exactly, not nearly: a rounded height would leave a row of shell
    // background along the bottom edge of every frame.
    expect(geometry.inner.height * geometry.scale).toBe(2880)
    expect(geometry.inner.height).not.toBe(iphone.device.viewport.height)
  })

  it('works the same way for a landscape profile and a tablet', () => {
    for (const name of ['iphone-quer', 'tablet']) {
      const device = resolveDevice(name)
      const geometry = framedGeometry(device.capture, device.device)
      expect(geometry.inner.width).toBe(device.device.viewport.width)
      expect(geometry.inner.width * geometry.scale).toBeCloseTo(
        device.capture.width,
        9,
      )
      expect(geometry.inner.height * geometry.scale).toBeCloseTo(
        device.capture.height,
        9,
      )
    }
  })
})

describe('the shell', () => {
  const appUrl = 'https://app.example.com/dashboard?tab=1'

  it('is served from the application own origin', () => {
    // This is the finding the whole module exists for: an opaque-origin shell
    // makes the application third-party, and a third-party document has no
    // storage. Same origin also satisfies X-Frame-Options: SAMEORIGIN.
    const shell = framedShellUrl(appUrl)
    expect(new URL(shell).origin).toBe(new URL(appUrl).origin)
    expect(new URL(shell).pathname).toBe(FRAMED_SHELL_PATH)
    expect(shell).not.toContain('dashboard')
  })

  it('points the frame at the full application address, query and all', () => {
    const html = framedShellHtml(appUrl, {
      inner: { height: 699, width: 393 },
      scale: 2.748,
    })
    expect(html).toContain(`src="${appUrl}"`)
  })

  it('sizes the frame in application pixels and scales it from the top left', () => {
    const html = framedShellHtml(appUrl, {
      inner: { height: 699, width: 393 },
      scale: 2.748,
    })
    expect(html).toContain('width: 393px')
    expect(html).toContain('height: 699px')
    expect(html).toContain('transform: scale(2.748)')
    // Any other origin would put the application's top-left corner somewhere
    // other than the video's, and the shift grows with the scale factor.
    expect(html).toContain('transform-origin: top left')
  })

  it('hides its own overflow, or the video carries a scrollbar', () => {
    // The scaled stage is larger than its layout box, so the shell would
    // otherwise scroll — and a scrollbar on the shell is recorded as a stripe
    // down the side of every frame.
    const html = framedShellHtml(appUrl, {
      inner: { height: 699, width: 393 },
      scale: 2.748,
    })
    expect(html).toMatch(/html, body \{[^}]*overflow: hidden/)
  })
})
