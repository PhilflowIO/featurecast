import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { launchChromium, resolveBrowserRequest } from '../src/browser.js'
import type { RecordPage } from '../src/record.js'

/**
 * What every recording of Raven shares.
 *
 * Four scripts film the same application: `raven-meetings.ts`,
 * `raven-startseite.ts`, `raven-besprechen.ts` and `raven-auto-aufnahme.ts`.
 * The target, the saved session, the areas no viewer may see, the fixed clock,
 * the visibility poller and the sign-in step are the same for all of them. They
 * live here once so that the four cannot drift apart. The failure that drift
 * causes is a privacy leak, not a style problem: a selector added to one hide
 * list and forgotten in the three others puts an internal address into a
 * public video.
 *
 * This module is deliberately NOT a recording script. It exports no `default`
 * and no `recording`, and it never calls `record()`. A module that recorded
 * itself on import would open a second, unfilmed browser in every script that
 * imports it (see `importScript` in `src/pipeline.ts`).
 */

/** The application that is filmed. Staging deploys Raven's `dev` branch. */
export const RAVEN_URL =
  process.env.RAVEN_DEMO_URL ?? 'https://staging.raven.ceo'

/**
 * The path to the saved session, never its contents.
 *
 * A `storageState` file contains the cookies and local storage of a signed-in
 * account, so it IS the access. That is why it lives under `auth/`, which
 * `.gitignore` excludes, and why no script contains a single credential.
 */
export const RAVEN_STATE = process.env.RAVEN_DEMO_STATE ?? 'auth/state.json'

/**
 * Two areas no viewer should see: the cookie notice (noise) and the
 * personal-room card, which shows the internal pre-production address in every
 * frame of the meetings list.
 *
 * The card is hidden by selector and not by feature flag because it cannot be
 * switched off per account. It hangs on the kill switch for the whole
 * deployment (`FEATURE_PERMANENT_ROOMS`,
 * `api/app/services/personal_room.py:38-55` in `flow.raven`), and the call site
 * `ui/src/app/meetings/page.tsx:151` renders it without any feature condition.
 * Withdrawing `FEATURE_PERMANENT_ROOMS_SURFACE` has already been tried and does
 * nothing here.
 */
export const RAVEN_HIDE_SELECTORS: readonly string[] = [
  '#cookie-banner',
  '[data-testid="personal-room-card"]',
]

/**
 * A fixed clock, so two recordings show the same relative times ("3 days ago"
 * otherwise moves between two runs).
 */
export const RAVEN_FIXED_TIME = '2026-09-16T09:00:00Z'

/**
 * The first row of the meetings list.
 *
 * The `nth=0` is not cosmetic. `a[href^="/meetings/"]` matches every visible
 * row, and Playwright refuses to report geometry for an ambiguous locator. The
 * recorder needs exactly that geometry to move the pointer there. Without the
 * restriction the recording aborts with a timeout that looks like a loading
 * problem and is not one.
 */
export const ERSTE_ZEILE = 'a[href^="/meetings/"] >> nth=0'

/**
 * Waits until a node genuinely has an area.
 *
 * `RecordPage` is deliberately a narrow surface and has no `waitFor`. It
 * reaches exactly as far as the recorder needs. A `boundingBox()` that no
 * longer returns `null` answers the better question here anyway: not "is the
 * node in the document" but "is it visible", and only a visible node can be
 * clicked or pointed at.
 */
export async function warteAuf(
  page: RecordPage,
  selector: string,
  fristMs = 30_000,
): Promise<void> {
  const ende = Date.now() + fristMs
  for (;;) {
    const box = await page.locator(selector).boundingBox()
    if (box !== null) return
    if (Date.now() > ende) {
      throw new Error(
        `Did not become visible within ${fristMs} ms: ${selector}`,
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}

/**
 * Signs in through the form and writes the session state.
 *
 * Through the form and not through the sign-in API. Better-Auth sets its
 * session cookies the same way on either route, but the interface also stores
 * state in the browser (the section last chosen, notices dismissed once). A
 * script that only fetches the cookie films, on its first run, a state no human
 * ever sees.
 *
 * Deliberately not a `prepare` export. The main chain knows a step of that name
 * that runs against the already-open page. This is a separate operation with
 * its own browser, it may run weeks before a recording, and its result is a
 * file.
 */
export async function anmelden(): Promise<void> {
  const email = process.env.RAVEN_DEMO_EMAIL
  const passwort = process.env.RAVEN_DEMO_PW
  if (email === undefined || passwort === undefined) {
    throw new Error(
      'RAVEN_DEMO_EMAIL and RAVEN_DEMO_PW have to be set. They are in the ' +
        'secret store, not in this repository.',
    )
  }

  // The same browser the recording drives later (`CHROME_BIN`, otherwise the
  // bundled one). This is not taste. A bare `chromium.launch()` can start a
  // different browser than the recording; on the measurement box it once
  // started one that never built the sign-in form, and after 30 seconds it
  // aborted with a timeout on `#email` that looked like a network problem.
  // And as a principle, a session should come from the browser that replays
  // it later.
  const { browser } = await launchChromium(
    { headless: true },
    resolveBrowserRequest(process.env),
  )
  try {
    const context = await browser.newContext({
      viewport: { height: 720, width: 1280 },
    })
    const page = await context.newPage()
    await page.goto(`${RAVEN_URL}/login`)
    await page.locator('#email').fill(email)
    await page.locator('#password').fill(passwort)
    await page.getByRole('button', { exact: true, name: 'Anmelden' }).click()
    await page.waitForURL('**/meetings', { timeout: 60_000 })
    // The heading is the proof, not the address. The address changes before
    // the list has loaded, and a state saved before the first successful fetch
    // can contain half a login.
    await page
      .getByRole('heading', { name: 'Meetings' })
      .waitFor({ timeout: 30_000 })

    await mkdir(dirname(RAVEN_STATE), { recursive: true })
    const state = await context.storageState()
    await writeFile(RAVEN_STATE, JSON.stringify(state, null, 2))
    await context.close()
  } finally {
    await browser.close()
  }
  console.log(`Session state written: ${RAVEN_STATE}`)
}
