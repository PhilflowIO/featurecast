import type { Demo, RecordPage } from '../src/record.js'
import {
  ERSTE_ZEILE,
  RAVEN_FIXED_TIME,
  RAVEN_HIDE_SELECTORS,
  RAVEN_STATE,
  RAVEN_URL,
  warteAuf,
} from './raven-common.js'

/**
 * "Talk it over with Raven": from a finished meeting straight into a
 * conversation about it.
 *
 * The story runs meetings list → search "Steinkauz" → open the meeting →
 * "Mit Raven besprechen" → the assistant, pinned to that one meeting
 * ("Kontext: <title>"), writes a first answer by itself. The last part needs no
 * typing. Opening the assistant with `?meeting=<id>` and an empty history fires
 * one automatic turn (`ui/src/app/assistant/assistant-page-client.tsx:1435-1488`
 * in `flow.raven`).
 *
 * WHY THE SCRIPT ASKS FOR THE GRANT BEFORE IT CHOOSES A PATH. The button exists
 * only for accounts with the `verstehen_chat` grant
 * (`ui/src/app/meetings/[id]/page.tsx:1275`). Without the grant, the backend
 * refuses a pinned turn (`api/app/routers/chat.py:393-412`) and the assistant
 * prints "Das Meeting wurde nicht gefunden". That line is an
 * `assistant-message` too, so a script that just waited for one would film the
 * refusal and report success. The page answers the question itself through the
 * same `/api/entitlements` call the interface makes, and there are two paths:
 *
 *   with the grant: the button, the chip, the pinned answer;
 *   without it:    the general assistant, asked about the Steinkauz meeting
 *                  by name. That chat is not behind the grant, and it finds
 *                  the meeting through its own search.
 *
 * Deciding by polling for the button would be the fragile version. The
 * entitlements load after the meeting, so "not visible yet" and "never coming"
 * look the same for a while.
 *
 * WHAT DOES NOT HAPPEN, FOR DATA-PROTECTION REASONS: the user menu is never
 * opened (it shows the real account address), and nothing scrolls sideways
 * (capture yield).
 *
 * The answer can take up to 90 seconds to stream. That wait costs no video
 * time, because the renderer trims idle stretches.
 *
 * INVOCATION::
 *
 *     RAVEN_DEMO_EMAIL=… RAVEN_DEMO_PW=… \
 *         pnpm exec tsx demo/raven-meetings.ts anmelden
 *     pnpm featurecast run demo/raven-besprechen.ts
 */

/** The staged meeting: has a transcript and is not encrypted. */
const SUCHWORT = 'Steinkauz'

/** What the general assistant is asked when the pinned path is not available. */
const FRAGE = 'Worum ging es im Steinkauz-Meeting, und was ist offen geblieben?'

/**
 * The link that opens the first Steinkauz meeting.
 *
 * NOT the shared first-row selector. A meetings row is a clickable `div` that
 * opens the preview pane. The only `a[href^="/meetings/"]` in it is the
 * 28 px chevron "Details öffnen" (`ui/src/components/meetings/meeting-list-item.tsx:121,294-301`
 * in `flow.raven`). The first trial clicked the first row's chevron while the
 * search was still in flight, and opened a meeting that had nothing to do with
 * Steinkauz. This selector names the row by its title and takes that row's
 * chevron. The search then only narrows what the viewer sees; it no longer
 * decides which meeting opens.
 */
const STEINKAUZ_ZEILE =
  `h3:has-text("${SUCHWORT}") >> nth=0 >> ` +
  'xpath=ancestor::div[contains(concat(" ", @class, " "), " group ")][1]' +
  '//a[starts-with(@href, "/meetings/")] >> nth=0'

/** The button on the meeting page. There is no `data-testid` on it. */
const BESPRECHEN = 'role=button[name="Mit Raven besprechen"]'

/**
 * The chip above the composer. `>> nth=0` because the locator has to be
 * unambiguous before the recorder will report its geometry.
 */
const KONTEXT_CHIP = 'text=Kontext: >> nth=0'

/**
 * A finished assistant message that is an answer.
 *
 * A failed or interrupted turn is ALSO an `assistant-message`, with a marker
 * inside (`assistant-page-client.tsx:2006-2045`). The first trial waited for
 * the bare test id, took "Antwort fehlgeschlagen" for the answer, and the
 * renderer then trimmed the motionless failure away as idle time. The video
 * ended on the question.
 */
const ANTWORT =
  '[data-testid="assistant-message"]' +
  ':not(:has([data-testid="assistant-message-failed"]))' +
  ':not(:has([data-testid="assistant-message-interrupted"])) >> nth=0'

