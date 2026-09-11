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
  it('captures a continuously animating page at a high, strictly increasing source rate', async () => {
    const browser = await chromium.launch({
      args: [...HARDWARE_GL_LAUNCH_ARGS],
      headless: true,
    })
    try {
      const context = await browser.newContext({ viewport: CAPTURE_SIZE })
      const page = await context.newPage()
      await page.setContent(ANIMATED_FIXTURE)

      const outputDirectory = join(await temporaryDirectory(), 'capture')
      const capture = await captureScreencast(
        page,
        outputDirectory,
        async () => {
          await page.waitForTimeout(2_000)
        },
      )

      const manifest = JSON.parse(
        await readFile(capture.timestampsPath, 'utf8'),
      ) as TimestampManifest

      expect(manifest.frames.length).toBeGreaterThan(10)

      const intervals: number[] = []
      for (let index = 1; index < manifest.frames.length; index += 1) {
        const current = manifest.frames[index]
        const previous = manifest.frames[index - 1]
        if (current === undefined || previous === undefined) {
          throw new Error(
            'unreachable: manifest frame array index out of bounds',
          )
        }
        expect(current.timestamp).toBeGreaterThanOrEqual(previous.timestamp)
        intervals.push(current.timestamp - previous.timestamp)
      }

      const sorted = [...intervals].sort((a, b) => a - b)
      const medianIndex = Math.floor(sorted.length / 2)
      const median = sorted[medianIndex]
      if (median === undefined) {
        throw new Error('unreachable: no inter-frame intervals recorded')
      }
      const medianFps = 1_000 / median
      expect(medianFps).toBeGreaterThanOrEqual(50)

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
