import type { Demo, RecordPage } from '../src/record.js'
import {
  BESPRECHEN,
  EINGABE,
  FILM_SCROLL_TEMPO,
  KONTEXT_CHIP,
  RAVEN_ALLOW_FRAMING,
  RAVEN_HIDE_SELECTORS,
  RAVEN_LOCALE,
  RAVEN_STATE,
  RAVEN_URL,
  SENDEN,
  STEINKAUZ_FIXED_TIME,
  STEINKAUZ_ID,
  STEINKAUZ_TITEL,
  VOR_KLICK_MS,
  antwort,
  inDieMitte,
  jetztSichtbar,
  ruhigKlicken,
  vorbereiten,
  warteAuf,
  warteAufAntwort,
} from './raven-common.js'

/**
 * Product film, scene S4 "Chat-Zeitmarke": on the Steinkauz status round the
 * viewer opens "Mit Raven besprechen", asks when the series start was decided,
 * and clicks the time mark in the answer. The meeting opens on the cited
 * sentence, highlighted and in view, and the recording plays from it.
 *
 * Needs flow.raven#7395 (PR 7399) on staging. Before it, the mark `[01:26]`
 * (`?t=86`) highlighted the sentence before the cited one (86.0 s lies in
 * 83.43–86.55 s, the cited one starts at 86.91 s), the player stayed paused,
 * and on a phone the highlighted row stood below the screen.
 *
 * The question matches the content: the decision "Serienstart auf Linie 3
 * bleibt am 3. November" is Marlene's line at 1:26, and the answer cites it
 * (two marks in the probe, `[01:26]` and `[01:32]`). The script clicks
 * `[01:26]` when the answer carries it, otherwise the answer's first mark, and
 * aborts the take if the answer carries none.
 *
 * Playback in the recording browser: the click on the mark is a real input
 * event, and the citation is a client-side link, so the meeting page inherits
 * the activation and starts the recording itself. A take in which the player
 * does not run, or the highlighted row is not on screen, is aborted rather
 * than filmed.
 *
 * Each take leaves one assistant thread in the demo account; delete it after
 * (`GET /api/chat/threads`, `DELETE /api/chat/threads/<id>` in a signed-in
 * context).
 *
 * INVOCATION (GPU host)::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-chat-zeitmarke.ts --devices desktop-wide,iphone
 */

const FRAGE = 'Wann wurde der Serienstart beschlossen?'

/** The mark of the decision itself. */
const MARKE_SERIENSTART = `${antwort(1)} >> a[href*="?t="]:has-text("[01:26]") >> nth=0`

/** Any mark in the answer, when the model phrased it differently. */
const ERSTE_MARKE = `${antwort(1)} >> a[href*="?t="] >> nth=0`

/** The highlighted transcript row on the meeting page. */
const AKTIVE_ZEILE = '[data-transcript-active="true"]'

/** The sentence `[01:26]` cites, highlighted: Marlene's decision at 86.91 s. */
const SERIENSTART_AKTIV = `${AKTIVE_ZEILE}:has-text("Gut, dann halten wir fest")`

/** The player's control while it plays. */
const PAUSIEREN = 'button[aria-label="Pausieren"] >> nth=0'

/** How long the recording is filmed playing from the cited sentence. */
const WIEDERGABE_MS = 6000

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const fixedTime = STEINKAUZ_FIXED_TIME
export const locale = RAVEN_LOCALE
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

/** The meeting, loaded before the camera rolls, with its chat button. */
export const prepare = vorbereiten(`/meetings/${STEINKAUZ_ID}`, BESPRECHEN)

export default async function chatZeitmarke(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await warteAuf(page, `h1:has-text("${STEINKAUZ_TITEL}")`)
  await demo.hold(1000)

  await inDieMitte(page, demo, BESPRECHEN, { tempo: FILM_SCROLL_TEMPO })
  await ruhigKlicken(demo, BESPRECHEN)
  await warteAuf(page, KONTEXT_CHIP)
  await demo.point(KONTEXT_CHIP)
  await demo.hold(1200)

  // Off the words before the opening turn lands.
  await demo.point(EINGABE)
  await warteAufAntwort(page, 0)
  await demo.hold(2000)

  await demo.hold(VOR_KLICK_MS)
  await demo.type(EINGABE, FRAGE)
  await ruhigKlicken(demo, SENDEN)
  await demo.point(EINGABE)
  await warteAufAntwort(page, 1)

  const marke = (await jetztSichtbar(page, MARKE_SERIENSTART))
    ? MARKE_SERIENSTART
    : ERSTE_MARKE
  if (!(await jetztSichtbar(page, marke))) {
    throw new Error(
      'The answer cites no moment of the meeting, so there is no mark to ' +
        'click. Run the take again.',
    )
  }
  // Reading time, then the mark to the middle and the click.
  await demo.hold(3000)
  await inDieMitte(page, demo, marke, { tempo: FILM_SCROLL_TEMPO })
  await ruhigKlicken(demo, marke)

  // The meeting page: the cited row highlighted, and the recording running.
  await warteAuf(page, `h1:has-text("${STEINKAUZ_TITEL}")`)
  // For the decision's own mark the row must be the cited sentence, not the
  // one before it (the #7395 failure); any other mark only needs a row.
  await warteAuf(
    page,
    marke === MARKE_SERIENSTART ? SERIENSTART_AKTIV : AKTIVE_ZEILE,
    20_000,
  )
  await warteAuf(page, PAUSIEREN, 10_000)
  await warteImBild(page, AKTIVE_ZEILE, 3000)
  await demo.hold(WIEDERGABE_MS)
}

/**
 * Waits until `selector` stands fully inside the viewport. The page brings the
 * cited row into view with a smooth scroll, so the first geometry after the
 * jump can still be on its way.
 */
async function warteImBild(
  page: RecordPage,
  selector: string,
  fristMs: number,
): Promise<void> {
  const ende = Date.now() + fristMs
  for (;;) {
    const box = await page.locator(selector).boundingBox()
    const hoehe = page.viewportSize()?.height ?? 0
    if (box !== null && box.y >= 0 && box.y + box.height <= hoehe) return
    if (Date.now() > ende) {
      throw new Error(
        `The highlighted row is off screen (top ${String(box?.y)} px, ` +
          `viewport ${String(hoehe)} px): the jump did not bring it into view.`,
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 200))
  }
}
