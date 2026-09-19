import type { Demo, RecordPage } from '../src/record.js'
import {
  FILM_SCROLL_TEMPO,
  NACH_KLICK_MS,
  RAVEN_ALLOW_FRAMING,
  RAVEN_HIDE_SELECTORS,
  RAVEN_LOCALE,
  RAVEN_STATE,
  RAVEN_URL,
  STEINKAUZ_FIXED_TIME,
  STEINKAUZ_ID,
  VOR_KLICK_MS,
  inDieMitte,
  jetztSichtbar,
  ruhigKlicken,
  vorbereiten,
  warteAuf,
} from './raven-common.js'

/**
 * Product film, scene M5 "Teilen": a summary goes out of the house, and the
 * viewer sees exactly how much of it goes with it — and that it can be taken
 * back.
 *
 * The scene walks the public link on the Steinkauz status round: the ladder of
 * what a recipient gets (Zusammenfassung → + Transkript → + Ton → + Video, with
 * a live readout beside it), a password, the created link, and then the
 * withdrawal. The link is revoked ON CAMERA, which is both the last beat of the
 * scene and the reason the token visible in the frame is harmless by the time
 * anyone sees the film.
 *
 * WHAT THIS SCENE DOES NOT SHOW, AND WHY. The second half of Raven's
 * permission model — a whole team, or one named colleague — is not filmed,
 * because the demo workspace cannot show it honestly. It holds exactly one
 * member and no team, so the internal "Teilen" dialog says so on screen: the
 * team rung is greyed out under "Kein Team angelegt", the organisation rung
 * reads "Alle 1 Personen können ansehen", and the colleague picker has nothing
 * to pick. Filming that would put the demo account's emptiness into a product
 * film. The dialog itself is right and the tier (team) unlocks all of it —
 * what is missing is people. Two or three colleagues and one team in the demo
 * workspace, and the other half of this scene can be shot without changing a
 * line of product code.
 *
 * INVOCATION (GPU host)::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-teilen.ts --devices desktop-wide,iphone
 */

/** The trigger on the meeting page. Not "Teilen" — that is the internal one. */
const OEFFENTLICH = 'role=button[name="Öffentlich teilen"]'

/** The dialog is up once its ladder has a heading. */
const LEITER = 'text=Was soll sichtbar sein >> nth=0'

/** The second rung: the recipient gets the wording, not only the result. */
const RUNG_TRANSKRIPT = '[role="radio"]:has-text("+ Transkript") >> nth=0'

/** The readout beside the ladder, which answers the ladder in plain words. */
const EMPFAENGER = 'text=Der Empfänger bekommt >> nth=0'

/**
 * The disclosure over the folded options. Case-sensitive and exact: the
 * finished link's row carries a "Zugriff ändern" button, and a loose match
 * would take that one on the second half of the scene.
 */
const OPTIONEN = 'role=button[name="Ändern"s]'

/**
 * The password field. Addressed by type rather than by its placeholder: the
 * placeholder is the one string in this dialog that reads like a hint and is
 * therefore the likeliest to be rewritten.
 */
const PASSWORT = 'input[type="password"] >> nth=0'

/** What the readout says once the field carries something. */
const GESCHUETZT = 'text=Der Link ist mit einem Passwort geschützt >> nth=0'

const ERSTELLEN = 'role=button[name="Link erstellen"]'
const ERSTELLT = 'text=Link erstellt >> nth=0'
const KOPIEREN = 'role=button[name="Link kopieren"]'
const AKTIVE = 'text=Aktive Links >> nth=0'
const WIDERRUFEN = 'role=button[name="Link widerrufen"]'

/**
 * A password nobody has to think about while reading it. Short enough to type
 * on camera without the shot going slack, and visibly a password rather than a
 * word, so the dots in the field are not mistaken for a name.
 */
const PASSWORT_TEXT = 'Ockerbach26'

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const fixedTime = STEINKAUZ_FIXED_TIME
export const locale = RAVEN_LOCALE
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

/** The meeting, loaded before the camera rolls, with its share trigger. */
export const prepare = vorbereiten(`/meetings/${STEINKAUZ_ID}`, OEFFENTLICH)

