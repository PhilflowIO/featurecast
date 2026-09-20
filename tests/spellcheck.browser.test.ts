import { execFile } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'

import { BUNDLE_CHANNEL } from '../src/browser.js'
import { localeLaunchEnvironment } from '../src/locale.js'
import {
  installSpellcheckOff,
  SPELLCHECK_OFF_SCRIPT,
} from '../src/spellcheck.js'

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

  /**
   * The case that shipped a defect. Scene M2 was recorded with this lever
   * installed and delivered with two squiggles in it, because setting an
   * attribute at three known moments only holds if nothing takes it off again
   * — and Raven's shell is a hydrating React application that owns `<html>`.
   * Here the removal is done by hand, which is the same event from the
   * document's side.
   */
  it(
    'puts the attribute back when the page removes it',
    { timeout: 60_000 },
    async () => {
      const browser = await chromium.launch({
        channel: BUNDLE_CHANNEL,
        env: localeLaunchEnvironment('de-DE', process.env),
        headless: true,
      })
      try {
        const context = await browser.newContext({ locale: 'de-DE' })
        await installSpellcheckOff(context)
        const seite = await context.newPage()
        await seite.goto(SEITE)
        const nachher = await seite.evaluate(async () => {
          document.documentElement.removeAttribute('spellcheck')
          document.documentElement.setAttribute('spellcheck', 'true')
          await new Promise((fertig) => requestAnimationFrame(fertig))
          return {
            spellcheck: document.documentElement.spellcheck,
            wiederhergestellt: (
              window as unknown as { __featurecastSpellcheckRestored: number }
            ).__featurecastSpellcheckRestored,
          }
        })
        expect(nachher.spellcheck).toBe(false)
        expect(nachher.wiederhergestellt).toBeGreaterThan(1)
      } finally {
        await browser.close()
      }
    },
  )
})

/**
 * The trap that made the lever a no-op for three weeks without a single red
 * test: a recording runs through `tsx`, and esbuild's `keepNames` rewrites
 * `const aus = () => {}` into `const aus = __name(() => {}, "aus")`. Playwright
 * injects an init script by its source text, `__name` does not exist in the
 * page, and the payload dies on its first line — as a page error, which a
 * recording never reads. Vitest's own transform does not do that, so no test
 * in this file could ever have caught it.
 *
 * This one can, because it runs the real binary: `tsx` installs the real lever
 * against a real page, and the page says what it thinks of itself.
 */
describe('the lever survives the transform a recording runs through', () => {
  it('is a string payload, not a function', () => {
    expect(typeof SPELLCHECK_OFF_SCRIPT).toBe('string')
  })

  it('works when installed through tsx', { timeout: 120_000 }, async () => {
    const wurzel = join(import.meta.dirname, '..')
    const skript = [
      `import { chromium } from 'playwright'`,
      `import { BUNDLE_CHANNEL } from './src/browser.js'`,
      `import { installSpellcheckOff } from './src/spellcheck.js'`,
      `const browser = await chromium.launch({ channel: BUNDLE_CHANNEL, headless: true })`,
      `const context = await browser.newContext()`,
      `await installSpellcheckOff(context)`,
      `const page = await context.newPage()`,
      `const fehler = []`,
      `page.on('pageerror', (e) => fehler.push(String(e)))`,
      `await page.goto(${JSON.stringify(SEITE)})`,
      `process.stdout.write(JSON.stringify({`,
      `  attr: await page.evaluate(() => document.documentElement.getAttribute('spellcheck')),`,
      `  fehler,`,
      `}))`,
      `await browser.close()`,
    ].join('\n')
    // Inside the checkout, not the temp directory: the payload imports
    // `playwright`, and module resolution finds it only from here.
    const datei = join(wurzel, `.spellcheck-tsx-${String(process.pid)}.mts`)
    await writeFile(datei, skript)
    try {
      const { stdout } = await promisify(execFile)(
        'pnpm',
        ['exec', 'tsx', datei],
        { cwd: wurzel },
      )
      expect(JSON.parse(stdout.trim())).toEqual({ attr: 'false', fehler: [] })
    } finally {
      await rm(datei, { force: true })
    }
  })
})
