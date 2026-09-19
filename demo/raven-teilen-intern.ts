import type { Frame } from 'playwright'

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
  inDieMitte,
  jetztSichtbar,
  ruhigKlicken,
  warteAuf,
} from './raven-common.js'

/**
 * Product film, scene M5, second half: who inside the house gets the meeting.
 *
 * `raven-teilen.ts` films the link that leaves the house. This films the other
 * axis of the same promise — "mit wem du teilst, entscheidest du" — inside it:
 * the reach moves from nobody to a whole team, one colleague is then named
 * personally, and that one grant is taken back on camera. Three beats, each of
 * which changes the readout at the foot of the dialog, so the viewer never has
 * to be told what happened; the sentence says it.
 *
 * Why this could not be filmed with the first half (featurecast #176, now
 * #186): the demo workspace held one person and no team, so the dialog said so
 * — "Kein Team angelegt" on a greyed rung, "Alle 1 Personen" on the widest one.
 * That is the demo account's emptiness, not the product's. The workspace now
 * holds four people and the team "Projekt Steinkauz", all of them created
 * through Raven's own invitation flow.
 *
 * INVOCATION (GPU host)::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-teilen-intern.ts \
 *         --devices desktop-wide,iphone
 */

/** The internal trigger. Exact and case-sensitive — "Öffentlich teilen" is the other one. */
const TEILEN = 'role=button[name="Teilen"s]'

/** The dialog is up once its heading is there. */
const DIALOG = 'role=heading[name="Meeting teilen"]'

/**
 * The owner row. The list renders before members, teams and shares have
 * landed, so the heading alone is not "ready" — this line is, because it is
 * drawn from the session the dialog fetched.
 */
const BESITZER = 'text=Besitzer · alle Rechte >> nth=0'

/** The team the demo workspace works in, and its rung on the reach ladder. */
const TEAM = 'Projekt Steinkauz'
const RUNG_TEAM = `[role="radio"]:has-text("Alle in ${TEAM}")`

/** The button that writes the drafted reach, and the line that confirms it. */
const UEBERNEHMEN = '[data-reach-commit]'
const AKTIV_TEAM = `text=Aktiv: Alle in ${TEAM} >> nth=0`

/** The readout that says, in plain words, who can do what right now. */
const READOUT = '[data-access-state]'

/** The colleague picker, the role beside it, and the button that grants. */
const PICKER = '[aria-label="Kolleg:in auswählen"]'
const HINZUFUEGEN = 'role=button[name="Hinzufügen"]'

/**
 * The colleague the scene names. A person of the Ockerbach world who also
 * speaks in this meeting, so the name is not a stranger to the film.
 */
const KOLLEGIN = 'Ayla Demirci'
const ENTZIEHEN = `role=button[name="Freigabe für ${KOLLEGIN} entziehen"]`
const READOUT_MIT_KOLLEGIN = `text=${KOLLEGIN} kann ansehen. >> nth=0`

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const fixedTime = STEINKAUZ_FIXED_TIME
export const locale = RAVEN_LOCALE
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

/**
 * Opens the meeting — and first puts its access back to where the scene
 * begins.
 *
 * The scene CHANGES the meeting: it widens the reach to the team and leaves it
 * there, because the last beat is about the named grant, not about the rung.
 * The second device would therefore open on a meeting that is already shared
 * with the team, where the first click is a no-op and the commit button stays
 * disabled — a take that films a different scene than the first one and does
 * not fail while doing it. Resetting through the product's own endpoints (the
 * same ones the dialog posts to) makes every take start from the same state.
 */
export const prepare = async (app: Frame): Promise<void> => {
  await app.goto(`${RAVEN_URL}/meetings/${STEINKAUZ_ID}`)
  await app.locator(TEILEN).waitFor({ state: 'visible', timeout: 30_000 })
  const zurueckgesetzt = await app.evaluate(async (id: string) => {
    const shares = await fetch(`/api/meetings/${id}/shares`, {
      credentials: 'include',
    })
    if (!shares.ok) return `shares: ${String(shares.status)}`
    // The endpoint answers with a bare array; the tolerant read costs nothing
    // and survives a wrapper being added around it.
    const body = (await shares.json()) as
      { grantee_user_id: string }[] | { shares?: { grantee_user_id: string }[] }
    const liste = Array.isArray(body) ? body : (body.shares ?? [])
    for (const s of liste) {
      await fetch(`/api/meetings/${id}/share/${s.grantee_user_id}`, {
        credentials: 'include',
        method: 'DELETE',
      })
    }
    const reach = await fetch(`/api/meetings/${id}/visibility`, {
      body: JSON.stringify({ team_id: null, visibility: 'private' }),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
    })
    return reach.ok ? 'ok' : `visibility: ${String(reach.status)}`
  }, STEINKAUZ_ID)
  if (zurueckgesetzt !== 'ok') {
    throw new Error(
      `Could not put the meeting back to private before the take ` +
        `(${zurueckgesetzt}). The scene starts from "Außer dir hat niemand ` +
        'Zugriff" and films the way up from there; starting anywhere else ' +
        'films a different scene.',
    )
  }
  // Opened again rather than reloaded: `prepare` holds a frame, not a page,
  // and a frame has no reload. The second load is what makes the dialog read
  // the reset state instead of the one it was rendered with.
  await app.goto(`${RAVEN_URL}/meetings/${STEINKAUZ_ID}`)
  await app.locator(TEILEN).waitFor({ state: 'visible', timeout: 30_000 })
}

