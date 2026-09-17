import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchChromium, resolveBrowserRequest } from '../src/browser.js'
import type { Demo, RecordPage } from '../src/record.js'

/**
 * The first recording that films our own product rather than someone else's.
 *
 * Two steps, deliberately separated:
 *
 *   The sign-in signs in once and writes the session state to
 *   `auth/state.json`. That is the same state `docs/RECORDING-SCRIPTS.md`
 *   otherwise has you create by hand through
 *   `playwright codegen --save-storage` — only without the hand, because this
 *   target has a sign-in form with two fields and so nobody has to sit down in
 *   front of a visible browser. It is not a recording step and has therefore
 *   kept an invocation of its own.
 *
 *   The recording itself is an ordinary script of the main chain. All it does
 *   is name what should hold — saved session, hidden areas, fixed clock — and
 *   `featurecast run` establishes that, films and renders. It used to run
 *   through a recipe of its own in `demo/` that opened its own browser: that
 *   wrote an event log and not a single frame.
 *
 * WHY THE PERSONAL-ROOM CARD DISAPPEARS BY SELECTOR AND NOT BY FEATURE FLAG.
 * The card shows the internal pre-production address in every frame of the
 * list and therefore must not reach the public video. It cannot be switched
 * off for the recording account, though: it does not hang on a per-account
 * assignment but on the kill switch for the whole deployment
 * (`FEATURE_PERMANENT_ROOMS`,
 * `api/app/services/personal_room.py:38-55` in the `flow.raven` repository),
 * and the call site `ui/src/app/meetings/page.tsx:151` renders it without any
 * feature condition at all. Withdrawing `FEATURE_PERMANENT_ROOMS_SURFACE`
 * does nothing here — that has already been tried, without success. As long as
 * that is the case, hiding it before the page's first script is the only route
 * that does not change the deployment for everyone.
 *
 * WHY THE STATE DOES NOT BELONG IN THE REPOSITORY. `auth/` is excluded by
 * `.gitignore`, and that is not formalism: a `storageState` file IS the
 * access. The credentials therefore come from the environment and appear in no
 * line of this file. The main chain receives the path and never the contents
 * (`src/pipeline.ts`, `LoadedScript`).
 *
 * INVOCATION::
 *
 *     RAVEN_DEMO_EMAIL=… RAVEN_DEMO_PW=… \
 *         pnpm exec tsx demo/raven-meetings.ts anmelden
 *     pnpm featurecast run demo/raven-meetings.ts --devices desktop-wide
 *
 * If the session expires, the recording films the sign-in page instead of the
 * list. It is then not the script that is broken but the file that is old: run
 * the sign-in again.
 */

const BASIS = process.env.RAVEN_DEMO_URL ?? 'https://staging.raven.ceo'
const ZUSTAND = process.env.RAVEN_DEMO_STATE ?? 'auth/state.json'

/** The word the list shrinks down to in the video. */
const SUCHWORT = 'Steinkauz'

/**
 * The first row of the list.
 *
 * The `nth=0` is not cosmetic: `a[href^="/meetings/"]` matches every visible
 * row, and Playwright refuses to report geometry for an ambiguous locator. But
 * that is exactly what the recorder needs in order to travel the pointer
 * there — without the restriction the recording aborts with a timeout that
 * looks like a loading problem and is not one.
 */
const ERSTE_ZEILE = 'a[href^="/meetings/"] >> nth=0'

/** The application that is filmed. */
export const url = BASIS

/**
 * The path to the saved session — never its contents.
 *
 * What is written here is a file name; the file itself is read only by the
 * browser. A `storageState` file contains the cookies and local storage of a
 * signed-in account and is therefore the access itself. That is why it lives
 * under `auth/`, which `.gitignore` excludes, and why this file contains not a
 * single credential.
 */
export const storageStatePath = ZUSTAND

/**
 * Two areas no viewer should see: the cookie notice (noise) and the
 * personal-room card (internal address, see the header comment).
 */
export const hideSelectors = [
  '#cookie-banner',
  '[data-testid="personal-room-card"]',
]

/**
 * A fixed clock, so that two recordings show the same relative times
 * ("3 days ago" otherwise moves between two runs).
 */
export const fixedTime = '2026-09-16T09:00:00Z'

/**
 * Waits until a node genuinely has an area.
 *
 * `RecordPage` is deliberately a narrow surface and has no `waitFor` — it
 * reaches exactly as far as the recorder needs it to. A `boundingBox()` that
 * no longer returns `null` answers the better question here anyway: not "is
 * the node in the document" but "is it visible" — and only a visible node can
 * be clicked or pointed at.
 */
