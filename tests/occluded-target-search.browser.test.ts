import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { record } from '../src/record.js'

/**
 * Issue #13 acceptance against a real headless Chromium: the point search
 * must find a genuinely free band wherever it sits and however narrow it
 * is, on a small target and on a full-screen hero alike. The unit tests in
 * record.test.ts prove the search's geometry against a predicate; these
 * prove it against real `document.elementFromPoint` stacking, real
 * sub-pixel layout and a real click actually firing.
 */

const ARTIFACTS_ROOT = 'artifacts/occluded-target-001'

/**
 * A 300px-tall target with only a 6px free band left (y 247..253). Nothing
 * inset from an edge or corner lands there, and neither does a probe grid
 * whose step scales with the target.
 */
const SIX_PX_BAND_FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
      '<div style="position:fixed;left:0;top:0;width:100%;height:247px;' +
      'background:#ccc;z-index:9"></div>' +
      '<div style="position:fixed;left:0;top:253px;width:100%;' +
      'height:2000px;background:#ccc;z-index:9"></div>' +
      '<button id="t" style="position:absolute;left:600px;top:0;width:80px;' +
      'height:300px;" onclick="window.__clicked=true">T</button>' +
      '</body></html>',
  )

/**
 * The same shape at hero scale: a 1200px-tall, full-width target with a
 * 30px free band. This is the case where a size-proportional probe step
 * degrades worst — the band is 2.5% of the target's height.
 */
const HERO_BAND_FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
      '<div style="position:fixed;left:0;top:0;width:100%;height:585px;' +
      'background:#ccc;z-index:9"></div>' +
      '<div style="position:fixed;left:0;top:615px;width:100%;' +
      'height:2000px;background:#ccc;z-index:9"></div>' +
      '<div id="t" style="position:absolute;left:0;top:0;width:100%;' +
      'height:1200px;" onclick="window.__clicked=true"></div>' +
      '</body></html>',
  )

describe('occluded target search against a real headless Chromium', () => {
  it('finds and clicks a 6px free band on a 300px target', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-6px-band')
    await rm(out, { force: true, recursive: true })

    let clicked: unknown
    await record({ out, seed: 3 }, async (page, demo) => {
      await page.goto(SIX_PX_BAND_FIXTURE_URL)
      await demo.click('#t')
      clicked = await page.evaluate(
        () => (window as unknown as { __clicked?: boolean }).__clicked,
      )
    })

    expect(clicked).toBe(true)
  }, 30_000)

  it('finds and clicks a 30px free band on a 1200px-tall full-width hero', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-30px-band-hero')
    await rm(out, { force: true, recursive: true })

    // The grid on a hero this size is the search's worst case for cost;
    // the measured wall time is documented in README.md. This bound is a
    // sanity ceiling, not that measurement.
    const started = Date.now()
    let clicked: unknown
    await record({ out, seed: 3 }, async (page, demo) => {
      await page.goto(HERO_BAND_FIXTURE_URL)
      await demo.click('#t')
      clicked = await page.evaluate(
        () => (window as unknown as { __clicked?: boolean }).__clicked,
      )
    })
    const elapsedMs = Date.now() - started

    expect(clicked).toBe(true)
    expect(elapsedMs).toBeLessThan(20_000)
  }, 40_000)
})
