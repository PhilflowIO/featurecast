import type { BrowserContext } from 'playwright'

/**
 * No spellchecker in a recording (featurecast#183).
 *
 * featurecast#172 gave the recording browser the application's language, so a
 * German sentence stopped being underlined as English. That was right and it
 * was not enough: a dictionary underlines what it does not know, and a product
 * film is made of words no dictionary knows. Scene M1 types a customer's name,
 * "Salmweide", and a German Chromium put a red squiggle under it in all eight
 * renders.
 *
 * The deeper reason to switch it off rather than teach it words: a recording is
 * not somebody writing. Nothing typed on camera is ever wrong and nothing typed
 * on camera is ever corrected, so the checker has no job here — only the
 * ability to mark a correct proper noun as a mistake in front of an audience.
 *
 * Two levers, because they fail differently and neither alone is provable on
 * its own terms:
 *
 * - `SPELLCHECK_OFF_LAUNCH_ARGS` stops the browser's spellcheck service from
 *   starting, so the fresh profile never picks a dictionary. This is the one
 *   that can be measured from outside the page (the profile writes its choice
 *   to `Preferences`), and it is the one that would survive a page setting
 *   `spellcheck="true"` on itself.
 * - `installSpellcheckOff` sets the HTML `spellcheck` attribute to `false` on
 *   the document element of every document the context opens. The attribute's
 *   state is inherited, so one node covers every field below it, and it holds
 *   even if a future Chromium renames or ignores the feature flag.
 *
 * WHY NOT A SCREENSHOT AS PROOF. The squiggle is a compositor-drawn marker; it
 * is absent from `page.screenshot` even in a take whose recorded frames carry
 * it. Measured on the recording image 2026-09-19: three configurations —
 * untouched, flag, init script — produced three byte-identical screenshots of
 * the same typed question. Anyone reaching for a screenshot to settle this is
 * reading a picture that cannot show the thing.
 */

/**
 * Chromium arguments that keep the spellcheck service from starting.
 *
 * `--disable-features` is a single-valued flag: a second one anywhere in the
 * same argument list replaces this, it does not add to it. Today nothing else
 * in this repository passes it (checked across `src/`); anyone adding one has
 * to merge the values instead of appending a flag.
 */
export const SPELLCHECK_OFF_LAUNCH_ARGS: readonly string[] = [
  '--disable-features=SpellcheckService',
]

/**
 * The script every document of the context runs before its own scripts.
 *
 * Exported so a test can assert what is installed without launching the whole
 * recording chain, and so the attribute name appears exactly once.
 */
export const SPELLCHECK_OFF_SCRIPT = (): void => {
  const aus = (): void => {
    document.documentElement.setAttribute('spellcheck', 'false')
  }
  aus()
  document.addEventListener('DOMContentLoaded', aus)
}

/**
 * Installs the attribute half on `context`.
 *
 * Has to run BEFORE the first page, like the overlay hiding and the pinned
 * clock next to it in `recordSession`: an init script only reaches documents
 * opened afterwards.
 */
export async function installSpellcheckOff(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(SPELLCHECK_OFF_SCRIPT)
}
