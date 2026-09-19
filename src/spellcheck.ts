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
 * THE LEVER IS THE DOCUMENT, NOT THE BROWSER, and that is a measurement and not
 * a preference. Six launch-argument spellings were tried against a fresh
 * profile on the recording image (Chromium 154, 2026-09-19), each with a German
 * word typed into a textarea, each read back from the profile's `Preferences`:
 * `--disable-spell-checking`, `--disable-features=Spellcheck`,
 * `--disable-features=SpellcheckService,SpellingService`,
 * `--disable-features=UseBrowserSpellChecker`, the two combined, and the
 * control. All six chose `["de"]`. The browser cannot be talked out of its
 * dictionary from the command line.
 *
 * What does work is the HTML attribute, which is not a Chromium detail but the
 * specified way a document says it is not to be checked, and whose state is
 * INHERITED — one node at the root covers every field below it. Raven sets
 * `spellCheck` explicitly in exactly one place and sets it to `false`
 * (`ui/src/components/handle/handle-claim-field.tsx` in `flow.raven`), so
 * nothing opts back in.
 *
 * WHY NOT A SCREENSHOT AS PROOF. The squiggle is a compositor-drawn marker; it
 * is absent from `page.screenshot` even in a take whose recorded frames carry
 * it. Measured on the same image the same day: three configurations produced
 * three byte-identical screenshots of the same typed question. Anyone reaching
 * for a screenshot to settle this is reading a picture that cannot show the
 * thing — which is why the test below reads the attribute instead.
 */

/**
 * The script every document of the context runs before its own scripts.
 *
 * Applied three times on purpose. An init script runs at document-start, when
 * a freshly navigated document may not have a root element yet — hence the
 * optional call. `DOMContentLoaded` catches that case. `readystatechange`
 * catches a document whose root was REPLACED after parsing, which is what
 * `Document.write` and Playwright's own `setContent` do.
 *
 * Exported so a test can install it without the whole recording chain, and so
 * the attribute name appears exactly once.
 */
export const SPELLCHECK_OFF_SCRIPT = (): void => {
  const aus = (): void => {
    document.documentElement?.setAttribute('spellcheck', 'false')
  }
  aus()
  document.addEventListener('DOMContentLoaded', aus)
  document.addEventListener('readystatechange', aus)
}

/**
 * Installs it on `context`.
 *
 * Has to run BEFORE the first page, like the overlay hiding and the pinned
 * clock beside it in `recordSession`: an init script only reaches documents
 * opened afterwards.
 */
export async function installSpellcheckOff(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(SPELLCHECK_OFF_SCRIPT)
}
