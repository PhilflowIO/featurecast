import type { Frame } from 'playwright'

import type { Demo, RecordPage } from '../src/record.js'
import {
  EINGABE,
  FILM_SCROLL_TEMPO,
  RAVEN_ALLOW_FRAMING,
  RAVEN_HIDE_SELECTORS,
  RAVEN_LOCALE,
  RAVEN_STATE,
  RAVEN_URL,
  SENDEN,
  STEINKAUZ_FIXED_TIME,
  VOR_KLICK_MS,
  antwort,
  vorbereiten,
  warteAufAntwort,
} from './raven-common.js'

/**
 * Product film, scene M1 "Erinnert sich an alles" — the scene the re-cut film
 * is built around.
 *
 * The general assistant, NOT the chat pinned to one meeting: the viewer stands
 * in front of the whole archive and asks about one person and one subject
 * ("Was habe ich mit <Person> zum Thema <X> besprochen?"). The answer is drawn
 * from several conversations, months apart, and says which ones — with their
 * dates. That is the whole point of the scene: not that a machine answers, but
 * that it shows its reading.
 *
 * WHY THIS QUESTION AND NOT ANOTHER. The subject has to be a word the people
 * in the room actually SAID, not a label somebody put on the folder. Raven
 * ranks a person's conversations by the topic through the full-text index over
 * the transcripts (`_topic_query` / `query_past_meeting_subgraph.py` in
 * `flow.raven`); a subject that appears in no transcript still produces an
 * answer, but the graph appends a line saying so and falls back to the
 * summaries. That line is honest and it is the opposite of this scene, which is
 * about Raven carrying an answer out of the conversations themselves.
 *
 * "Salmweide" is spoken aloud in thirteen of the demo workspace's
 * transcripts — it is a customer, and customers get named. Narrowed to Tobias
 * Reinhardt it is seven, of which the graph reads the three best (28.07.2026
 * Rückfragen und Reklamationen, 11.08.2026 der Zuschlag über rund 242.000 Euro,
 * 08.09.2026 die verlorene dritte Position) and NAMES the four it did not read,
 * with their dates. Three staging runs on 2026-09-19 returned the same three
 * conversations and the same four it left, every time.
 *
 * Two candidates were tried and dropped. "Hirtenscheibe Guss" is a company
 * nobody says out loud — the people in those rooms address it as "Sie" — so
 * every answer closed on the summaries-only line. "Rüstzeit" is said in eight
 * transcripts but in exactly one segment each, so nothing ranks above anything
 * else and the graph does the right thing and asks WHICH conversation; the
 * take came back with no answer at all.
 *
 * The take is ABORTED rather than filmed on two counts: when the answer does
 * not carry all three dates, and when it carries the summaries-only line. The
 * first guards against an answer off one conversation; the second against the
 * whole premise of the scene quietly failing while the screen still looks
 * busy.
 *
 * Each take leaves one assistant thread in the demo account; delete it after
 * (`GET /api/chat/threads`, `DELETE /api/chat/threads/<id>` in a signed-in
 * context).
 *
 * INVOCATION (GPU host)::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-erinnert-sich.ts --devices desktop-wide,iphone
 */

const FRAGE =
  'Was habe ich mit Tobias Reinhardt zum Thema Salmweide besprochen?'

/**
 * The three conversations the answer has to name. Dates and not titles: the
 * model phrases a title freely ("In der Vertriebsrunde — KW 31" against the
 * row's own "Vertriebsrunde — KW 31"), but the date is code-supplied
 * (`%d.%m.%Y` in `query_past_meeting_subgraph.py`) and is therefore the one
 * thing stable enough to gate a take on.
 */
const GESPRAECHE = ['28.07.2026', '11.08.2026', '08.09.2026']

/**
 * The line the graph appends when the subject appears in no transcript and the
 * answer therefore rests on summaries. Its presence means the scene failed
 * even though the screen is full of text, so it ends the take.
 */
const NUR_ZUSAMMENFASSUNGEN = 'In keinem Transkript'

/** The hero of the empty assistant: the first frame of the clip. */
const HERO = 'h1:has-text("Was möchtest du wissen?")'

/** Reading time once the whole answer stands. */
const LESEZEIT_MS = 7000

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const fixedTime = STEINKAUZ_FIXED_TIME
export const locale = RAVEN_LOCALE
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

