import type { Demo, RecordPage } from '../src/record.js'
import {
  BESPRECHEN,
  EINGABE,
  FILM_SCROLL_TEMPO,
  KONTEXT_CHIP,
  RAVEN_ALLOW_FRAMING,
  RAVEN_LOCALE,
  RAVEN_HIDE_SELECTORS,
  RAVEN_STATE,
  RAVEN_URL,
  SENDEN,
  STEINKAUZ_FIXED_TIME,
  STEINKAUZ_TITEL,
  VOR_KLICK_MS,
  inDieMitte,
  ruhigKlicken,
  vorbereiten,
  warteAuf,
  warteAufAntwort,
  zeileMitTitel,
} from './raven-common.js'

/**
 * Product film, scene S5 "Frag deine Meetings" (hook and finale): the chat
 * clip of `raven-besprechen.ts`, shot again on the Steinkauz status round, the
 * one demo meeting with a real recording and named speakers.
 *
 * The story is the same: meetings list → the meeting → "Mit Raven besprechen"
 * → Raven's own opening turn → the viewer's question → the streamed answer.
 * What differs is the meeting and the pacing of the shot list: a rest before
 * and after every click, scrolls at 400 px/s.
 *
 * The meeting is the newest one, so it is the list's first row under the
 * scene clock (`STEINKAUZ_FIXED_TIME`, a quarter of an hour after it). No
 * scroll through the list: this clip is the hook, not the tour.
 *
 * The question fits the content: two decisions (the Salmweide framework
 * contract, the series start on line 3 on 3 November) and two open points
 * (calibration of the test equipment, the delivery date for Salmweide).
 *
 * Each take leaves one assistant thread in the demo account; delete it after
 * (`GET /api/chat/threads`, `DELETE /api/chat/threads/<id>` in a signed-in
 * context).
 *
 * INVOCATION (GPU host)::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-steinkauz-fragen.ts --devices desktop-wide,iphone
 */

const ZEILE = zeileMitTitel(STEINKAUZ_TITEL)

const FRAGE = 'Was wurde entschieden, und was ist noch offen?'

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const fixedTime = STEINKAUZ_FIXED_TIME
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING
export const locale = RAVEN_LOCALE

/** The list, loaded before the camera rolls, with this meeting's row in it. */
export const prepare = vorbereiten('/meetings', ZEILE)

export default async function steinkauzFragen(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await demo.hold(1000)

  // The first row, on screen from the first frame: no scroll before it.
  await ruhigKlicken(demo, ZEILE)
  // The meeting's own title, not any `h1`: the list has one too.
  await warteAuf(page, `h1:has-text("${STEINKAUZ_TITEL}")`)

  await warteAuf(page, BESPRECHEN)
  await inDieMitte(page, demo, BESPRECHEN, { tempo: FILM_SCROLL_TEMPO })
  await ruhigKlicken(demo, BESPRECHEN)
  await warteAuf(page, KONTEXT_CHIP)
  await demo.point(KONTEXT_CHIP)
  await demo.hold(1200)

  // Off the words before the opening turn lands.
  await demo.point(EINGABE)
  await warteAufAntwort(page, 0)
  await demo.hold(2500)

  await demo.hold(VOR_KLICK_MS)
  await demo.type(EINGABE, FRAGE)
  await ruhigKlicken(demo, SENDEN)
  // Out of the answer's way while it streams.
  await demo.point(EINGABE)
  await warteAufAntwort(page, 1)
  // Reading time for the whole answer; a scripted hold is kept in full.
  await demo.hold(8000)
}
