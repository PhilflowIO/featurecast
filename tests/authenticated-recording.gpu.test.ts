import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveDevice } from '../src/devices.js'
import {
  startFixtureServer,
  type FixtureServer,
} from '../src/fixture-server.js'
import { recordSession } from '../src/session.js'

/**
 * What the script contract has to deliver for a signed-in application to be
 * filmable by `featurecast run` at all.
 *
 * Measured through `recordSession`, not through the three helpers it calls.
 * The helpers were provably correct before this change and the recording
 * still had no session, no hidden card and a moving clock — because nothing
 * connected them to the chain that owns the camera. A test of the helpers
 * would have stayed green through exactly the defect this closes, so it is
 * the whole browser leg that is measured here: one real capture, and the
 * three facts read off the page the screencast was pointed at.
 *
 * The page is served over loopback rather than from a `data:` URL because
 * both halves of a saved session — cookies and `localStorage` — belong to an
 * origin, and a `data:` URL has none. It reports what it sees by *existing*:
 * three nodes that are only in the document when the fact they stand for is
 * true. The recording then asks for their geometry, which is the one
 * question `RecordPage` answers about a node, and a node without a box is a
 * node nobody could have filmed.
 */

const SESSION_COOKIE = 'featurecast-session'
const SESSION_VALUE = 'angemeldet'
const FIXED_TIME = '2026-01-15T09:00:00Z'

const PAGE_HTML = `<!doctype html><html><body style="margin:0;background:#fff">
<div id="internal-card" style="height:120px;background:#444">internal.example.invalid</div>
<h1 id="headline" style="height:60px;font:24px sans-serif">Liste</h1>
<div id="mount"></div>
<script>
(function () {
  var mount = document.getElementById('mount');
  var show = function (id) {
    var node = document.createElement('div');
    node.id = id;
    node.style.height = '40px';
    node.style.background = '#0a0';
    mount.appendChild(node);
  };
  var hasCookie = document.cookie.indexOf('${SESSION_COOKIE}=${SESSION_VALUE}') !== -1;
  var hasStorage = window.localStorage.getItem('featurecast-demo') === '${SESSION_VALUE}';
  if (hasCookie && hasStorage) show('signed-in');
  if (new Date().toISOString().indexOf('2026-01-15T09:00') === 0) show('clock-frozen');
})();
</script>
</body></html>
`

const directories: string[] = []
const servers: FixtureServer[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-authed-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

/**
 * A `storageState` file of the shape a real sign-in leaves behind: the
 * session cookie plus the local storage the interface writes next to it.
 * Written into a scratch directory — `auth/` is for the real one, and this
 * suite must not touch it.
 */
async function writeStorageState(
  directory: string,
  origin: string,
): Promise<string> {
  const path = join(directory, 'state.json')
  await writeFile(
    path,
    JSON.stringify({
      cookies: [
        {
          domain: '127.0.0.1',
          expires: -1,
          httpOnly: false,
          name: SESSION_COOKIE,
          path: '/',
          sameSite: 'Lax',
          secure: false,
          value: SESSION_VALUE,
        },
      ],
      origins: [
        {
          localStorage: [{ name: 'featurecast-demo', value: SESSION_VALUE }],
          origin,
        },
      ],
    }),
  )
  return path
}

type Seen = Record<string, boolean>

/**
 * Asks the page which of the four nodes are on screen, in one go.
 *
 * A string payload rather than a function, for the reason
 * `docs/RECORDING-SCRIPTS.md` gives under "The trap that
 * catches every injected script": a string is never compiled, so no esbuild
 * name wrapper can travel into the page with it. It also answers without
 * waiting — `locator.boundingBox()` blocks for its own timeout on a node
 * that is not there, which would turn a clear "the session never arrived"
 * into a 30-second stall that reads like a slow page.
 */
const PROBE = `
  (function () {
    var shown = function (id) {
      var node = document.getElementById(id);
      return node !== null && node.getClientRects().length > 0;
    };
    return {
      'signed-in': shown('signed-in'),
      'clock-frozen': shown('clock-frozen'),
      'internal-card': shown('internal-card'),
      headline: shown('headline')
    };
  })()
`

describe('a recording of a signed-in application', () => {
  it(
    'restores the session, hides the named surface and freezes the clock',
    { timeout: 180_000 },
    async () => {
      const scratch = await temporaryDirectory()
      const corpus = await temporaryDirectory()
      await writeFile(join(corpus, 'index.html'), PAGE_HTML)
      const server = await startFixtureServer({ directory: corpus })
      servers.push(server)
      const storageStatePath = await writeStorageState(scratch, server.origin)

      let seen: Seen = {}
      const device = resolveDevice('desktop-wide')
      // `captureScreencast` creates the output directory itself, so it gets a
      // name inside the scratch directory rather than the scratch directory.
      await recordSession({
        capture: device.capture,
        device,
        fixedTime: FIXED_TIME,
        hideSelectors: ['#internal-card'],
        outputDirectory: join(scratch, 'capture'),
        seed: 1,
        storageStatePath,
        recording: async (page) => {
          await page.goto(server.origin)
          // `evaluate` types its argument as a function; Playwright accepts
          // the source text of an expression just as well, and that is the
          // form that cannot be compiled on the way in.
          seen = await page.evaluate(PROBE as unknown as () => Seen)
        },
      })

      // The session reached the browser: the page only mounts this node when
      // it finds both the cookie and the local storage of a signed-in
      // account. Without the saved state the application under a real
      // recording shows its login screen instead, which is the failure this
      // guards.
      expect(seen['signed-in']).toBe(true)
      // The card with the internal address was gone before the page's own
      // script ran — not removed later, by which time the screencast would
      // have frames of it.
      expect(seen['internal-card']).toBe(false)
      // And the page around it survived. A rule broad enough to take the
      // headline with it would satisfy the line above.
      expect(seen['headline']).toBe(true)
      // The clock the page reads is the one the script named, so "3 days ago"
      // says the same thing in a run a month from now.
      expect(seen['clock-frozen']).toBe(true)
    },
  )
})