/**
 * The assistant, empty and loaded, with the chat history put away.
 *
 * The hero and not the composer is the readiness signal: the composer is in
 * the document while the page still measures itself, the heading is there once
 * the empty state has decided it IS the empty state.
 *
 * WHY THE HISTORY PANEL GOES AWAY. Above `xl` the assistant opens with a
 * persistent Chatverlauf column, and it lists whatever conversations the demo
 * account happens to hold — in the first take two rows reading "Unbenannte
 * Unterhaltung", left by another run against the same shared account earlier
 * that hour. That is somebody else's leftover standing in a product film. It
 * is put away rather than deleted: deleting threads on a shared demo account
 * can take a conversation a parallel run is in the middle of, and the panel
 * carries nothing this scene is about. Below `xl` it is a drawer that is shut
 * anyway, so the click is skipped there.
 */
export const prepare = async (app: Frame): Promise<void> => {
  await vorbereiten('/assistant', HERO)(app)
  const einklappen = app.locator('[aria-label="Chatverlauf ausblenden"]')
  if ((await einklappen.count()) > 0 && (await einklappen.isVisible())) {
    await einklappen.click()
    await einklappen.waitFor({ state: 'hidden', timeout: 10_000 })
  }
}

export default async function erinnertSich(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await demo.hold(1200)

  await demo.point(EINGABE)
  await demo.hold(VOR_KLICK_MS)
  await demo.type(EINGABE, FRAGE)
  await demo.hold(VOR_KLICK_MS)
  await demo.point(SENDEN)
  await demo.hold(VOR_KLICK_MS)
  await demo.click(SENDEN)

  // Out of the answer's way while it streams. The composer keeps its place at
  // the bottom of the shell, so the pointer resting there covers nothing.
  await demo.point(EINGABE)
  await warteAufAntwort(page, 0)
  await demo.hold(2000)

  const text = await antwortText(page)
  const fehlend = GESPRAECHE.filter((datum) => !text.includes(datum))
  if (fehlend.length > 0) {
    throw new Error(
      `The answer does not name all three conversations — missing: ` +
        `${fehlend.join(', ')}. This scene is about an answer that reads ` +
        `several conversations and says which; one that read fewer is a ` +
        `different scene. Run the take again.`,
    )
  }
  if (text.includes(NUR_ZUSAMMENFASSUNGEN)) {
    throw new Error(
      'The answer rests on the summaries: the subject appears in none of the ' +
        'transcripts. The scene is about Raven carrying an answer out of the ' +
        'conversations themselves, so this take is not it.',
    )
  }

  // The answer arrived stuck to its own bottom edge. Bring its FIRST line up
  // so the clip shows the reading begin, then travel down through it at the
  // film's pace.
  await anfangZeigen(page, demo, antwort(0))
  await demo.hold(LESEZEIT_MS)
  await demo.scroll(0, await restHoehe(page, antwort(0)), {
    speedPxPerSecond: FILM_SCROLL_TEMPO,
  })
  await demo.hold(LESEZEIT_MS)
}

/** The answer as text, for the gate above. */
async function antwortText(page: RecordPage): Promise<string> {
  return page.evaluate<string>(() => {
    const knoten = document.querySelector('[data-testid="assistant-message"]')
    return knoten?.textContent ?? ''
  })
}

/**
 * Scrolls so that the TOP of `selector` stands at a fifth of the viewport.
 *
 * Not `inDieMitte`: that places the CENTRE of the target, and the centre of a
 * three-paragraph answer is its second paragraph — the clip would open on the
 * middle of the reading and never show it start. A scroll shorter than 60 px
 * is skipped, so a desktop layout that already shows the whole answer does not
 * twitch for show.
 */
async function anfangZeigen(
  page: RecordPage,
  demo: Demo,
  selector: string,
): Promise<void> {
  const box = await page.locator(selector).boundingBox()
  const hoehe = page.viewportSize()?.height
  if (box === null || hoehe === undefined) return
  const abstand = Math.round(box.y - hoehe * 0.2)
  if (Math.abs(abstand) <= 60) return
  await demo.scroll(0, abstand, { speedPxPerSecond: FILM_SCROLL_TEMPO })
}

/**
 * How far the answer still reaches below the lower edge, so the travel down
 * ends exactly at its last line instead of scrolling into empty page.
 */
async function restHoehe(page: RecordPage, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox()
  const hoehe = page.viewportSize()?.height
  if (box === null || hoehe === undefined) return 0
  return Math.max(0, Math.round(box.y + box.height - hoehe * 0.9))
}
