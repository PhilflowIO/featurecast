import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hideOverlay } from '../src/recipes.js'
import { BUNDLE_CHANNEL } from '../src/browser.js'

/**
 * What `hideOverlay` has to do, measured in a real browser rather than read
 * from the CSS it builds.
 *
 * Two nodes, not one. A recording rarely has a single thing in the way: the
 * consent banner goes, and so does the card that shows an internal address.
 * A test with one node would pass just as happily against the old one-string
 * signature, so it would measure nothing that changed.
 *
 * The invalid-selector case is the reason the implementation emits one rule
 * per selector instead of one comma-joined group. A group selector is parsed
 * as a unit: one selector the browser does not understand and the whole rule
 * is dropped, taking the valid selectors with it — the overlay stays on
 * screen and nothing anywhere reports a problem.
 */

const FIXTURE_HTML =
  '<!doctype html><html><body style="margin:0">' +
  '<div id="cookie-banner" style="height:80px;background:#222">Consent</div>' +
  '<div id="address-card" style="height:120px;background:#444">internal.example.invalid</div>' +
  '<h1 id="headline">Keep me</h1>' +
  '</body></html>'
const FIXTURE_URL = `data:text/html,${encodeURIComponent(FIXTURE_HTML)}`

type Visibility = Readonly<Record<string, boolean>>

describe('hideOverlay', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ channel: BUNDLE_CHANNEL, headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  async function visibilityAfterHiding(
    selectors: readonly string[],
  ): Promise<Visibility> {
    const context = await browser.newContext({
      viewport: { height: 720, width: 1280 },
    })
    try {
      await hideOverlay(context, selectors)
      const page = await context.newPage()
      await page.goto(FIXTURE_URL, { waitUntil: 'load' })
      return (await page.evaluate(`
        (function () {
          var shown = function (id) {
            var node = document.getElementById(id);
            if (node === null) return false;
            return node.getClientRects().length > 0;
          };
          return {
            banner: shown('cookie-banner'),
            card: shown('address-card'),
            headline: shown('headline')
          };
        })()
      `)) as Visibility
    } finally {
      await context.close()
    }
  }

  it('hides two separate nodes at once', async () => {
    const visible = await visibilityAfterHiding([
      '#cookie-banner',
      '#address-card',
    ])

    expect(visible.banner).toBe(false)
    expect(visible.card).toBe(false)
    // The page itself has to survive: a rule broad enough to take the
    // headline with it would pass the two assertions above.
    expect(visible.headline).toBe(true)
  })

  it('keeps hiding the valid nodes when one selector is nonsense', async () => {
    const visible = await visibilityAfterHiding([
      '#cookie-banner',
      '::not-a-thing',
      '#address-card',
    ])

    expect(visible.banner).toBe(false)
    expect(visible.card).toBe(false)
    expect(visible.headline).toBe(true)
  })

  it('leaves the page untouched when nothing is named', async () => {
    const visible = await visibilityAfterHiding([])

    expect(visible.banner).toBe(true)
    expect(visible.card).toBe(true)
    expect(visible.headline).toBe(true)
  })
})
