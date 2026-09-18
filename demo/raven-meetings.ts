import { fileURLToPath } from 'node:url'

import type { Demo, RecordPage } from '../src/record.js'
import {
  anmelden,
  ERSTE_ZEILE,
  RAVEN_FIXED_TIME,
  RAVEN_HIDE_SELECTORS,
  RAVEN_STATE,
  RAVEN_URL,
  warteAuf,
} from './raven-common.js'

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

const BASIS = RAVEN_URL

/** The word the list shrinks down to in the video. */
const SUCHWORT = 'Steinkauz'

/** The application that is filmed. */
export const url = RAVEN_URL

/**
 * The path to the saved session, never its contents. The file itself is read
 * only by the browser (see `RAVEN_STATE` in `raven-common.ts`).
 */
export const storageStatePath = RAVEN_STATE

/**
 * The cookie notice and the personal-room card (internal address, see the
 * header comment). One list for every Raven recording, in `raven-common.ts`.
 */
export const hideSelectors = RAVEN_HIDE_SELECTORS

/** A fixed clock, so relative times do not move between two runs. */
export const fixedTime = RAVEN_FIXED_TIME

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
