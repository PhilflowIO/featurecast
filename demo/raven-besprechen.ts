import type { Demo, RecordPage } from '../src/record.js'
import {
  ERSTE_ZEILE,
  RAVEN_FIXED_TIME,
  RAVEN_HIDE_SELECTORS,
  RAVEN_STATE,
  RAVEN_URL,
  vorbereiten,
  warteAuf,
} from './raven-common.js'

/**
 * "Talk it over with Raven": from a finished meeting straight into a
 * conversation about it.
 *
 * The story runs meetings list → search "Steinkauz" → open the meeting →
 * "Mit Raven besprechen" → the assistant, pinned to that one meeting
 * ("Kontext: <title>"), writes a first answer by itself → the viewer's own
 * question, typed into the composer, and Raven's answer to it. Opening the
 * assistant with `?meeting=<id>` and an empty history fires one automatic turn
 * (`ui/src/app/assistant/assistant-page-client.tsx:1435-1488` in `flow.raven`).
 * That turn names the meeting's topics and offers follow-ups; it is concrete
 * but it is not an answer to anything. The typed question is what shows the
 * feature doing its job.
 *
 * The button is shown to every account since flow.raven PR #7035; before it,
 * it needed the `verstehen_chat` grant and the script had a second path for
 * accounts without it. That path is gone with the gate. If the button does not
 * appear, `warteAuf` fails the recording rather than filming something else.
 *
 * WHAT DOES NOT HAPPEN, FOR DATA-PROTECTION REASONS: the user menu is never
 * opened (it shows the real account address), and nothing scrolls sideways
 * (capture yield).
 *
 * The answer can take up to 90 seconds to stream. The still part of that wait
 * costs no video time, because the renderer trims idle stretches. The closing
 * `hold` does stay in full (featurecast#139): it is the reading time for the
 * answer.
 *
 * INVOCATION::
 *
 *     RAVEN_DEMO_EMAIL=… RAVEN_DEMO_PW=… \
 *         pnpm exec tsx demo/raven-meetings.ts anmelden
 *     pnpm featurecast run demo/raven-besprechen.ts
 */

/** The staged meeting: has a transcript and is not encrypted. */
const SUCHWORT = 'Steinkauz'

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
const ANTWORT_OHNE_NUMMER =
  '[data-testid="assistant-message"]' +
  ':not(:has([data-testid="assistant-message-failed"]))' +
  ':not(:has([data-testid="assistant-message-interrupted"]))'

/**
 * The n-th finished answer, counted from zero: 0 is Raven's own opening, 1
 * the answer to `FRAGE`. A turn still streaming is a different node
 * (`assistant-message-streaming`), so this only matches once it has settled.
 */
function antwort(nummer: number): string {
  return `${ANTWORT_OHNE_NUMMER} >> nth=${String(nummer)}`
}

/** The composer at the bottom, where the pointer waits for the answer. */
const EINGABE = 'textarea >> nth=0'

/** The composer's send button. Enter would do too, but `demo` has no keys. */
const SENDEN = 'role=button[name="Senden"]'

/**
 * The question the viewer asks.
 *
 * Chosen against the meeting's own content, read from its summary and
 * transcript before it was written down (Projekt Steinkauz, Statusrunde KW 37):
 * three decisions (technical release end of October; no development price for
 * Salmweide Energie but a volume discount of 240 euros bound to 600 units in
 * twelve months; the right of first refusal cut to six months and one size)
 * and one question explicitly left open (who trains the second shift). So the
 * question asks for exactly that split. "Who does what by when" was the first
 * idea and was dropped: the meeting assigns almost no tasks, and a question
 * whose honest answer is "nobody was named" films Raven saying no.
 */
const FRAGE = 'Was wurde entschieden, und was ist noch offen?'

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
async function warteAufAntwort(
  page: RecordPage,
  nummer: number,
): Promise<void> {
  const ende = Date.now() + ANTWORT_FRIST_MS
  for (;;) {
    if ((await page.locator(antwort(nummer)).boundingBox()) !== null) return
    if ((await page.locator(`${FEHLSCHLAG} >> nth=0`).boundingBox()) !== null) {
      throw new Error(
        'The assistant turn failed ("Antwort fehlgeschlagen"), so there is ' +
          'nothing to film. If this machine runs Docker containers that come ' +
          'and go, Chromium drops the answer stream on every network change ' +
          '(ERR_NETWORK_CHANGED). Record on a quiet machine and run it again.',
      )
    }
    if (Date.now() > ende) {
      throw new Error(
        `No answer within ${String(ANTWORT_FRIST_MS)} ms: ${antwort(nummer)}`,
      )
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

/**
 * The list is loaded before the camera rolls, so the clip opens on it and not
 * on a white page (see `vorbereiten`).
 */
export const prepare = vorbereiten('/meetings', ERSTE_ZEILE)

export default async function besprechen(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  // `prepare` has opened the list and seen its first row.
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

  await warteAuf(page, BESPRECHEN)
  await demo.point(BESPRECHEN)
  await demo.hold(700)
  await demo.click(BESPRECHEN)
  await warteAuf(page, KONTEXT_CHIP)
  await demo.point(KONTEXT_CHIP)
  await demo.hold(1200)

  // Out of the way before the answer lands: a pointer resting on the chip or
  // on the answer covers exactly the words the viewer is meant to read.
  await demo.point(EINGABE)

  await warteAufAntwort(page, 0)
  // Long enough to see that Raven opened by itself, not long enough to read
  // it all: the answer the clip is about comes next.
  await demo.hold(2500)

  await demo.type(EINGABE, FRAGE)
  await demo.hold(500)
  await demo.click(SENDEN)
  // Out of the answer's way again, for the same reason as above.
  await demo.point(EINGABE)
  await warteAufAntwort(page, 1)
  // Reading time. A scripted hold is kept in full by the renderer.
  await demo.hold(8000)
}
