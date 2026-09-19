import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

import { BUNDLE_CHANNEL } from '../src/browser.js'
import { localeLaunchEnvironment } from '../src/locale.js'
import {
  SPELLCHECK_OFF_LAUNCH_ARGS,
  installSpellcheckOff,
} from '../src/spellcheck.js'

/**
 * A recording does not spellcheck (featurecast#183).
 *
 * Two levers, measured separately, because they fail differently. The profile's
 * dictionary choice proves the service never started; the document element's
 * attribute proves the page would not be checked even if it had.
 *
 * NOT measured by looking at the picture. The squiggle is a compositor-drawn
 * marker and `page.screenshot` does not carry it: three configurations —
 * untouched, flag, init script — gave three identical screenshots of the same
 * typed sentence on 2026-09-19. A test built on pixels here would pass before
 * the fix.
 */

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

/**
 * The dictionaries a fresh German profile chose after text was typed into an
 * editable field. Mirrors `tests/locale.browser.test.ts`, which established
 * that the choice is made at the first typed character and lands in
 * `Preferences`.
 */
async function chosenDictionaries(args: readonly string[]): Promise<unknown> {
  const profile = await mkdtemp(join(tmpdir(), 'featurecast-spellcheck-'))
  directories.push(profile)
  const context = await chromium.launchPersistentContext(profile, {
    args: [...args],
    channel: BUNDLE_CHANNEL,
    env: localeLaunchEnvironment('de-DE', process.env),
    headless: true,
  })
  const page = context.pages()[0] ?? (await context.newPage())
  await page.setContent('<textarea lang="de"></textarea>')
  await page.locator('textarea').click()
  await page.keyboard.type('Salmweide Wüstenhagen')
  await page.waitForTimeout(2000)
  await context.close()
  const preferences = JSON.parse(
    await readFile(join(profile, 'Default', 'Preferences'), 'utf8'),
  ) as { spellcheck?: { dictionaries?: unknown } }
  return preferences.spellcheck?.dictionaries
}

describe('no spellchecker in a recording', () => {
  it(
    'without the arguments a German profile still picks a dictionary (control)',
    { timeout: 60_000 },
    async () => {
      expect(await chosenDictionaries([])).toEqual(
        expect.arrayContaining([expect.stringMatching(/^de/)]),
      )
    },
  )

  it(
    'the recording arguments leave the profile without one',
    { timeout: 60_000 },
    async () => {
      const dictionaries = await chosenDictionaries(SPELLCHECK_OFF_LAUNCH_ARGS)
      expect(dictionaries ?? []).toEqual([])
    },
  )

  it(
    'every document of the context reports spellcheck off',
    { timeout: 60_000 },
    async () => {
      const browser = await chromium.launch({
        channel: BUNDLE_CHANNEL,
        headless: true,
      })
      try {
        const context = await browser.newContext()
        await installSpellcheckOff(context)
        const page = await context.newPage()
        // A second document too: an init script that only reached the first
        // page would leave every later navigation checked again.
        await page.setContent('<textarea></textarea>')
        expect(
          await page.evaluate(() => document.documentElement.spellcheck),
        ).toBe(false)
        const zweite = await context.newPage()
        await zweite.setContent('<input>')
        expect(
          await zweite.evaluate(() => document.documentElement.spellcheck),
        ).toBe(false)
      } finally {
        await browser.close()
      }
    },
  )
})
