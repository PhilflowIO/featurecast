import type { Demo, RecordPage } from '../src/record.js'
import {
  EINGABE,
  FILM_SCROLL_TEMPO,
  RAVEN_ALLOW_FRAMING,
  RAVEN_HIDE_SELECTORS,
  RAVEN_LOCALE,
  RAVEN_STATE,
  RAVEN_URL,
  STEINKAUZ_FIXED_TIME,
  VOR_KLICK_MS,
  inDieMitte,
  ruhigKlicken,
  vorbereiten,
  warteAuf,
} from './raven-common.js'

/**
 * Product film, scene M2 "Handelt auf Zuruf": the assistant does not only
 * answer, it prepares a piece of work and asks before it acts.
 *
 * Two acts, both ending on the same product promise — Raven writes, the human
 * releases:
 *
 *   1. "Send the summary of the Abnahme Linie 3 to <address>." Raven resolves
 *      the meeting, drafts the mail and stops. The approval card names the
 *      meeting and the recipient; only the click on "Senden" sends it.
 *   2. "Put an appointment in the calendar." Raven fills in title, time and
 *      target calendar and stops again, on its own card, with "Bestätigen".
 *
 * WHY NOTHING LEAVES THE HOUSE. The recipient is on `e2e.raven.ceo`, Raven's
 * own end-to-end domain: it publishes neither an MX nor an A record, so no
 * mail addressed there can be delivered anywhere. On top of that, staging's
 * API resolves `SMTP_HOST=mailpit` — every mail it sends is sunk into the
 * Mailpit container on the staging box and reaches no mailbox at all. Both
 * facts were measured before this script was written; either one alone would
 * be enough. Do NOT put a customer, a colleague or any reachable address in
 * `EMPFAENGER`.
 *
 * WHAT THE SECOND ACT NEEDS. The appointment is a real calendar write, so a
 * calendar has to be connected on the recording account (scene M4 connects
 * one). Without it the routed agent refuses at the central gate and points at
 * `/settings/agent`, and this script aborts rather than filming the refusal.
 *
 * BOTH BUTTONS ARE CALLED "Senden". The composer's send button and the mail
 * approval card's both carry that accessible name, and an ambiguous locator
 * has no geometry for the recorder to point at. The approval card sits in the
 * message list, the composer below it, so the composer is the LAST one —
 * hence `KOMPOSER_SENDEN`'s `nth=-1` and the card-scoped selector for the
 * other. Naming them apart is the whole reason those two constants exist.
 *
 * AFTER A TAKE. Each run leaves one assistant thread, one sent mail in
 * Mailpit and one calendar event behind. Delete the thread
 * (`GET /api/chat/threads`, `DELETE /api/chat/threads/<id>`) and the event in
 * the connected calendar.
 *
 * INVOCATION (GPU host)::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-auf-zuruf.ts --devices desktop-wide,iphone
 */

/**
 * The recipient — a name on Raven's own e2e domain, which resolves nowhere.
 * Read the second paragraph of the module comment before changing this.
 */
const EMPFAENGER = 'hanne.kordt@e2e.raven.ceo'

/** The meeting whose summary is mailed. Its title carries these words. */
const MEETING_WORT = 'Abnahme Linie 3'

const FRAGE_MAIL = `Schick die Zusammenfassung von "${MEETING_WORT}" an ${EMPFAENGER}`

const FRAGE_TERMIN =
  'Leg mir am Montag um 10 Uhr einen Termin "Nachkontrolle Absaugung" an'

/**
 * The composer's send button.
 *
 * `nth=-1` and not `nth=0`: see the module comment. The approval card renders
 * above the composer and brings a second "Senden" with it.
 */
const KOMPOSER_SENDEN = 'role=button[name="Senden"] >> nth=-1'

/** The mail approval card, found by the one line only it carries. */
const FREIGABE_KARTE =
  'text=E-Mail-Versand bestätigen >> nth=0 >> ' +
  'xpath=ancestor::div[contains(@class, "rounded-lg")][1]'

