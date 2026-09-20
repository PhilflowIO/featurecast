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
 * WHY IT IS A STRING AND NOT A FUNCTION — the defect this file was written to
 * prevent, and shipped anyway. Scene M2 was recorded on 2026-09-19 with this
 * lever installed and delivered with two squiggles in it: 52 of 1074 portrait
 * frames, found by `tools/rote-welle/detect.py`. The lever was not weak, it
 * never ran. A recording runs through `tsx`, whose esbuild keeps function
 * names by rewriting `const aus = () => {}` into `const aus = __name(() => {},
 * "aus")`. Playwright injects the payload by its source text, `__name` does
 * not exist in the page, and the whole script dies on its first line with
 * `ReferenceError: __name is not defined` — where nobody sees it, because an
 * init script's exception is a page error and a recording does not read those.
 * Measured against staging on 2026-09-20: with the function payload the root
 * carried no attribute at all in three runs out of three; the same logic as a
 * string carried `spellcheck="false"`.
 *
 * `hideOverlay` and `pinClockAndRandomness` in `src/recipes.ts` are strings for
 * exactly this reason and say so. This one was not, and that is the whole
 * story of the squiggle that survived its own fix.
 *
 * WHY IT HOLDS THE ATTRIBUTE INSTEAD OF SETTING IT. Setting it at three known
 * moments only works if nothing takes it off afterwards, and the filmed
 * application is a hydrating React shell that owns `<html>`. A `MutationObserver`
 * on the root's own attributes puts it back whatever removes it, for the life
 * of the document. The eager call stays: the observer cannot watch a root that
 * does not exist yet, which at document-start it does not.
 *
 * The restore counter is diagnosis, not decoration — it says whether a clean
 * take was clean because nothing touched the attribute or because the observer
 * kept winning. It is a window property and invisible on camera.
 */
export const SPELLCHECK_OFF_SCRIPT =
  '(function () {' +
  '  if (window.__featurecastSpellcheckRestored === undefined) {' +
  '    window.__featurecastSpellcheckRestored = 0;' +
  '  }' +
  '  var aus = function () {' +
  '    var wurzel = document.documentElement;' +
  '    if (!wurzel) return;' +
  '    if (wurzel.getAttribute("spellcheck") === "false") return;' +
  '    wurzel.setAttribute("spellcheck", "false");' +
  '    window.__featurecastSpellcheckRestored += 1;' +
  '  };' +
  '  var beobachten = function () {' +
  '    var wurzel = document.documentElement;' +
  '    if (!wurzel || wurzel.__featurecastBeobachtet) return;' +
  '    wurzel.__featurecastBeobachtet = true;' +
  '    new MutationObserver(aus).observe(wurzel, {' +
  '      attributeFilter: ["spellcheck"]' +
  '    });' +
  '  };' +
  '  var haltIt = function () { aus(); beobachten(); };' +
  '  haltIt();' +
  '  document.addEventListener("DOMContentLoaded", haltIt);' +
  '  document.addEventListener("readystatechange", haltIt);' +
  '  new MutationObserver(haltIt).observe(document, { childList: true });' +
  '})()'

/** The counter `SPELLCHECK_OFF_SCRIPT` keeps, for a probe or a test to read. */
export const SPELLCHECK_RESTORE_COUNTER = '__featurecastSpellcheckRestored'

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