async function warteAuf(
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
 * Through the form and not through the sign-in API: Better-Auth sets its
 * session cookies the same way either route, but the interface also lays down
 * state in the browser (the section last chosen, notices that have been
 * dismissed once). Anyone who only fetches the cookie films, on the first run,
 * a state no human ever sees.
 *
 * Deliberately not a `prepare` export: the main chain knows a step of that
 * name which runs against the already-opened page — this one is an operation
 * of its own with its own browser, which may run weeks before a recording and
 * whose result is a file.
 */
async function anmelden(): Promise<void> {
  const email = process.env.RAVEN_DEMO_EMAIL
  const passwort = process.env.RAVEN_DEMO_PW
  if (email === undefined || passwort === undefined) {
    throw new Error(
      'RAVEN_DEMO_EMAIL and RAVEN_DEMO_PW have to be set. They are in the ' +
        'secret store, not in this repository.',
    )
  }

  // The same browser the recording drives later (`CHROME_BIN`, otherwise the
  // bundled one). Not taste: on the measurement box the patched build is the
  // only one that renders the interface at all — a `chromium.launch()` without
  // this resolution starts a different browser that never builds the sign-in
  // form and aborts after 30 seconds with a timeout on `#email` that looks
  // like a network problem. And as a matter of principle: a session should
  // come from the browser that replays it afterwards.
  const { browser } = await launchChromium(
    { headless: true },
    resolveBrowserRequest(process.env),
  )
  try {
    const context = await browser.newContext({
      viewport: { height: 720, width: 1280 },
    })
    const page = await context.newPage()
    await page.goto(`${BASIS}/login`)
    await page.locator('#email').fill(email)
    await page.locator('#password').fill(passwort)
    await page.getByRole('button', { exact: true, name: 'Anmelden' }).click()
    await page.waitForURL('**/meetings', { timeout: 60_000 })
    // The heading, not the address, is the proof: the address changes before
    // the list has loaded, and a state saved before the first successful fetch
    // can contain half a login.
    await page
      .getByRole('heading', { name: 'Meetings' })
      .waitFor({ timeout: 30_000 })

    await mkdir(dirname(ZUSTAND), { recursive: true })
    const state = await context.storageState()
    await writeFile(ZUSTAND, JSON.stringify(state, null, 2))
    await context.close()
  } finally {
    await browser.close()
  }
  console.log(`Session state written: ${ZUSTAND}`)
}

/**
 * Records the list: arrive, let it be read, search, open the result.
 *
 * The change of state IS the content — the header line counts over from
 * "N meetings" to "N hits". That is why a `hold` comes before the typing:
 * anyone who has not read the number beforehand sees no change afterwards.
 *
 * What does NOT happen here, for data-protection reasons: the user menu is not
 * opened (opened, it shows the real account address), and the contact card of
 * the participant "Marlene Ostwald" is not clicked (self-recognition by
 * matching name takes effect there and returns the address of the signed-in
 * account instead of the invented one).
 */
export default async function aufnahme(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await page.goto(`${BASIS}/meetings`)
  // Wait for the first row, not for the header line: the header line is in the
  // document immediately and says "0 meetings" for a second, because the list
  // only fetches its number from the server afterwards. Anyone who waits for
  // it films the zero.
  await warteAuf(page, ERSTE_ZEILE)
  await demo.point('[data-testid="meeting-count"]')
  await demo.hold(1400)

  await demo.type('input[placeholder*="durchsuchen"]', SUCHWORT)
  // The list only fetches the result from the server 300 ms after the last
  // keystroke (`useDebounce` in the interface). A shorter hold films the old
  // number.
  await demo.hold(1800)
  await demo.point('[data-testid="meeting-count"]')
  await demo.hold(1200)

  await demo.click(ERSTE_ZEILE)
  await warteAuf(page, 'h1')
  await demo.hold(1200)
  await demo.scroll(0, 900)
  await demo.hold(900)
  await demo.scroll(0, 900)
  await demo.hold(1200)
}

// The sign-in only. The recording runs through `featurecast run` — a script
// that records itself opens a second, unfilmed browser on mere import (see
// `importScript` in `src/pipeline.ts`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [schritt] = process.argv.slice(2)
  if (schritt === 'anmelden' || schritt === 'prepare') {
    await anmelden()
  } else {
    throw new Error(
      'Usage: tsx demo/raven-meetings.ts anmelden — the recording runs ' +
        'through featurecast run demo/raven-meetings.ts --devices desktop-wide',
    )
  }
}
