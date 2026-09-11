import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CAPTURE_SIZE,
  captureScreencast,
  type TimestampManifest,
} from '../src/capture.js'
import { computeCaptureEfficiencyReport } from '../src/efficiency.js'
import { readPaintTimestamps, startPaintRateProbe } from '../src/paint-rate.js'
import { HARDWARE_GL_LAUNCH_ARGS } from '../src/renderer.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-integration-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

const ANIMATED_FIXTURE = `
  <style>
    @keyframes slide {
      from { transform: translateX(0); }
      to { transform: translateX(2400px); }
    }
    html, body { margin: 0; }
    div {
      width: 240px;
      height: 240px;
      background: crimson;
      animation: slide 1.2s linear infinite;
    }
  </style>
  <div></div>
`

/**
 * Runs against real headless Chromium instead of a mocked `page.screencast`,
 * because the backpressure bug (finding 2) only manifests through
 * Playwright's actual CDP ack loop: a mock can't reproduce
 * `Screencast.onScreencastFrame` racing our `onFrame` return value.
 */
describe('captureScreencast against real Chromium', () => {
  it('captures essentially everything a continuously animating page paints, strictly in order', async () => {
    // Deliberately does not assert an absolute fps: this fixture's actual
    // paint rate depends on host CPU/GPU contention (e.g. other Chromium
    // instances running concurrently elsewhere in the same test suite),
    // which measured 33.8-38.3fps under full-suite load versus 60fps in
    // isolation on this box — an absolute "fps >= 50" threshold is a flaky
    // assertion about machine load, not about this pipeline. Capture
    // efficiency (captured / painted, both counted on the same in-page
    // clock via `paint-rate.ts`) stays load-independent: if the host slows
    // both the page's paint and this pipeline's capture proportionally, the
    // ratio is unaffected, so a regression here means a real loss, not a
    // busy machine.
    const browser = await chromium.launch({
      args: [...HARDWARE_GL_LAUNCH_ARGS],
      headless: true,
    })
    try {
      const context = await browser.newContext({ viewport: CAPTURE_SIZE })
      const page = await context.newPage()
      await page.setContent(ANIMATED_FIXTURE)
      await startPaintRateProbe(page)

      const outputDirectory = join(await temporaryDirectory(), 'capture')
      const capture = await captureScreencast(
        page,
        outputDirectory,
        async () => {
          await page.waitForTimeout(2_000)
        },
      )
      const paintTimestamps = await readPaintTimestamps(page)

      const manifest = JSON.parse(
        await readFile(capture.timestampsPath, 'utf8'),
      ) as TimestampManifest

      expect(manifest.frames.length).toBeGreaterThan(10)

      for (let index = 1; index < manifest.frames.length; index += 1) {
        const current = manifest.frames[index]
        const previous = manifest.frames[index - 1]
        if (current === undefined || previous === undefined) {
          throw new Error(
            'unreachable: manifest frame array index out of bounds',
          )
        }
        expect(current.timestamp).toBeGreaterThanOrEqual(previous.timestamp)
      }

      const efficiencyReport = computeCaptureEfficiencyReport(
        manifest,
        [
          {
            end: manifest.session.endedAt,
            label: 'whole-capture',
            start: manifest.session.startedAt,
          },
        ],
        paintTimestamps,
      )
      // 85%, not the production 95% floor (`src/efficiency.ts`): this
      // fixture's window includes screencast start/stop settling time the
      // production pipeline's motion windows are drawn around, which adds
      // a small amount of unavoidable boundary noise here specifically.
      expect(efficiencyReport.overallEfficiency).toBeGreaterThanOrEqual(0.85)

      await context.close()
    } finally {
      await browser.close()
    }
  }, 20_000)

  it('surfaces a writer failure to the caller instead of swallowing it', async () => {
    const browser = await chromium.launch({
      args: [...HARDWARE_GL_LAUNCH_ARGS],
      headless: true,
    })
    try {
      const context = await browser.newContext({ viewport: CAPTURE_SIZE })
      const page = await context.newPage()
      await page.setContent(ANIMATED_FIXTURE)

      const outputDirectory = join(await temporaryDirectory(), 'capture')
      const writeError = new Error('simulated disk failure')

      await expect(
        captureScreencast(
          page,
          outputDirectory,
          async () => {
            await page.waitForTimeout(1_000)
          },
          { writeFrame: async () => Promise.reject(writeError) },
        ),
      ).rejects.toBe(writeError)

      await context.close()
    } finally {
      await browser.close()
    }
  }, 20_000)
})
