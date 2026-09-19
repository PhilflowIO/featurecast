import type { Demo, RecordPage } from '../src/record.js'
import {
  BESPRECHEN,
  EINGABE,
  ERSTE_ZEILE,
  KONTEXT_CHIP,
  RAVEN_ALLOW_FRAMING,
  RAVEN_LOCALE,
  RAVEN_FIXED_TIME,
  RAVEN_HIDE_SELECTORS,
  RAVEN_STATE,
  RAVEN_URL,
  SENDEN,
  inDieMitte,
  vorbereiten,
  warteAuf,
  warteAufAntwort,
  zeileMitTitel,
} from './raven-common.js'

/**
 * "Talk it over with Raven": from a finished meeting straight into a
 * conversation about it.
 *
 * The story runs meetings list → scroll down through the list → open one
 * meeting by its title → "Mit Raven besprechen" → the assistant, pinned to that one meeting
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
 *
 * On the GPU host the session has to be copied over explicitly::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-besprechen.ts --devices iphone,desktop-wide
 */

/**
 * The staged meeting that is opened: has a transcript, a summary, and is not
 * encrypted.
 *
 * The list is scrolled, not searched. The first takes typed "Steinkauz" into
 * the search, and the list then showed sixteen rows that all read "Projekt
 * Steinkauz — Sta…" at phone width: a monotonous list is the opposite of what
 * the opening shot should say. The demo account holds 115 fictional meetings of
 * a fictional firm (staging DB, 2026-09-18), and the unfiltered list from the
 * top down to this one passes customer talks, trainings, weekly rounds and a
 * supplier talk. It is the sixteenth row by date, so reaching it is a real
 * scroll on every device (document y ≈1550 on a 390×844 phone, ≈1350 at
 * 1920×1200).
 *
 * Its content, read before the question below was kept: Ockerbach tells its
 * foundry that a second source is being built (decided, 80:20 for now); who
 * pays the tooling a second time, 22,000 euros that only fit the current
 * foundry's moulding line, is left open.
 */
const TITEL = 'Hirtenscheibe Guss'

/** The link that opens that meeting (see `zeileMitTitel`). */
const ZEILE = zeileMitTitel(TITEL)

/**
 * The question the viewer asks.
 *
 * Chosen against the meeting's own content, read from its summary and
 * transcript (see `TITEL`): one decision (a second foundry, 80:20 for now) and
 * one question explicitly left open (the 22,000 euros of tooling that would be
 * paid again). So the question asks for exactly that split. It was first
 * written for the Steinkauz status round, which has the same shape. "Who does
 * what by when" was dropped early: these meetings assign almost no tasks, and a
 * question whose honest answer is "nobody was named" films Raven saying no.
 */
const FRAGE = 'Was wurde entschieden, und was ist noch offen?'

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
 * Raven forbids framing; the phone is filmed through a frame. See
 * `RAVEN_ALLOW_FRAMING` in `raven-common.ts`.
 */
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING
export const locale = RAVEN_LOCALE

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

  // Down the unfiltered list to the meeting: the viewer sees a firm's week,
  // not one project's series. The row is attached from the first page load
  // (twenty rows arrive at once), so no lazy loading is waited on here.
  await inDieMitte(page, demo, ZEILE)
  await demo.hold(900)
  await warteAuf(page, ZEILE)
  await demo.click(ZEILE)
  // The meeting's own title, not any `h1`: the list page has one too
  // ("Meetings"), and a bare `h1` is visible before the click has navigated.
  await warteAuf(page, `h1:has-text("${TITEL}")`)
  await demo.hold(1400)

  await warteAuf(page, BESPRECHEN)
  await inDieMitte(page, demo, BESPRECHEN)
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
