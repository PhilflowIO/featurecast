import type { Demo, RecordPage } from '../src/record.js'
import {
  EINGABE,
  FILM_SCROLL_TEMPO,
  RAVEN_ALLOW_FRAMING,
  RAVEN_HIDE_SELECTORS,
  RAVEN_LOCALE,
  RAVEN_STATE,
  RAVEN_TIMEZONE,
  RAVEN_URL,
  VOR_KLICK_MS,
  inDieMitte,
  letzteAntwort,
  ruhigKlicken,
  vorbereiten,
  warteAuf,
  warteAufVerschwunden,
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
 *   3. The appointment, standing in Raven's own calendar on the day it was
 *      asked for. The scene's spoken line is about the calendar, so the clip
 *      has to arrive there and not stop at the confirmation sentence.
 *
 * NO PROVIDER IS NAMED OR SHOWN. The connected calendar is Google's, because
 * it is the only provider with a usable test account — there is none for
 * Apple, and the Microsoft test directory withholds admin consent. The spoken
 * line therefore names no provider, and the one surface that would have shown
 * which one it is (the chip row of connected calendars) is hidden for this
 * scene; see `KALENDER_CHIPS`.
 *
 * WHY NOTHING LEAVES THE HOUSE. The recipient is on `demo.raven.ceo`, which
 * does not exist in DNS at all — no MX, no A, not even an SOA — so no mail
 * addressed there can be delivered anywhere. On top of that, staging's
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
 * The recipient.
 *
 * Two requirements, and they pull in different directions. It has to be
 * PROVABLY undeliverable, and it has to look like an ordinary colleague —
 * the first take used `…@e2e.raven.ceo`, and on the phone that address is set
 * 27 to 58 px tall: the one thing the eye lands on is the word "e2e", which
 * tells the audience it is watching a fixture.
 *
 * `demo.raven.ceo` satisfies both. It is the domain the filmed account itself
 * lives on, so a second name there reads as a colleague rather than a test
 * rig; and it does not exist in DNS at all — no MX, no A, not even an SOA
 * (checked 2026-09-19) — so nothing addressed to it can be delivered
 * anywhere. Staging's own sink is the second, independent guarantee (see the
 * module comment).
 *
 * Do NOT put a customer, a colleague or any reachable address here.
 */
const EMPFAENGER = 'jana.reuter@demo.raven.ceo'

/** The meeting whose summary is mailed. Its title carries these words. */
const MEETING_WORT = 'Abnahme Linie 3'

const FRAGE_MAIL = `Schick die Zusammenfassung von "${MEETING_WORT}" an ${EMPFAENGER}`

/**
 * "morgen" and not a weekday.
 *
 * A weekday is resolved by the server's clock, the card prints the absolute
 * date it landed on, and the two disagreed on film: "am Montag" came back as
 * "Di., 22. September". A relative day the viewer cannot check against a
 * calendar in their head cannot contradict itself.
 */
const TERMIN_TITEL = 'Nachkontrolle Absaugung'

const FRAGE_TERMIN = `Leg mir morgen um 10 Uhr einen Termin "${TERMIN_TITEL}" an`

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
 * The way to Raven's own calendar, and what stands there afterwards.
 *
 * The spoken line of this scene is "Der Termin steht — in dem Kalender, den
 * du mitbringst", so the STANDING appointment has to be on screen; the
 * confirmation sentence in the chat is the way there, not the arrival.
 *
 * `visible=true` on the tab is not decoration. The shell renders BOTH
 * navigations into the document — the desktop row and the phone's bottom tab
 * bar — and hides one of them in CSS. Without the filter the locator is
 * ambiguous, and an ambiguous locator has no geometry for the recorder to
 * point at, on either device.
 *
 * The `s` suffix on "Tag" for the neighbouring reason: the header also carries
 * "Tag zurück" and "Tag vor", and a role name matches as a substring by
 * default, so the plain name would have matched three buttons. It is `"Tag"s`
 * and not `[exact=true]` — the role engine accepts exactly nine attributes and
 * rejects anything else outright, so the readable-looking spelling ends the
 * take with an "Unknown attribute" from inside the page (measured, 2026-09-20).
 */
const TERMINE_TAB = 'a[href="/calendar"] >> visible=true >> nth=0'
const TERMINE_UEBERSCHRIFT = 'h1:has-text("Meine Termine")'
const TAG_ANSICHT = 'role=button[name="Tag"s]'
const EIN_TAG_VOR = 'role=button[name="Tag vor"s]'
const STEHENDER_TERMIN = `[data-testid="calendar-event"]:has-text("${TERMIN_TITEL}") >> nth=0`

/**
 * The calendar chip row, hidden for this scene only.
 *
 * Each chip carries a connected calendar's display name, and a Google primary
 * calendar's display name IS the account's mail address — so the row would put
 * the address of a shared test account into every frame of the last act. It is
 * also the one place on the page where the provider becomes visible at all,
 * and the spoken line deliberately names no provider (there is no Apple test
 * account and no directory consent for Microsoft, so naming one on film would
 * make the line a lie about what was shown).
 */
const KALENDER_CHIPS = '[data-testid="calendar-switcher"]'

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