export default async function teilenIntern(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await demo.hold(1200)

  await inDieMitte(page, demo, TEILEN, { tempo: FILM_SCROLL_TEMPO })
  await ruhigKlicken(demo, TEILEN)
  await warteAuf(page, DIALOG)
  await warteAuf(page, BESITZER, 20_000)
  // The pointer moves INTO the dialog before anything is scrolled: a scroll is
  // a wheel on a desktop and a swipe on a phone, and both act where the
  // pointer stands.
  await demo.point(DIALOG)
  await demo.hold(1200)

  // 1. What is true before anything is shared.
  await imBild(page, demo, READOUT)
  await demo.point(READOUT)
  await demo.hold(1800)

  // 2. The whole team. The rung is only a draft until it is confirmed, so the
  //    scene shows both halves of that — which is also why over-sharing has a
  //    way back that costs the same two clicks.
  await imBild(page, demo, RUNG_TEAM)
  await ruhigKlicken(demo, RUNG_TEAM)
  await imBild(page, demo, UEBERNEHMEN)
  await ruhigKlicken(demo, UEBERNEHMEN)
  await warteAuf(page, AKTIV_TEAM, 20_000)
  await imBild(page, demo, READOUT)
  await demo.point(READOUT)
  await demo.hold(2200)

  // 3. One person by name. The picker is a native select, so the pointer
  //    visibly opens it and the choice is made on the element itself — the
  //    dropdown a browser draws is chrome and is not in the picture anyway.
  await imBild(page, demo, PICKER)
  await ruhigKlicken(demo, PICKER)
  await waehle(page, PICKER, KOLLEGIN)
  await demo.hold(1200)
  await imBild(page, demo, HINZUFUEGEN)
  await ruhigKlicken(demo, HINZUFUEGEN)
  await warteAuf(page, READOUT_MIT_KOLLEGIN, 20_000)
  await imBild(page, demo, READOUT)
  await demo.point(READOUT)
  await demo.hold(2200)

  // 4. And back. The scene ends on the absence, because the promise is not
  //    that sharing is easy — it is that it is reversible.
  await imBild(page, demo, ENTZIEHEN)
  await ruhigKlicken(demo, ENTZIEHEN)
  await warteBisWeg(page, READOUT_MIT_KOLLEGIN, 20_000)
  await imBild(page, demo, READOUT)
  await demo.point(READOUT)
  await demo.hold(NACH_KLICK_MS + 2500)
}

/**
 * Picks the option whose label is `beschriftung` on a native `<select>`.
 *
 * `Demo` has no select verb, and it should not have one: a native dropdown is
 * browser chrome and never reaches the video. What the camera sees is the
 * pointer's click on the closed control and the label changing in it, which is
 * exactly what this produces — the value is set on the element and the change
 * announced, the same two steps Playwright's own `selectOption` performs.
 */
async function waehle(
  page: RecordPage,
  selector: string,
  beschriftung: string,
): Promise<void> {
  const gewaehlt = await page
    .locator(selector)
    .evaluate((element: Element, label: string) => {
      const feld = element as HTMLSelectElement
      const treffer = [...feld.options].find((o) => o.text.trim() === label)
      if (treffer === undefined) {
        return [...feld.options].map((o) => o.text.trim()).join(' | ')
      }
      feld.value = treffer.value
      feld.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    }, beschriftung)
  if (gewaehlt !== 'ok') {
    throw new Error(
      `${beschriftung} is not in the colleague picker; it offers: ${String(gewaehlt)}`,
    )
  }
}

/**
 * Brings `selector` into the picture if it is not already comfortably in it.
 *
 * Copied in spirit from `raven-teilen.ts`: on a phone this dialog stacks, and
 * the readout the scene keeps returning to sits far below the fold. A desktop
 * that shows the whole dialog at once must not scroll for show, hence the
 * guard rather than a bare `inDieMitte`.
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
 * The last beat is an absence, and an absence is the one thing `warteAuf`
 * cannot wait for. Without this, a take in which the revoke failed would look
 * exactly like one in which it worked.
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
        `${KOLLEGIN} is still named in the readout ${String(fristMs)} ms ` +
          'after the grant was revoked. The scene ends on the withdrawal, so ' +
          'a take in which it did not happen is not this scene.',
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}
