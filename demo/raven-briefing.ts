import type { Demo, RecordPage } from '../src/record.js'
import {
  EINGABE,
  FEHLSCHLAG,
  FILM_SCROLL_TEMPO,
  RAVEN_ALLOW_FRAMING,
  RAVEN_HIDE_SELECTORS,
  RAVEN_LOCALE,
  RAVEN_STATE,
  RAVEN_TIMEZONE,
  RAVEN_URL,
  VOR_KLICK_MS,
  antwort,
  inDieMitte,
  jetztSichtbar,
  letzteAntwort,
  ruhigKlicken,
  vorbereiten,
  warteAuf,
  warteAufVerschwunden,
} from './raven-common.js'

/**
 * Product film, scene "Briefing": Raven prepares the user for tomorrow's
 * conversation, and in the same take the preparation becomes an appointment.
 *
 * Three acts:
 *
 *   1. "Bereite mich auf das Gespräch mit Sven Kowalczyk vor." Raven finds the
 *      next appointment with him (the Quartalsgespräch on the 23rd, 10:00),
 *      reads every earlier meeting he was in and writes a briefing: earlier
 *      topics, promises and open points, suggestions. The close-up line of the
 *      film is HIS OWN promise from the last meeting — the Brennkmann quote he
 *      said he would get. It is what a person walking into that conversation
 *      would otherwise have forgotten, which is the whole point of a briefing.
 *   2. "Leg mir morgen um 9 Uhr einen Termin "Vorbereitung Sven" an." The
 *      appointment gate, the same card and the same yes as scene M2.
 *   3. The calendar on the 23rd: the new "Vorbereitung Sven" at 09:00, the
 *      conversation it prepares right below it at 10:00. The last shot shows
 *      the two belong together without a word being said about it.
 *
 * THE ANSWER IS THE MODEL'S, NOT OURS. The briefing is written by a routed
 * subgraph (`prepare_briefing` in flow.raven) on every take. Its structure has
 * been stable in every run read (heading, "Bisherige Themen", "Zusagen und
 * offene Punkte", "Vorschläge", "Termin:", "Gelesen:"), its wording is not. So
 * the close-up line is found by what it is — a leaf bullet mentioning
 * Brennkmann under the bullet that names Sven Kowalczyk — and not by a
 * sentence. See `NAHAUFNAHME`.
 *
 * THE SUMMARY IT QUOTES HAS TO BE RIGHT FIRST. The briefing reads the meeting
 * summaries and repeats their dates. The Steinkauz summary carried "bis
 * Freitag (22.09.2026)" while that Friday is the 25th; a film that shows a
 * wrong date in its close-up is worse than no close-up. flow.raven#7705 fixes
 * the date resolution; only a summary regenerated after it may be filmed.
 * Check before the final take that the meeting's summary no longer contains
 * `22.09.2026`.
 *
 * NO `fixedTime`, for the reason written out at length in
 * `raven-auf-zuruf.ts`: a pinned clock seeds `Math.random`, and a second turn
 * in the same thread then collides with the first. It also matters for the
 * content here: "morgen" and the next appointment with Sven are resolved on the
 * server's real clock, and a browser on a different day would print a calendar
 * that contradicts both.
 *
 * NO PROVIDER IS NAMED OR SHOWN; the calendar chip row that would show the
 * Google test account's address is hidden (see `KALENDER_CHIPS`).
 *
 * AFTER A TAKE. Each device leaves one assistant thread and one calendar event
 * "Vorbereitung Sven" behind. Delete the event before the next take — a
 * leftover at 09:00 makes the next card report a conflict and move the slot —
 * via `DELETE /api/calendar/events/<id>?provider=google&calendar_id=<cal>`,
 * and the thread via `DELETE /api/chat/threads/<id>`.
 *
 * INVOCATION (GPU host)::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-briefing.ts --devices desktop-wide,iphone
 *
 * RENDER (the two the film consumes)::
 *
 *     pnpm render artifacts/raven-briefing/desktop-wide \
 *         artifacts/raven-briefing/desktop-wide-flat-ohne-zeiger \
 *         --formats 2560x1600 --zoom 1 --idle-threshold 600000 --no-cursor
 *     pnpm render artifacts/raven-briefing/iphone \
 *         artifacts/raven-briefing/iphone-flat-ohne-zeiger \
 *         --formats 9:16 --zoom 1 --idle-threshold 600000 --no-cursor
 */

/**
 * The person the briefing is about. A contact of the demo account on
 * `demo.raven.ceo`, a domain that does not exist in DNS; he has a real
 * appointment on the 23rd and a promise in the Steinkauz round of the 18th.
 */
