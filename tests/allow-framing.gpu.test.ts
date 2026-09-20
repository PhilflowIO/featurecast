import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resolveDevice } from '../src/devices.js'
import { recordSession } from '../src/session.js'

/**
 * `allowFramingOfApp` against an application that forbids every frame, the
 * way Raven does (issue 138): `X-Frame-Options: DENY` plus an *enforced*
 * `frame-ancestors 'none'` — stricter than Raven's report-only one, so a
 * relaxation that only handled one of the two would fail here.
 *
 * Beyond "the phone recording has frames", the page measures the scope of
 * the relaxation from the inside:
 *
 * - a frame the application opens itself, on the same origin and with the
 *   same headers, is still refused — only the shell's own frame is relaxed;
 * - a subresource fetched by the application still carries `DENY` — only the
 *   document is rewritten;
 * - another directive of the same CSP (`img-src 'none'`) is still enforced —
 *   only `frame-ancestors` changed.
 *
 * The entry is a redirect, because an application's front door usually is
 * one (Raven's `/meetings` answers 307 to `/login`); the document is gzipped
 * and sets a cookie, because a real one does both, and the relaxed delivery
 * must neither corrupt the first nor lose the second.
 */

const FORBIDDING = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'self' 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
}

const APP = `<!doctype html><html><head><meta charset="utf-8"><title>app</title></head>
<body data-app="yes">
<img id="pixel" src="/pixel.svg" onload="document.body.dataset.img='loaded'" onerror="document.body.dataset.img='refused'">
<iframe id="nested" src="/nested.html"></iframe>
</body></html>`

const NESTED = `<!doctype html><html><body data-nested="yes">nested</body></html>`

type Reading = {
  app: string
  cookie: boolean
  image: string
  nested: string
  path: string
  subresourceFrameOptions: string
}

/** A string payload for the reason `docs/RECORDING-SCRIPTS.md` gives. */
const PROBE = `
  (async function () {
    var nested = 'refused';
    try {
      var doc = document.getElementById('nested').contentDocument;
      if (doc && doc.body && doc.body.dataset.nested === 'yes') nested = 'loaded';
    } catch (e) {}
    var response = await fetch('/sub.txt');
    return {
      app: document.body.dataset.app || '',
      cookie: document.cookie.indexOf('seen=1') !== -1,
      image: document.body.dataset.img || 'pending',
      nested: nested,
      path: location.pathname,
      subresourceFrameOptions: response.headers.get('x-frame-options') || ''
    };
  })()
`

let server: Server
let origin: string
const directories: string[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/start') {
      response.writeHead(302, { ...FORBIDDING, location: '/app.html' })
      response.end()
      return
    }
    const bodies: Record<string, [string, string]> = {
      '/app.html': ['text/html; charset=utf-8', APP],
      '/nested.html': ['text/html; charset=utf-8', NESTED],
      '/pixel.svg': [
        'image/svg+xml',
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      ],
      '/sub.txt': ['text/plain; charset=utf-8', 'sub\n'],
    }
    const entry = path === undefined ? undefined : bodies[path]
    if (entry === undefined) {
      response.writeHead(404, FORBIDDING)
      response.end()
      return
    }
    if (path === '/app.html') {
      const packed = gzipSync(entry[1])
      response.writeHead(200, {
        ...FORBIDDING,
        'content-encoding': 'gzip',
        'content-length': String(packed.length),
        'content-type': entry[0],
        'set-cookie': 'seen=1; Path=/',
      })
      response.end(packed)
      return
    }
    response.writeHead(200, { ...FORBIDDING, 'content-type': entry[0] })
    response.end(entry[1])
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function filmOnPhone(
  allowFramingOfApp: boolean | undefined,
): Promise<{ frames: number; reading: Reading | undefined }> {
  const scratch = await mkdtemp(join(tmpdir(), 'featurecast-allow-framing-'))
  directories.push(scratch)
  const device = resolveDevice('iphone')
  let reading: Reading | undefined
  const session = await recordSession({
    appUrl: `${origin}/start`,
    capture: device.capture,
    device,
    outputDirectory: join(scratch, 'capture'),
    seed: 1,
    ...(allowFramingOfApp === undefined ? {} : { allowFramingOfApp }),
    recording: async (page) => {
      await page.waitForTimeout(300)
      reading = await page.evaluate(PROBE as unknown as () => Promise<Reading>)
      await page.waitForTimeout(300)
    },
  })
  const frames = (await readdir(join(session.captureDirectory, 'frames')))
    .length
  return { frames, reading }
}

describe('allowFramingOfApp', () => {
  it(
    'films a phone layout of an application that forbids framing, and relaxes nothing else',
    { timeout: 120_000 },
    async () => {
      const { frames, reading } = await filmOnPhone(true)
      expect(frames).toBeGreaterThan(0)
      expect(reading).toEqual({
        app: 'yes',
        cookie: true,
        image: 'refused',
        nested: 'refused',
        path: '/app.html',
        subresourceFrameOptions: 'DENY',
      })
    },
  )

  it(
    'leaves a recording without it as it was, and says why it cannot film',
    { timeout: 120_000 },
    async () => {
      await expect(filmOnPhone(undefined)).rejects.toThrow(
        /did not load inside the framed shell.*allowFramingOfApp = true/s,
      )
    },
  )
})
