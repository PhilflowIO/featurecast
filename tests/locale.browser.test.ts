import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

import { BUNDLE_CHANNEL } from '../src/browser.js'
import { localeLaunchEnvironment } from '../src/locale.js'

/**
 * The browser a German application is filmed in chooses a German spellcheck
 * dictionary (featurecast#172).
 *
 * The dictionary is a choice of the fresh profile, made from the browser's
 * application locale, and it lands in the profile's `Preferences`. Reading it
 * there proves the mechanism without depending on the dictionary download or
 * on judging red pixels. The first case is the control: the same launch
 * without the environment chooses English, which is what put squiggles under
 * every German word of the Raven film.
 */

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function chosenDictionaries(
  env: Record<string, string> | undefined,
): Promise<unknown> {
  const profile = await mkdtemp(join(tmpdir(), 'featurecast-locale-'))
  directories.push(profile)
  const context = await chromium.launchPersistentContext(profile, {
    channel: BUNDLE_CHANNEL,
    headless: true,
    ...(env === undefined ? {} : { env }),
  })
  const page = context.pages()[0] ?? (await context.newPage())
  // The spellcheck service, and with it the dictionary choice, starts with
  // the first editable field that gets text — not with the profile.
  await page.setContent('<textarea lang="de"></textarea>')
  await page.locator('textarea').click()
  await page.keyboard.type('Was wurde entschieden')
  await page.waitForTimeout(2000)
  await context.close()
  const preferences = JSON.parse(
    await readFile(join(profile, 'Default', 'Preferences'), 'utf8'),
  ) as { spellcheck?: { dictionaries?: unknown } }
  return preferences.spellcheck?.dictionaries
}

describe('recording locale', () => {
  it(
    'an English environment chooses an English dictionary (control)',
    { timeout: 60_000 },
    async () => {
      const english = localeLaunchEnvironment('en-US', process.env)
      expect(await chosenDictionaries(english)).toEqual(['en-US'])
    },
  )

  it(
    'a German locale chooses a German dictionary',
    { timeout: 60_000 },
    async () => {
      const german = localeLaunchEnvironment('de-DE', process.env)
      const dictionaries = await chosenDictionaries(german)
      expect(dictionaries).toEqual(
        expect.arrayContaining([expect.stringMatching(/^de/)]),
      )
      expect(dictionaries).not.toContain('en-US')
    },
  )
})