const PERSON = 'Sven Kowalczyk'

const FRAGE_BRIEFING = `Bereite mich auf das Gespräch mit ${PERSON} vor.`

/**
 * "morgen" and not a weekday or a date — the same reason as in scene M2: the
 * card prints the absolute date, and a relative day cannot contradict it.
 * 09:00 and not later: the conversation it prepares is at 10:00, so the two
 * stand one above the other in the day view.
 */
const TERMIN_TITEL = 'Vorbereitung Sven'

const FRAGE_TERMIN = `Leg mir morgen um 9 Uhr einen Termin "${TERMIN_TITEL}" an`

/**
 * The composer's send button, the LAST "Senden" on the page. The schedule card
 * has none, but the mail card of other turns does, and `nth=-1` is the
 * spelling that cannot become ambiguous (see `raven-auf-zuruf.ts`).
 */
const KOMPOSER_SENDEN = 'role=button[name="Senden"] >> nth=-1'

/**
 * The close-up line: Sven's promise, inside the briefing.
 *
 * Built from the answer's structure because the words vary between takes:
 *
 * - scoped to the first finished answer, so a thread-sidebar label or the
 *   streaming bubble can never match;
 * - a LEAF bullet (`not(.//li)`), because the Markdown renders the person as
 *   an outer bullet with his promises nested under it, and the outer one
 *   also "contains" Brennkmann — pointing at it would put the pointer on the
 *   name, not on the line;
 * - in the bullet whose bold label names him — its parent (the name as a
 *   label, the promise nested under it, as every briefing read so far had
 *   it) or the bullet itself (`**Sven Kowalczyk:** holt … ein`; one take on
 *   2026-09-22 found no line in the nested form, and this is the other
 *   shape the Markdown can take) — which is what keeps the "Vorschläge"
 *   line ("Nachfragen, ob das Angebot von Brennkmann eingeholt wurde") out:
 *   that one is his topic, not his promise.
 *
 * `strong | p/strong` because a list with blank lines between items renders
 * loose (`li > p > strong`) and a tight one does not (`li > strong`); the
 * model writes either.
 */
const NAHAUFNAHME =
  `${antwort(0)} >> xpath=.//li[contains(., "Brennkmann") and not(.//li) ` +
  `and ancestor-or-self::li[(strong | p/strong)[contains(., "${PERSON}")]]]` +
  ' >> nth=0'

/**
 * The message list, the panel every chat scroll of this scene happens in.
 *
 * Named because on the phone the composer floats over the lower part of it:
 * a swipe that starts on the composer scrolls nothing, and the final take of
 * 2026-09-22 was refused with the card's yes still under the composer. The
 * recorder swipes only on the part of this list a finger can touch.
 */
const NACHRICHTEN = '[data-testid="assistant-messages-scroll"]'

/** The appointment gate: Raven's filled-in card, waiting for a yes. */
const TERMIN_KARTE = '[data-testid="confirm-schedule-card"]'
const TERMIN_JA = '[data-testid="confirm-schedule-yes"]'

/**
 * The way to the calendar and what stands there. Every trap in these four
 * selectors (both navigations in the document, "Tag" matching three buttons,
 * the role engine rejecting `[exact=true]`) is written up in
 * `raven-auf-zuruf.ts`; they are the same selectors on purpose.
 */
const TERMINE_TAB = 'a[href="/calendar"] >> visible=true >> nth=0'
const TERMINE_UEBERSCHRIFT = 'h1:has-text("Meine Termine")'
const TAG_ANSICHT = 'role=button[name="Tag"s]'
const EIN_TAG_VOR = 'role=button[name="Tag vor"s]'
const NEUER_TERMIN = `[data-testid="calendar-event"]:has-text("${TERMIN_TITEL}") >> nth=0`

/**
 * The day view's hour grid, the one part of the calendar page that scrolls.
 * It carries no test id; the class is the one Raven's own stylesheet keys its
 * scrollbar on (`ui/src/app/globals.css`, `.raven-calendar-scroll`), so it is
 * as stable as the look of that scrollbar.
 */
const STUNDEN_RASTER = '.raven-calendar-scroll >> nth=0'

/**
 * The calendar chip row, hidden: a Google primary calendar's display name is
 * the account's mail address (see `raven-auf-zuruf.ts`).
 */
const KALENDER_CHIPS = '[data-testid="calendar-switcher"]'

