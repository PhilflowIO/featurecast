import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'

import { BUNDLE_CHANNEL } from '../src/browser.js'
import { localeLaunchEnvironment } from '../src/locale.js'
import { installSpellcheckOff } from '../src/spellcheck.js'

/**
 * A recording does not spellcheck (featurecast#183).
 *
 * The lever is the document's own attribute, because the browser has none that
 * works: six launch-argument spellings were measured against a fresh profile on
 * the recording image and all six still chose a German dictionary
 * (`src/spellcheck.ts`). So what is asserted here is what a document reports
 * about itself, over a REAL navigation — the state has to survive the document
 * being built, and a page whose content was written into it afterwards is the
 * case that first caught this script out.
 *
 * NOT asserted by looking at the picture. The squiggle is a compositor-drawn
 * marker and `page.screenshot` does not carry it: three configurations gave
 * three identical screenshots of the same typed sentence on 2026-09-19. A test
 * built on pixels here would pass before the fix.
 */

/** A document that arrives through a navigation, like every filmed page. */
const SEITE =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html lang="de"><body><textarea></textarea></body></html>',
  )

async function spellcheckDerSeite(installieren: boolean): Promise<boolean[]> {
  const browser = await chromium.launch({
    channel: BUNDLE_CHANNEL,
    env: localeLaunchEnvironment('de-DE', process.env),
    headless: true,
  })
  try {
    const context = await browser.newContext({ locale: 'de-DE' })
    if (installieren) await installSpellcheckOff(context)
    const gemessen: boolean[] = []
    // Two documents and a second navigation in the first: a script that only
    // reached the opening page would leave every later page checked again,
    // which is the failure mode that matters in a tour of several screens.
    const erste = await context.newPage()
    await erste.goto(SEITE)
    gemessen.push(
      await erste.evaluate(() => document.documentElement.spellcheck),
    )
    await erste.goto(SEITE)
    gemessen.push(
      await erste.evaluate(() => document.documentElement.spellcheck),
    )
    const zweite = await context.newPage()
    await zweite.goto(SEITE)
    gemessen.push(
      await zweite.evaluate(() => document.documentElement.spellcheck),
    )
    return gemessen
  } finally {
    await browser.close()
  }
}

describe('no spellchecker in a recording', () => {
  it(
    'a page is checked when nothing is installed (control)',
    { timeout: 60_000 },
    async () => {
      expect(await spellcheckDerSeite(false)).toEqual([true, true, true])
    },
  )

  it(
    'every document of the context reports spellcheck off',
    { timeout: 60_000 },
    async () => {
      expect(await spellcheckDerSeite(true)).toEqual([false, false, false])
    },
  )
})
