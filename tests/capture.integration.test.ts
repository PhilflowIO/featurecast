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
import { startPresentedFrameTrace } from '../src/presented.js'
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
    // efficiency stays load-independent: if the host slows both the
    // compositor and this pipeline's capture proportionally, the ratio is
    // unaffected, so a regression here means a real loss, not a busy
    // machine.
    //
    // The denominator is Chromium's own presented-frame trace, the same one
    // the product path uses. It used to be the in-page change-tick probe,
    // passed into the presented-timestamps parameter while the surrounding
    // comment claimed otherwise — the exact silent-wrong-denominator
    // substitution that an optional parameter with a default invites, and
    // the reason that parameter is now required.
    const browser = await chromium.launch({
      args: [...HARDWARE_GL_LAUNCH_ARGS],
      headless: true,
    })
    try {
      const context = await browser.newContext({ viewport: CAPTURE_SIZE })
      const page = await context.newPage()
      await page.setContent(ANIMATED_FIXTURE)
      const presentedFrames = await startPresentedFrameTrace(browser, page)
      await startPaintRateProbe(page)

      const outputDirectory = join(await temporaryDirectory(), 'capture')
      const capture = await captureScreencast(
        page,
        outputDirectory,
        async () => {
          await page.waitForTimeout(8_000)
        },
      )
      const paintTimestamps = await readPaintTimestamps(page)
      const presentedTimestamps = await presentedFrames.stop()

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
        presentedTimestamps,
        paintTimestamps,
      )
      // The trace has to have reached this assertion, or "85% efficient" is
      // a statement about an empty denominator: `computeCaptureEfficiencyReport`
      // scores a window with zero presentations as 100%.
      expect(
        efficiencyReport.windows[0]?.presentedFrameCount ?? 0,
      ).toBeGreaterThan(30)
      // And the denominator must be instants, not Chromium's reports of
      // them: a report-counting denominator lands far above what the display
      // can produce. The rate is the one read off this machine's own
      // presentation instants, not a hard-wired 60 — the recording runs 8s
      // rather than 2s so there are enough gaps to read it to better than a
      // frame (`MIN_GAPS_FOR_REFRESH_ESTIMATE`).
      expect(efficiencyReport.refreshHz).toBeGreaterThan(24)
      expect(efficiencyReport.windows[0]?.presentedFps ?? 0).toBeLessThan(
        efficiencyReport.refreshHz + 4,
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