/**
 * The target-calendar row of the schedule card, hidden for the same reason as
 * the chips: its picker is preselected to the Google primary calendar, whose
 * display name is the test account's mail address — read off the phone
 * rehearsal on 2026-09-22 in 16 px type. The row goes as a whole (`:has`), so
 * the card closes up instead of showing a lone calendar icon.
 */
const KARTEN_KALENDER = 'div:has(> [data-testid="confirm-schedule-calendar"])'

/**
 * How long the briefing may take. It was ~25 s when measured through the API
 * on 2026-09-22, but it reads five meetings before it writes a word, and a
 * busy model endpoint doubles that easily.
 */
const BRIEFING_FRIST_MS = 120_000

/** The schedule turn resolves a calendar before the card comes. */
const KARTEN_FRIST_MS = 120_000

/** Reading time on the close-up line and on the card. */
const LESEZEIT_MS = 4000

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = [
  ...RAVEN_HIDE_SELECTORS,
  KALENDER_CHIPS,
  KARTEN_KALENDER,
]
export const locale = RAVEN_LOCALE
// "um 9 Uhr" has to read 09:00 in the last shot, not the container's UTC 07:00.
export const timezone = RAVEN_TIMEZONE
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

/** The empty assistant, loaded before the camera rolls. */
export const prepare = vorbereiten('/assistant', EINGABE)

export default async function briefing(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await demo.hold(1200)

  // ── Act one: the briefing ────────────────────────────────────────────────
  await demo.hold(VOR_KLICK_MS)
  await demo.type(EINGABE, FRAGE_BRIEFING)
  await ruhigKlicken(demo, KOMPOSER_SENDEN)
  // Out of the answer's way while it streams: a pointer resting in the
  // message list covers the words the viewer is reading.
  await demo.point(EINGABE)

  // The SETTLED answer, not the streaming bubble. The close-up has to be
  // placed on a node that no longer grows: scrolled to while tokens still
  // arrive, the line is pushed up by every paragraph written below it and
  // the pointer ends up on "Offene Punkte".
  await warteAufBriefing(page)
  await demo.hold(1500)

  // If the answer came but the line is not in it, the take has to say what
  // Raven wrote instead: a briefing without Sven's promise is a different
  // film, and the frames of a refused take are deleted.
  try {
    await warteAuf(page, NAHAUFNAHME, 5000)
  } catch (fehler) {
    throw new Error(
      `${fehler instanceof Error ? fehler.message : String(fehler)} — the ` +
        `briefing has no promise of ${PERSON} about Brennkmann. Raven last ` +
        `said: ${await letzteAntwort(page)}`,
    )
  }
  // Calmly, at the film's pace: the scroll passes the earlier topics on the
  // way, and that pass is itself the proof that Raven read five meetings.
  await inDieMitte(page, demo, NAHAUFNAHME, {
    innerhalb: NACHRICHTEN,
    tempo: FILM_SCROLL_TEMPO,
  })
  await demo.point(NAHAUFNAHME)
  await demo.hold(LESEZEIT_MS)

  // ── Act two: the appointment, gated ──────────────────────────────────────
  await demo.hold(VOR_KLICK_MS)
  await demo.type(EINGABE, FRAGE_TERMIN)
  await ruhigKlicken(demo, KOMPOSER_SENDEN)
  await demo.point(EINGABE)

  try {
    await warteAuf(page, TERMIN_KARTE, KARTEN_FRIST_MS)
  } catch (fehler) {
    throw new Error(
      `${fehler instanceof Error ? fehler.message : String(fehler)} — Raven ` +
        `last said: ${await letzteAntwort(page)}`,
    )
  }
  await inDieMitte(page, demo, TERMIN_KARTE, {
    innerhalb: NACHRICHTEN,
    tempo: FILM_SCROLL_TEMPO,
  })
  await demo.point(TERMIN_KARTE)
  await demo.hold(LESEZEIT_MS)

  // The button, not the card, has to be free before the click. On the phone
  // the card is taller than the space above the composer, so a card centred
  // at 45 % can leave its yes under the composer — two takes of 2026-09-22
  // were refused there, "occluded", with the composer's textarea on top. On
  // the desktop the button is already inside the mark and nothing moves.
  await inDieMitte(page, demo, TERMIN_JA, {
    innerhalb: NACHRICHTEN,
    tempo: FILM_SCROLL_TEMPO,
  })
  try {
    await ruhigKlicken(demo, TERMIN_JA)
  } catch (fehler) {
    // "Occluded" says THAT something covers the button, not WHAT — and the
    // frames of a refused take are deleted, so the page is asked here, while
    // the cover is still on it.
    throw new Error(
      `${fehler instanceof Error ? fehler.message : String(fehler)} — on ` +
        `top of its centre: ${await wasLiegtAuf(page, TERMIN_JA)}`,
    )
  }
  // The card going away is the honest signal that the write ran; a phrase
  // would pin the model's wording.
  await warteAufVerschwunden(page, TERMIN_KARTE, 90_000)
  await demo.hold(2500)

  // ── Act three: the appointment, standing above the conversation ──────────
  await ruhigKlicken(demo, TERMINE_TAB)
  await warteAuf(page, TERMINE_UEBERSCHRIFT, 30_000)
  await demo.hold(1200)

  await ruhigKlicken(demo, TAG_ANSICHT)
  await demo.hold(800)
  await ruhigKlicken(demo, EIN_TAG_VOR)

  try {
    await warteAuf(page, NEUER_TERMIN, 60_000)
  } catch (fehler) {
    throw new Error(
      `${fehler instanceof Error ? fehler.message : String(fehler)} — ` +
        `"${TERMIN_TITEL}" was confirmed in the chat but does not stand in ` +
        'the calendar on the following day.',
    )
  }
  // Scrolled INSIDE the hour grid, not on the page. The day view opens its
  // grid on the current hour, so on an afternoon take 09:00 stands above the
  // grid's visible part, under the week strip — the recorder refused to point
  // at it there ("occluded", covered by `week-strip-day`, 2026-09-22). The
  // page itself does not scroll; only the grid does, and on the phone it
  // fills only the lower half of the screen, where a centred swipe never
  // lands. Half-way down the grid, 09:00 stands with the 10:00 conversation
  // directly below it — the pair is the shot.
  await inDieMitte(page, demo, NEUER_TERMIN, {
    anteil: 0.5,
    innerhalb: STUNDEN_RASTER,
    tempo: FILM_SCROLL_TEMPO,
  })
  try {
    await demo.point(NEUER_TERMIN)
  } catch (fehler) {
    throw new Error(
      `${fehler instanceof Error ? fehler.message : String(fehler)} — on ` +
        'top of its centre: ' +
        `${await wasLiegtAuf(page, '[data-testid="calendar-event"]', TERMIN_TITEL)}`,
    )
  }
  await demo.hold(5000)
}

