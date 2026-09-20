import type { Frame } from 'playwright'

import type { Demo, RecordPage } from '../src/record.js'
import {
  ANTWORT_OHNE_NUMMER,
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

/**
 * How long the answer's FIRST lines stand before the camera travels to the
 * three dated conversations. Enough to read into it, not a standstill.
 */
const ANLESEN_MS = 2500

/**
 * The scene's load-bearing window: the three dated conversations together and
 * motionless in frame. A whole spoken line of the film rests on it, so it is
 * the one hold in this script that is a requirement and not a taste.
 *
 * Six seconds and not five: the delivery is cut from this, and a cut that has
 * to land exactly on both edges of its only usable window has no room to
 * breathe.
 */
const LESEFENSTER_MS = 6000

/**
 * The tail. Deliberately short — the previous take ended on 15.9 s (desktop)
 * and 18.2 s (phone) of one still frame, which is footage the cut has to throw
 * away by hand.
 */
const AUSKLANG_MS = 2500

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
  // so the clip shows the reading begin.
  await anfangZeigen(page, demo, antwort(0))
  await demo.hold(ANLESEN_MS)

  // Then place the three dated conversations in the middle and STOP there.
  // This is the shot the film's spoken line is written against, so the take
  // reports whether it really got it instead of leaving it to be discovered in
  // the edit — the previous take held it for 1.3 s and nobody knew until then.
  await fensterZeigen(page, demo)
  const fenster = await datumsFenster(page)
  console.log(`M1-LESEFENSTER ${JSON.stringify(fenster)}`)
  await demo.hold(LESEFENSTER_MS)

  // Only then down through whatever is still below — the block naming the
  // conversations it did not read. A travel shorter than 60 px is skipped so
  // the clip does not twitch for show.
  const rest = await restHoehe(page, antwort(0))
  if (rest > 60) {
    await demo.scroll(0, rest, { speedPxPerSecond: FILM_SCROLL_TEMPO })
  }
  await demo.hold(AUSKLANG_MS)
}

/**
 * Where the three dated conversations stand right now, and whether they stand
 * there TOGETHER.
 *
 * Measured per date and not on the answer node as a whole: the answer also
 * carries the block naming the conversations it did not read, and that block
 * may hang below the lower edge without costing this scene anything. What may
 * not hang below the edge is one of the three.
 */
async function datumsFenster(page: RecordPage): Promise<{
  alleImBild: boolean
  hoehe: number
  imBild: number
  oben: number
  unten: number
  viewport: number
}> {
  const viewport = page.viewportSize()?.height ?? 0
  let oben = Number.POSITIVE_INFINITY
  let unten = Number.NEGATIVE_INFINITY
  let imBild = 0
  for (const datum of GESPRAECHE) {
    const box = await page
      .locator(`${ANTWORT_OHNE_NUMMER} >> text=${datum} >> nth=0`)
      .boundingBox()
    if (box === null) continue
    oben = Math.min(oben, box.y)
    unten = Math.max(unten, box.y + box.height)
    if (box.y >= 0 && box.y + box.height <= viewport) imBild += 1
  }
  if (!Number.isFinite(oben)) {
    return {
      alleImBild: false,
      hoehe: 0,
      imBild: 0,
      oben: 0,
      unten: 0,
      viewport,
    }
  }
  return {
    alleImBild: imBild === GESPRAECHE.length,
    hoehe: Math.round(unten - oben),
    imBild,
    oben: Math.round(oben),
    unten: Math.round(unten),
    viewport,
  }
}

/**
 * Scrolls so the three dates sit in the middle of the frame.
 *
 * If they are taller than the frame there is nothing to centre and the scroll
 * is skipped: moving would only trade one date off the top for another off the
 * bottom. `datumsFenster` then reports `alleImBild: false`, which is the
 * honest answer — the layout does not give this shot on that device.
 */
async function fensterZeigen(page: RecordPage, demo: Demo): Promise<void> {
  const vorher = await datumsFenster(page)
  if (vorher.viewport === 0 || vorher.hoehe === 0) return
  if (vorher.hoehe > vorher.viewport * 0.9) return
  const abstand = Math.round(
    vorher.oben + vorher.hoehe / 2 - vorher.viewport * 0.5,
  )
  if (Math.abs(abstand) <= 60) return
  await demo.scroll(0, abstand, { speedPxPerSecond: FILM_SCROLL_TEMPO })
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
