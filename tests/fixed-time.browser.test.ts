import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveDevice } from '../src/devices.js'
import { recordSession } from '../src/session.js'

/**
 * What `fixedTime` may change in a page, and what it must leave alone.
 *
 * It exists for one thing: relative timestamps ("3 days ago") have to read the
 * same in every run. That is a question of `Date`. The frame loop, the timers
 * and `performance` are not part of it, and the first implementation proved
 * what happens when they are touched anyway (featurecast#144).
 *
 * It used Playwright's `clock.setFixedTime`. Despite its description ("keeps
 * all the timers running") that call installs Playwright's whole fake clock
 * first (`_installIfNeeded` in playwright-core's server clock): `performance`,
 * `requestAnimationFrame` and the timers are replaced as well. The fake
 * `performance.now()` then no longer agrees with the document timeline the
 * browser runs Web Animations on. Framer Motion starts its hardware-accelerated
 * animations with a `startTime` read from `performance.now()`, so every such
 * animation began seconds in the future. Measured under a real recording of
 * Raven: `currentTime` of -3.7 s on the rows' entrance animations, whose first
 * keyframe is `opacity: 0`. The DOM held sixteen rows and the screencast
 * filmed an empty card, then a meeting page without content. The same
 * recording without `fixedTime` filmed both, and delivered 179 frames instead
 * of 87 for the same script.
 *
 * So this is measured the way the defect showed: an animation started the way
 * Framer Motion starts one, read back after its own duration.
 */

const FIXED_TIME = '2026-01-15T09:00:00Z'

/** An opacity fade of 200 ms, started with `startTime = performance.now()`. */
const PAGE_HTML =
  '<!doctype html><html><body style="margin:0;background:#fff">' +
  '<div id="row" style="width:200px;height:40px;background:#0a0"></div>' +
  '</body></html>'
const PAGE_URL = `data:text/html,${encodeURIComponent(PAGE_HTML)}`

type Reading = {
  dateIso: string
  dateAdvancedMs: number
  opacityAfter: string
  performanceWallMs: number
  timelineMinusPerformanceMs: number
}

/**
 * A string payload for the reason `docs/RECORDING-SCRIPTS.md` gives under
 * "The trap that catches every injected script".
 */
const PROBE = `
  new Promise(function (resolve) {
    var row = document.getElementById('row');
    var fade = row.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 200,
      fill: 'both'
    });
    fade.startTime = performance.now();
    var dateBefore = Date.now();
    var timelineMinusPerformanceMs =
      document.timeline.currentTime - performance.now();
    setTimeout(function () {
      requestAnimationFrame(function () {
        resolve({
          dateIso: new Date().toISOString(),
          dateAdvancedMs: Date.now() - dateBefore,
          opacityAfter: getComputedStyle(row).opacity,
          performanceWallMs: performance.timeOrigin + performance.now(),
          timelineMinusPerformanceMs: timelineMinusPerformanceMs
        });
      });
    }, 600);
  })
`

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('fixedTime', () => {
  it(
    'pins the date a page reads and leaves its frame loop, timers and animations real',
    { timeout: 120_000 },
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'featurecast-fixed-time-'))
      directories.push(scratch)
      const device = resolveDevice('desktop-wide')
      let reading: Reading | undefined
      let realNowMs = 0

      await recordSession({
        capture: device.capture,
        device,
        fixedTime: FIXED_TIME,
        outputDirectory: join(scratch, 'capture'),
        seed: 1,
        recording: async (page) => {
          await page.goto(PAGE_URL)
          reading = await page.evaluate(
            PROBE as unknown as () => Promise<Reading>,
          )
          realNowMs = Date.now()
        },
      })

      expect(reading).toBeDefined()
      const seen = reading as Reading
      // The one thing the export is for: the page believes it is that day.
      expect(seen.dateIso.startsWith('2026-01-15T09:00')).toBe(true)
      // And its clock still runs. A frozen `Date.now()` never lets a
      // debounce that measures elapsed time with it (lodash's does) fire.
      expect(seen.dateAdvancedMs).toBeGreaterThanOrEqual(500)
      // `performance` is the browser's own: anchored to the real wall clock,
      // and on the same axis as the animation timeline.
      expect(Math.abs(seen.performanceWallMs - realNowMs)).toBeLessThan(10_000)
      expect(Math.abs(seen.timelineMinusPerformanceMs)).toBeLessThan(50)
      // The fade that starts "now" has finished after three times its length.
      expect(seen.opacityAfter).toBe('1')
    },
  )
})