/** The marker of a turn that did not produce an answer. */
const FEHLSCHLAG =
  '[data-testid="assistant-message-failed"], ' +
  '[data-testid="assistant-message-interrupted"]'

/** An answer is a model call. The slow reasoning level can take this long. */
const ANTWORT_FRIST_MS = 90_000

/**
 * Waits for the answer, and aborts at once if the turn failed.
 *
 * A failed turn does not become an answer by waiting 90 seconds, and a
 * recording that ends on a failure is worse than none. The message names the
 * cause the trial runs actually hit: on a workstation where Docker keeps
 * creating and removing network interfaces, Chromium reports
 * `ERR_NETWORK_CHANGED` and drops the answer stream midway.
 */
async function warteAufAntwort(page: RecordPage): Promise<void> {
  const ende = Date.now() + ANTWORT_FRIST_MS
  for (;;) {
    if ((await page.locator(ANTWORT).boundingBox()) !== null) return
    if ((await page.locator(`${FEHLSCHLAG} >> nth=0`).boundingBox()) !== null) {
      throw new Error(
        'The assistant turn failed ("Antwort fehlgeschlagen"), so there is ' +
          'nothing to film. If this machine runs Docker containers that come ' +
          'and go, Chromium drops the answer stream on every network change ' +
          '(ERR_NETWORK_CHANGED). Record on a quiet machine and run it again.',
      )
    }
    if (Date.now() > ende) {
      throw new Error(`No answer within ${ANTWORT_FRIST_MS} ms: ${ANTWORT}`)
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}

/** The application that is filmed. */
export const url = RAVEN_URL

/** The composer and the answer are desktop surfaces first. */
export const devices = ['desktop-wide']

/** The path to the saved session, never its contents (`raven-common.ts`). */
export const storageStatePath = RAVEN_STATE

/** The shared list; see `raven-common.ts`. */
export const hideSelectors = RAVEN_HIDE_SELECTORS

/** A fixed clock, so relative times do not move between two runs. */
export const fixedTime = RAVEN_FIXED_TIME

export default async function besprechen(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await page.goto(`${RAVEN_URL}/meetings`)
  // The first row, not the header line: the header says "0 meetings" for a
  // second until the list has fetched its number.
  await warteAuf(page, ERSTE_ZEILE)
  await demo.hold(1000)

  await demo.type('input[placeholder*="durchsuchen"]', SUCHWORT)
  // The list fetches the result 300 ms after the last keystroke
  // (`useDebounce`). The hold lets the viewer see the list shrink. Which
  // meeting opens does not depend on it (see `STEINKAUZ_ZEILE`).
  await demo.hold(1800)
  await warteAuf(page, STEINKAUZ_ZEILE)
  await demo.click(STEINKAUZ_ZEILE)
  // The meeting's own title, not any `h1`: the list page has one too
  // ("Meetings"), and a bare `h1` is visible before the click has navigated.
  await warteAuf(page, `h1:has-text("${SUCHWORT}")`)
  await demo.hold(1400)

  // An anonymous arrow passed straight in. A named function would be wrapped
  // in tsx's `__name(...)`, which does not exist in the page (see "The trap
  // that catches every injected script" in docs/RECORDING-SCRIPTS.md).
  const gewaehrt = await page.evaluate(() =>
    fetch('/api/entitlements')
      .then((antwort) => (antwort.ok ? antwort.json() : null))
      .then(
        (daten: { features?: unknown } | null) =>
          Array.isArray(daten?.features) &&
          daten.features.includes('verstehen_chat'),
      ),
  )

  if (gewaehrt) {
    await warteAuf(page, BESPRECHEN)
    await demo.point(BESPRECHEN)
    await demo.hold(700)
    await demo.click(BESPRECHEN)
    await warteAuf(page, KONTEXT_CHIP)
    await demo.point(KONTEXT_CHIP)
    await demo.hold(1200)
  } else {
    // The same assistant, reached through the navigation instead of the
    // meeting. A `goto` would be a hard cut; a click is a move the viewer can
    // follow.
    await demo.click('a[href="/assistant"] >> nth=0')
    const eingabe = 'textarea >> nth=0'
    await warteAuf(page, eingabe)
    await demo.type(eingabe, FRAGE)
    await demo.hold(500)
    await demo.click('role=button[name="Senden"]')
  }

  await warteAufAntwort(page)
  await demo.point(ANTWORT)
  await demo.hold(3500)
}
