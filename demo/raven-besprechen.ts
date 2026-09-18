import type { Demo, RecordPage } from '../src/record.js'
import {
  RAVEN_ALLOW_FRAMING,
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

/**
 * The link that opens that meeting.
 *
 * NOT the shared first-row selector. A meetings row is a clickable `div` that
 * opens the preview pane. The only `a[href^="/meetings/"]` in it is the
 * 28 px chevron "Details öffnen" (`ui/src/components/meetings/meeting-list-item.tsx:121,294-301`
 * in `flow.raven`). An early trial clicked the first row's chevron while a
 * search was still in flight and opened the wrong meeting. This selector names
 * the row by its title and takes that row's chevron, so which meeting opens
 * never depends on where the list happens to stand.
 */
const ZEILE =
  `h3:has-text("${TITEL}") >> nth=0 >> ` +
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
 * transcript (see `TITEL`): one decision (a second foundry, 80:20 for now) and
 * one question explicitly left open (the 22,000 euros of tooling that would be
 * paid again). So the question asks for exactly that split. It was first
 * written for the Steinkauz status round, which has the same shape. "Who does
 * what by when" was dropped early: these meetings assign almost no tasks, and a
 * question whose honest answer is "nobody was named" films Raven saying no.
 */
const FRAGE = 'Was wurde entschieden, und was ist noch offen?'

/**
 * Scrolls until `selector` stands at about 45 % of the viewport height, with a
 * visible scroll the renderer keeps (swipe on a phone, wheel on a desktop).
 *
 * A tap on something at the screen's edge is filmed as a dot on a sliver of
 * button: in the first phone take the tap on "Mit Raven besprechen" landed on
 * the bottom 6 px of the button, the rest hidden under Raven's own player strip
 * (flow.raven #7217, fixed in PR #7220). Bringing the target to the middle
 * first puts it where the zoom centres anyway, with room above and below.
 * Up to three passes, because a lazily grown list can move the target while
 * the first scroll runs; a target already within 60 px of the mark is left
 * alone, so a desktop layout that shows it at once does not scroll for show.
 */
async function inDieMitte(
  page: RecordPage,
  demo: Demo,
  selector: string,
): Promise<void> {
  for (let durchgang = 0; durchgang < 3; durchgang += 1) {
    const box = await page.locator(selector).boundingBox()
    const hoehe = page.viewportSize()?.height
    if (box === null || hoehe === undefined) {
      throw new Error(`Cannot place ${selector}: no geometry`)
    }
    const abstand = Math.round(box.y + box.height / 2 - hoehe * 0.45)
    if (Math.abs(abstand) <= 60) return
    await demo.scroll(0, abstand)
  }
}

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
 * Raven forbids framing; the phone is filmed through a frame. See
 * `RAVEN_ALLOW_FRAMING` in `raven-common.ts`.
 */
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

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