/**
 * Film act one only — the mail Raven writes and the human releases.
 *
 * Default OFF since 2026-09-20: flow.raven#7466 is fixed and live on staging,
 * so a second turn survives a recording again and the whole scene is filmable.
 * The switch used to be the other way round (`RAVEN_M2_MIT_TERMIN=1` turned
 * the appointment ON) while that defect was open; keeping a flag whose stated
 * reason has expired is how a take quietly films less than it should, so the
 * default follows the product and the name follows the default.
 *
 * Set `RAVEN_M2_OHNE_TERMIN=1` to film the mail alone — the only case that
 * still needs it is a reshoot of the delivered act-one clip.
 */
const OHNE_TERMIN = process.env.RAVEN_M2_OHNE_TERMIN === '1'

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = [...RAVEN_HIDE_SELECTORS, KALENDER_CHIPS]
export const locale = RAVEN_LOCALE
// The scene asks for an appointment at "10 Uhr" and then films the calendar it
// landed in. On the container's own clock that calendar prints 08:00, and the
// last shot of the scene would contradict the sentence that produced it.
export const timezone = RAVEN_TIMEZONE

// NO `fixedTime` HERE — this scene sends TWO turns, and the second one dies
// under a pinned clock.
//
// `pinClockAndRandomness` (`src/recipes.ts`) does two things together: it
// starts `Date` at a fixed instant AND replaces `Math.random` with a seeded
// generator. Raven mints an assistant message id from exactly those two
// (`ui/src/app/assistant/assistant-page-client.tsx`, `a-${Date.now()}-${…
// Math.random…}`), so under a recording the second turn of a conversation can
// mint the id the first one already used, and it fails with "Antwort
// fehlgeschlagen".
//
// Measured, one variable at a time, on the recording host: mail turn then
// appointment turn passes twice in a plain browser; the identical pair with
// ONLY the recorder's seeded `Math.random` installed fails on the second turn,
// every time. Three takes had died there before the A/B was run, and the first
// two guesses — a thread limit, then a calendar conflict — were both wrong.
//
// Raven's id should not depend on either (flow.raven#7466). Until it does not,
// a scene with more than one turn cannot pin the clock. Nothing is lost here:
// the shot never leaves the chat, and no relative time is on screen.
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
  //
  // This act was unfilmable until 2026-09-20. The appointment is the SECOND
  // agent turn of the conversation, and a recording pins the clock and seeds
  // the generator Raven minted its message ids from, so from the second turn
  // on every id was the one the first turn already used, React collapsed two
  // messages onto one node and the turn died with "Antwort fehlgeschlagen".
  // Three takes died there. flow.raven#7466 moved the id to
  // `crypto.randomUUID()`, which hangs on neither source.
  if (OHNE_TERMIN) {
    await demo.hold(2500)
    return
  }

  await demo.hold(VOR_KLICK_MS)
  await demo.type(EINGABE, FRAGE_TERMIN)
  await ruhigKlicken(demo, KOMPOSER_SENDEN)
  await demo.point(EINGABE)

  // If the gate never comes, the message has to carry Raven's own last words.
  // "The card did not appear" fits a refused permission, a meeting that was
  // not found, a calendar that is not connected and a turn that simply failed
  // — and the frames of a refused take are deleted, so this is the only
  // witness there will be.
  try {
    await warteAuf(page, TERMIN_KARTE, KARTEN_FRIST_MS)
  } catch (fehler) {
    throw new Error(
      `${fehler instanceof Error ? fehler.message : String(fehler)} — Raven ` +
        `last said: ${await letzteAntwort(page)}`,
    )
  }
  await inDieMitte(page, demo, TERMIN_KARTE, { tempo: FILM_SCROLL_TEMPO })
  await demo.point(TERMIN_KARTE)
  await demo.hold(LESEZEIT_MS)

  await ruhigKlicken(demo, TERMIN_JA)
  // The gate disappears when the write has run; what follows it is Raven's
  // confirmation. Waiting for the card to be gone is the honest signal that
  // the write happened — waiting for a phrase would pin the model's wording.
  await warteAufVerschwunden(page, TERMIN_KARTE, 90_000)
  await demo.hold(2500)

  // ── Act three: the appointment, standing ─────────────────────────────────
  //
  // The scene's line is about the calendar, not about the chat, so it ends in
  // the calendar. Day view on purpose: the week grid puts one appointment in a
  // 7-column field where it is a coloured sliver, and the phone does not render
  // the week at all. Day view is the same shot on both devices — and because
  // the request said "morgen", one step forward is the whole navigation.
  await ruhigKlicken(demo, TERMINE_TAB)
  await warteAuf(page, TERMINE_UEBERSCHRIFT, 30_000)
  await demo.hold(1200)

  await ruhigKlicken(demo, TAG_ANSICHT)
  await demo.hold(800)
  await ruhigKlicken(demo, EIN_TAG_VOR)

  // If it is not there, the take has to say so rather than film an empty day:
  // a calendar that answers slowly and one that never received the write look
  // identical for the first few seconds.
  try {
    await warteAuf(page, STEHENDER_TERMIN, 60_000)
  } catch (fehler) {
    throw new Error(
      `${fehler instanceof Error ? fehler.message : String(fehler)} — the ` +
        `appointment "${TERMIN_TITEL}" was confirmed in the chat but does ` +
        'not stand in the calendar on the following day. Either the write ' +
        'went to a different calendar than the one that is read back, or it ' +
        'landed on a different day than the one this scene steps to.',
    )
  }
  await inDieMitte(page, demo, STEHENDER_TERMIN, { tempo: FILM_SCROLL_TEMPO })
  await demo.point(STEHENDER_TERMIN)
  await demo.hold(5000)
}
