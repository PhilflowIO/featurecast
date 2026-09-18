import { describe, expect, it } from 'vitest'

import { resolveDevice } from '../src/devices.js'
import {
  FRAMED_SHELL_PATH,
  framedGeometry,
  framedShellHtml,
  framedDocumentHeaders,
  framedShellUrl,
  type HeaderEntry,
  relaxFrameAncestors,
  relaxFramingHeaders,
} from '../src/framed.js'

describe('framed geometry', () => {
  it('lays the application out at the device width, not the recorded one', () => {
    const iphone = resolveDevice('iphone')
    const geometry = framedGeometry(iphone.capture, iphone.device)
    // The whole point of the strategy: what the app lays out at is the
    // phone's own width, while the recording is 1080 wide.
    expect(geometry.inner.width).toBe(393)
    expect(iphone.capture.width).toBe(1080)
    expect(geometry.scale).toBeCloseTo(1080 / 393, 10)
  })

  it('fills the recorded height rather than letterboxing the profile', () => {
    const iphone = resolveDevice('iphone')
    const geometry = framedGeometry(iphone.capture, iphone.device)
    // 1920 / 2.748 = 699, a little taller than the profile's own 659. Scaled
    // back up it has to land on the recorded height, or the video carries a
    // strip of shell background.
    expect(geometry.inner.height).toBeCloseTo(698.67, 1)
    // Exactly, not nearly: a rounded height would leave a row of shell
    // background along the bottom edge of every frame.
    expect(geometry.inner.height * geometry.scale).toBe(1920)
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

describe('relaxing the framing headers (allowFramingOfApp)', () => {
  // Raven's staging landing page, verbatim apart from the nonce (2026-09-18).
  const RAVEN_CSP =
    "default-src 'self'; script-src 'self' 'nonce-abc' 'wasm-unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; connect-src 'self' wss://live.staging.raven.ceo; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

  const valueOf = (headers: HeaderEntry[], name: string): string[] =>
    headers.filter((h) => h.name.toLowerCase() === name).map((h) => h.value)

  it('turns X-Frame-Options: DENY into SAMEORIGIN', () => {
    expect(
      relaxFramingHeaders([{ name: 'x-frame-options', value: 'DENY' }]),
    ).toEqual([{ name: 'x-frame-options', value: 'SAMEORIGIN' }])
  })

  it('leaves SAMEORIGIN as SAMEORIGIN and keeps the name as it came', () => {
    expect(
      relaxFramingHeaders([{ name: 'X-Frame-Options', value: 'sameorigin' }]),
    ).toEqual([{ name: 'X-Frame-Options', value: 'SAMEORIGIN' }])
  })

  it("rewrites frame-ancestors to 'self' and keeps every other directive byte for byte", () => {
    expect(relaxFrameAncestors(RAVEN_CSP)).toBe(
      RAVEN_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
    )
  })

  it('replaces a frame-ancestors with several sources, in any case, anywhere in the policy', () => {
    expect(
      relaxFrameAncestors(
        "FRAME-ANCESTORS https://a.example https://b.example;default-src 'self'",
      ),
    ).toBe("frame-ancestors 'self';default-src 'self'")
    expect(relaxFrameAncestors("default-src 'self'; frame-ancestors")).toBe(
      "default-src 'self'; frame-ancestors 'self'",
    )
  })

  it('returns a policy without frame-ancestors unchanged', () => {
    const policy = "default-src 'self'; img-src 'self' data:; "
    expect(relaxFrameAncestors(policy)).toBe(policy)
  })

  it('does not mistake a longer directive name for frame-ancestors', () => {
    const policy = "frame-src 'none'; frame-ancestors-like 'none'"
    expect(relaxFrameAncestors(policy)).toBe(policy)
  })

  it('rewrites each policy of a folded, comma-separated header', () => {
    expect(
      relaxFrameAncestors(
        "default-src 'self'; frame-ancestors 'none', frame-ancestors 'none'; img-src data:",
      ),
    ).toBe(
      "default-src 'self'; frame-ancestors 'self', frame-ancestors 'self'; img-src data:",
    )
  })

  it('treats the enforced, a repeated and the report-only CSP alike and touches no other header', () => {
    const headers: HeaderEntry[] = [
      { name: 'cache-control', value: 'no-store' },
      {
        name: 'Content-Security-Policy',
        value: "frame-ancestors 'none'; object-src 'none'",
      },
      { name: 'content-security-policy', value: "img-src 'none'" },
      { name: 'content-security-policy-report-only', value: RAVEN_CSP },
      { name: 'content-type', value: 'text/html; charset=utf-8' },
      { name: 'set-cookie', value: 'a=1; Secure; HttpOnly' },
      { name: 'set-cookie', value: 'b=2; SameSite=Strict' },
      { name: 'strict-transport-security', value: 'max-age=63072000' },
      { name: 'x-frame-options', value: 'DENY' },
    ]
    const relaxed = relaxFramingHeaders(headers)
    expect(relaxed).toHaveLength(headers.length)
    expect(valueOf(relaxed, 'content-security-policy')).toEqual([
      "frame-ancestors 'self'; object-src 'none'",
      "img-src 'none'",
    ])
    expect(valueOf(relaxed, 'content-security-policy-report-only')).toEqual([
      RAVEN_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
    ])
    expect(valueOf(relaxed, 'x-frame-options')).toEqual(['SAMEORIGIN'])
    for (const name of [
      'cache-control',
      'content-type',
      'set-cookie',
      'strict-transport-security',
    ]) {
      expect(valueOf(relaxed, name)).toEqual(valueOf(headers, name))
    }
  })

  it('adds nothing to a response that sends no framing headers', () => {
    const headers = [{ name: 'content-type', value: 'text/css' }]
    expect(relaxFramingHeaders(headers)).toEqual(headers)
  })

  it('drops only the transfer headers when the document is delivered decoded', () => {
    // The body comes back from the protocol already unpacked; a gzip label
    // on it would be a lie, and so would the compressed length.
    const delivered = framedDocumentHeaders([
      { name: 'Content-Encoding', value: 'br' },
      { name: 'content-length', value: '1234' },
      { name: 'transfer-encoding', value: 'chunked' },
      { name: 'content-type', value: 'text/html' },
      { name: 'x-frame-options', value: 'DENY' },
      { name: 'vary', value: 'Accept-Encoding' },
    ])
    expect(delivered).toEqual([
      { name: 'content-type', value: 'text/html' },
      { name: 'x-frame-options', value: 'SAMEORIGIN' },
      { name: 'vary', value: 'Accept-Encoding' },
    ])
  })
})