/**
 * `warteAufAntwort` with the briefing's longer deadline.
 *
 * Not the shared function: its 90 s are a constant, and a turn that reads
 * five meetings before writing may take longer on a busy endpoint without
 * anything being wrong. A failed turn still ends the take at once — waiting
 * does not turn "Antwort fehlgeschlagen" into a briefing.
 */
async function warteAufBriefing(page: RecordPage): Promise<void> {
  const ende = Date.now() + BRIEFING_FRIST_MS
  for (;;) {
    if (await jetztSichtbar(page, `${FEHLSCHLAG} >> nth=0`)) {
      throw new Error(
        `The briefing turn failed. Raven last said: ${await letzteAntwort(page)}`,
      )
    }
    if (await jetztSichtbar(page, antwort(0))) return
    if (Date.now() > ende) {
      throw new Error(
        `No briefing within ${String(BRIEFING_FRIST_MS)} ms: ${antwort(0)}`,
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}

/**
 * What paints at the centre of the first `css` node whose text contains
 * `text`, for a failure message: "occluded" says THAT something covers a
 * target, not WHAT, and the frames of a refused take are deleted.
 *
 * Built with `new Function` because `RecordPage.evaluate` takes no
 * arguments and ships only the function's own source into the page; the two
 * strings are baked into that source as JSON literals.
 */
async function wasLiegtAuf(
  page: RecordPage,
  css: string,
  text = '',
): Promise<string> {
  const imSeitenkontext = new Function(`
    const ziel = Array.from(document.querySelectorAll(${JSON.stringify(css)}))
      .find((knoten) => (knoten.textContent || '').includes(${JSON.stringify(text)}))
    if (!ziel) return '(the target is gone)'
    const box = ziel.getBoundingClientRect()
    const oben = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    const lage = JSON.stringify({ x: box.x, y: box.y, w: box.width, h: box.height, vh: innerHeight })
    if (!oben) return '(nothing) ' + lage
    if (oben === ziel || ziel.contains(oben)) return '(the target itself) ' + lage
    return oben.outerHTML.slice(0, 240) + ' ' + lage
  `) as () => string
  try {
    return await page.evaluate(imSeitenkontext)
  } catch {
    return '(the page would not answer)'
  }
}
