/**
 * The language a recording is filmed in (featurecast#172).
 *
 * A locale has two owners in Chromium, and a recording has to set both:
 *
 * - The page's: `navigator.language`, the `Accept-Language` header, `Intl`
 *   formatting. Playwright's context option `locale` sets these.
 * - The browser's: its application locale, which decides the UI strings AND
 *   the spellcheck dictionary of a fresh profile. On Linux Chromium reads it
 *   from the process environment (`LANGUAGE`/`LANG`); neither the context
 *   locale nor `--lang` reaches it.
 *
 * Measured on the recording image (Chromium 154, a fresh profile, a German
 * sentence typed into a textarea on a `lang="de"` page): with only the
 * context locale the profile still chose `spellcheck.dictionaries: ["en-US"]`,
 * downloaded `en-US-10-2.bdic`, and underlined every German word in red —
 * which is how the Raven film got squiggles under a correctly spelled
 * question. With `LANG=de_DE.UTF-8` in the browser's environment the profile
 * chose `["de"]`, downloaded `de-DE-3-0.bdic`, and underlined nothing. A German
 * user's browser is German at both levels; the recording has to be too.
 */

/** Canonical BCP 47 tag of `value`, or an error naming what was wrong. */
export function readLocale(value: unknown, path = 'the script'): string {
  const usage = "`export const locale = 'de-DE'`"
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `"${path}" exports \`locale\`, which has to be a language tag with a region: ${usage}.`,
    )
  }
  let canonical: string
  try {
    ;[canonical = ''] = Intl.getCanonicalLocales(value)
  } catch {
    throw new Error(
      `"${path}" exports \`locale\` "${value}", which is not a language tag: ${usage}.`,
    )
  }
  const region = new Intl.Locale(canonical).region
  if (region === undefined) {
    // The POSIX name the browser's environment needs is language_REGION.
    // Guessing the region ("de" → Germany, not Austria or Switzerland) would
    // pick a dictionary and date formats nobody chose.
    throw new Error(
      `"${path}" exports \`locale\` "${value}" without a region; name one: ${usage}.`,
    )
  }
  return canonical
}

/**
 * The environment to launch the browser with so its application locale — and
 * with it the spellcheck dictionary of the fresh recording profile — is
 * `locale`.
 *
 * `LC_ALL` and `LC_MESSAGES` are removed rather than overwritten: either one
 * outranks `LANG`, so an inherited value would silently keep the old
 * language, and setting them to a locale the container may not have
 * installed makes C libraries in the browser complain for nothing. What
 * Chromium needs is the name, which `LANGUAGE` and `LANG` carry.
 */
export function localeLaunchEnvironment(
  locale: string,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  const { language, region } = new Intl.Locale(locale)
  const posix = `${language}_${region ?? ''}`
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && name !== 'LC_ALL' && name !== 'LC_MESSAGES') {
      environment[name] = value
    }
  }
  environment['LANG'] = `${posix}.UTF-8`
  environment['LANGUAGE'] = `${posix}:${language}`
  return environment
}