/** Its send button — the one that actually releases the mail. */
const FREIGABE_SENDEN = `${FREIGABE_KARTE} >> role=button[name="Senden"]`

/** The line the interface writes once the mail has gone out. */
const GESENDET = `text=E-Mail an ${EMPFAENGER} gesendet. >> nth=0`

/** The appointment gate: Raven's filled-in card, waiting for a yes. */
const TERMIN_KARTE = '[data-testid="confirm-schedule-card"]'
const TERMIN_JA = '[data-testid="confirm-schedule-yes"]'

/**
 * How long a turn may take before the take is called off.
 *
 * Longer than the shared `ANTWORT_FRIST_MS`: both turns here run a routed
 * subgraph that resolves a meeting or a calendar in the database before the
 * model writes a word.
 */
const KARTEN_FRIST_MS = 120_000

/** Reading time on a card the viewer is meant to actually read. */
const LESEZEIT_MS = 3500

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const fixedTime = STEINKAUZ_FIXED_TIME
export const locale = RAVEN_LOCALE
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

/** The empty assistant, loaded before the camera rolls. */
export const prepare = vorbereiten('/assistant', EINGABE)

export default async function aufZuruf(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await demo.hold(1200)

  // ── Act one: the mail Raven writes and the human releases ────────────────
  await demo.hold(VOR_KLICK_MS)
  await demo.type(EINGABE, FRAGE_MAIL)
  await ruhigKlicken(demo, KOMPOSER_SENDEN)
  await demo.point(EINGABE)

  await warteAuf(page, FREIGABE_KARTE, KARTEN_FRIST_MS)
  await inDieMitte(page, demo, FREIGABE_KARTE, { tempo: FILM_SCROLL_TEMPO })
  // The card names the meeting and the recipient; give the viewer time to read
  // both before the pointer reaches for the button.
  await demo.point(FREIGABE_KARTE)
  await demo.hold(LESEZEIT_MS)

  await ruhigKlicken(demo, FREIGABE_SENDEN)
  await warteAuf(page, GESENDET, 60_000)
  await demo.hold(2500)

  // ── Act two: the appointment, gated the same way ─────────────────────────
  await demo.hold(VOR_KLICK_MS)
  await demo.type(EINGABE, FRAGE_TERMIN)
  await ruhigKlicken(demo, KOMPOSER_SENDEN)
  await demo.point(EINGABE)

  await warteAuf(page, TERMIN_KARTE, KARTEN_FRIST_MS)
  await inDieMitte(page, demo, TERMIN_KARTE, { tempo: FILM_SCROLL_TEMPO })
  await demo.point(TERMIN_KARTE)
  await demo.hold(LESEZEIT_MS)

  await ruhigKlicken(demo, TERMIN_JA)
  // The gate disappears when the write has run; what follows it is Raven's
  // confirmation. Waiting for the card to be gone is the honest end of the
  // scene — waiting for a phrase would pin the model's wording.
  await warteAufVerschwunden(page, TERMIN_KARTE, 90_000)
  await demo.hold(4000)
}

/**
 * Waits until `selector` has no geometry any more.
 *
 * `warteAuf` answers "is it there yet"; the end of this scene needs the other
 * direction. A gate card that is still on screen means the write has not run,
 * and a clip that ends on an unanswered gate shows the opposite of the
 * promise the scene is about.
 */
async function warteAufVerschwunden(
  page: RecordPage,
  selector: string,
  fristMs: number,
): Promise<void> {
  const ende = Date.now() + fristMs
  for (;;) {
    if ((await page.locator(selector).boundingBox()) === null) return
    if (Date.now() > ende) {
      throw new Error(
        `Still on screen after ${String(fristMs)} ms: ${selector}. The ` +
          'appointment gate was confirmed but nothing was written — most ' +
          'likely no calendar is connected on the recording account.',
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}
