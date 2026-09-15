import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { waitForStableScrollGeometry } from '../src/m1-benchmark.js'

/**
 * Reproduces the layout transient of the recorded application that made the M1 benchmark's
 * scroll target depend on timing: a scroll container whose content keeps
 * growing by 1px every ~40ms, so its scroll range changes continuously for
 * a while and then stops. Real headless Chromium, real timers.
 */
const FIXTURE_HTML =
  '<!doctype html><html><body style="margin:0">' +
  '<main id="scroller" style="overflow:auto;height:300px;width:400px">' +
  '<div id="content" style="height:600px"></div></main>' +
  '<script>' +
  'window.__grow = function (steps) {' +
  '  var content = document.getElementById("content");' +
  '  var done = 0;' +
  '  var timer = setInterval(function () {' +
  '    content.style.height = (content.offsetHeight + 1) + "px";' +
  '    done += 1;' +
  '    if (steps >= 0 && done >= steps) clearInterval(timer);' +
  '  }, 40);' +
  '};' +
  '</script></body></html>'

describe('waitForStableScrollGeometry', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('resolves after about one stability window on a layout that is already still', async () => {
    await page.setContent(FIXTURE_HTML)

    const elapsed = await waitForStableScrollGeometry(page, 300, 5_000)

    expect(elapsed).toBeGreaterThanOrEqual(300)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('keeps waiting while a scroll range grows 1px at a time, and resolves only once it stops', async () => {
    await page.setContent(FIXTURE_HTML)
    await page.evaluate('window.__grow(30)')

    const elapsed = await waitForStableScrollGeometry(page, 300, 10_000)
    const range = await page.evaluate(
      'document.getElementById("scroller").scrollHeight - document.getElementById("scroller").clientHeight',
    )

    // 30 steps at 40ms is ~1.2s of growth before the 300ms window can close.
    expect(elapsed).toBeGreaterThanOrEqual(1_200)
    expect(range).toBe(330)
  })

  it('fails loudly instead of choosing during a transient that never ends', async () => {
    await page.setContent(FIXTURE_HTML)
    await page.evaluate('window.__grow(-1)')

    await expect(waitForStableScrollGeometry(page, 300, 1_000)).rejects.toThrow(
      'scroll ranges still changing',
    )
  })
})