export default async function teilen(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await demo.hold(1200)

  await inDieMitte(page, demo, OEFFENTLICH, { tempo: FILM_SCROLL_TEMPO })
  await ruhigKlicken(demo, OEFFENTLICH)
  await warteAuf(page, LEITER)
  // The pointer moves INTO the dialog before anything is scrolled. A scroll is
  // a wheel on a desktop and a swipe on a phone, and both act where the
  // pointer stands: left on the trigger button behind the overlay, every
  // scroll below would move the page instead of the dialog.
  await demo.point(LEITER)
  await demo.hold(1200)

  // The ladder, and the readout that answers it. On a phone the readout sits
  // under the ladder rather than beside it, far below the fold — hence the
  // trip for every one of these, and `imBild` rather than a bare point.
  await imBild(page, demo, EMPFAENGER)
  await demo.point(EMPFAENGER)
  await demo.hold(1800)
  await imBild(page, demo, RUNG_TRANSKRIPT)
  await ruhigKlicken(demo, RUNG_TRANSKRIPT)
  await demo.hold(1500)

  // The password, and the line the readout gains because of it.
  await imBild(page, demo, OPTIONEN)
  await ruhigKlicken(demo, OPTIONEN)
  await warteAuf(page, PASSWORT, 15_000)
  await imBild(page, demo, PASSWORT)
  await demo.hold(VOR_KLICK_MS)
  await demo.type(PASSWORT, PASSWORT_TEXT)
  await warteAuf(page, GESCHUETZT, 10_000)
  await imBild(page, demo, GESCHUETZT)
  await demo.point(GESCHUETZT)
  await demo.hold(2200)

  await imBild(page, demo, ERSTELLEN)
  await ruhigKlicken(demo, ERSTELLEN)
  await warteAuf(page, ERSTELLT, 30_000)
  await imBild(page, demo, ERSTELLT)
  await demo.hold(1800)
  await imBild(page, demo, KOPIEREN)
  await ruhigKlicken(demo, KOPIEREN)

  // And back again. The row under "Aktive Links" says what the link carries
  // and that it is protected; the click takes it away.
  await warteAuf(page, AKTIVE, 10_000)
  await imBild(page, demo, WIDERRUFEN)
  await demo.point(AKTIVE)
  await demo.hold(1800)
  await ruhigKlicken(demo, WIDERRUFEN)
  await warteBisWeg(page, WIDERRUFEN, 20_000)
  await demo.hold(NACH_KLICK_MS + 2500)
}

/**
 * Brings `selector` into the picture if it is not already comfortably in it.
 *
 * `inDieMitte` with a guard in front: it places a target that is off screen or
 * close to an edge, and leaves one that already stands well inside alone, so a
 * desktop layout that shows the whole dialog at once does not scroll for show.
 * Without it the phone take aborts on the first thing the dialog puts below
 * the fold — measured: the readout at y=3697 in a 2880 px picture.
 */
async function imBild(
  page: RecordPage,
  demo: Demo,
  selector: string,
): Promise<void> {
  const box = await page.locator(selector).boundingBox()
  const hoehe = page.viewportSize()?.height
  if (box === null || hoehe === undefined) return
  const rand = hoehe * 0.15
  if (box.y >= rand && box.y + box.height <= hoehe - rand) return
  await inDieMitte(page, demo, selector, { tempo: FILM_SCROLL_TEMPO })
}

/**
 * Waits until nothing visible matches `selector` any more.
 *
 * The last beat of the scene is an absence, and an absence is the one thing
 * `warteAuf` cannot wait for. Without it a take in which the withdrawal failed
 * would look exactly like one in which it worked — the renderer would trim the
 * motionless seconds afterwards either way.
 */
async function warteBisWeg(
  page: RecordPage,
  selector: string,
  fristMs: number,
): Promise<void> {
  const ende = Date.now() + fristMs
  for (;;) {
    if (!(await jetztSichtbar(page, selector))) return
    if (Date.now() > ende) {
      throw new Error(
        `The link is still listed ${String(fristMs)} ms after it was ` +
          'withdrawn. The scene ends on the withdrawal, so a take in which it ' +
          'did not happen is not this scene.',
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}
