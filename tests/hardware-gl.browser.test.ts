import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  BROWSER_PROVENANCE_FILE_NAME,
  type BrowserProvenance,
} from '../src/browser.js'
import { resolveDevice } from '../src/devices.js'
import {
  type FixtureServer,
  startFixtureServer,
} from '../src/fixture-server.js'
import { readRecordedPointerStyle } from '../src/recorded-device.js'
import { HARDWARE_GL_LAUNCH_ARGS } from '../src/renderer.js'
import { recordSession } from '../src/session.js'

/**
 * A recording paints on the GPU, and says so in `browser.json`.
 *
 * Before featurecast#150 the recording session launched Chromium without any
 * GL flags, so headless Chromium rasterized in SwiftShader on a machine with
 * a working GPU. Raven's landing page then scrolled at ~20 fps and at under
 * half its scripted pace, and no check noticed. Like every `*.browser.test`,
 * this one needs a machine with a GPU. Unlike the others it cannot borrow
 * FEATURECAST_ALLOW_SOFTWARE_RENDERER=1 to run anyway: the renderer is its
 * subject, so under that switch it would either fail or — worse — have to
 * drop the assertion and report green without having proven anything. It
 * skips itself there instead, and the guarantee is proven on the GPU host.
 */

const SOFTWARE_RENDERER_ALLOWED =
  process.env['FEATURECAST_ALLOW_SOFTWARE_RENDERER'] === '1'

const directories: string[] = []
let server: FixtureServer

beforeAll(async () => {
  server = await startFixtureServer()
})

afterAll(async () => {
  await server.close()
})

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('recording renderer', () => {
  it.skipIf(SOFTWARE_RENDERER_ALLOWED)(
    'launches with hardware GL and records the renderer it painted with',
    { timeout: 120_000 },
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'featurecast-hardware-gl-'))
      directories.push(scratch)
      const device = resolveDevice('desktop-wide')
      const outputDirectory = join(scratch, 'capture')
      await recordSession({
        capture: device.capture,
        device,
        outputDirectory,
        seed: 1,
        recording: async (page) => {
          await page.goto(`${server.origin}/`)
        },
      })
      const provenance = JSON.parse(
        await readFile(
          join(outputDirectory, BROWSER_PROVENANCE_FILE_NAME),
          'utf8',
        ),
      ) as BrowserProvenance
      expect(provenance.renderer?.launchArgs).toEqual(
        expect.arrayContaining([...HARDWARE_GL_LAUNCH_ARGS]),
      )
      expect(provenance.renderer?.renderer).not.toMatch(/swiftshader/i)
      expect(provenance.renderer?.softwareRendering).toBe(false)
      // The one real recording in this file, so the one place that proves
      // the recorder — and not only a test calling the writer — leaves the
      // device's pointer beside the frames for the render (featurecast#155).
      expect(await readRecordedPointerStyle(outputDirectory)).toBe('arrow')
    },
  )
})
