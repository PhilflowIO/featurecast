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
 * WHY THIS QUESTION AND NOT ANOTHER. Raven resolves a person reference with a
 * topic through `query_past_meeting_subgraph`
 * (`api/app/services/agent_intents/query_past_meeting_subgraph.py` in
 * `flow.raven`): the person narrows the candidates, the topic ranks them
 * through the full-text index, and at most three conversations are read
 * (`_person_content.MAX_MEETINGS`). More carriers than that and the graph
 * INTERRUPTS with "welches Gespräch?" — a clarification gate, which is a fine
 * product behaviour and a dead scene.
 *
 * Petra Wüstenhagen and Hirtenscheibe Guss carry exactly three conversations
 * in the demo workspace, and they tell a story on their own: a quality problem
 * (29.05.2026, Lunker in der Gehäuseserie), the argument about who pays for
 * the consequence (10.07.2026, Werkzeugkosten), and the decision that follows
 * from both (28.08.2026, eine zweite Gussquelle). Three staging runs on
 * 2026-09-19 gave the same three dates in the same order every time, with no
 * gate and no second synthesis pass.
 *
 * The take is ABORTED rather than filmed when the answer does not carry all
 * three dates — an answer off one conversation is not this scene, and an
 * answer that quietly dropped the oldest one is the opposite of it.
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
  'Was habe ich mit Petra Wüstenhagen zum Thema Hirtenscheibe Guss besprochen?'

/**
 * The three conversations the answer has to name. Dates and not titles: the
 * model phrases the titles freely ("Lunker in der Gehäuseserie von
 * Hirtenscheibe Guss" against the row's own "Hirtenscheibe Guss — Lunker in
 * der Gehäuseserie"), but the date is code-supplied
 * (`%d.%m.%Y` in `query_past_meeting_subgraph.py`) and is therefore the one
 * thing that is stable enough to gate a take on.
 */
const GESPRAECHE = ['29.05.2026', '10.07.2026', '28.08.2026']

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
