import type { Frame } from 'playwright'

import type { Demo, RecordPage } from '../src/record.js'
import {
  NACH_KLICK_MS,
  RAVEN_ALLOW_FRAMING,
  RAVEN_HIDE_SELECTORS,
  RAVEN_LOCALE,
  RAVEN_STATE,
  RAVEN_URL,
  ruhigKlicken,
  warteAuf,
} from './raven-common.js'

/**
 * Product film, scene M3 "Dein eigener Videoraum": the recording starts, the
 * recording runs, and the room says so while it does.
 *
 * ONE PERSON, NO FACES. The four AI faces are out of the film, so this scene is
 * the host alone with her camera off. What the product then shows on her tile
 * is not initials but LiveKit's own silhouette
 * (`lk-participant-placeholder` in `raven-participant-tile.tsx`, `flow.raven`),
 * with her name on the pill beneath it — read from the source before the scene
 * was written, because a scene built on an invented tile is the same lie as an
 * invented face. Her microphone is on and carries her own demo voice file, the
 * one the live-meeting scene already uses, so the speaking indicator lights on
 * real audio rather than on nothing.
 *
 * WHY THE RECORDING IS STARTED BY HAND. Raven can also start it by itself in a
 * room that asks for consent first (`raven-auto-aufnahme.ts`, the other scene).
 * Filming that one here would tell a second story — and it would put the
 * consent gate on screen, which belongs to the guest's side, not the host's.
 *
 * WHAT IS DELIBERATELY ABSENT: A CLAIM ABOUT ENCRYPTION. The brief for this
 * scene asked for "the recording is stored encrypted" as its third beat. The
 * product does not say that anywhere a Team-tier workspace can see it. Every
 * encryption string in the app — "Dieses Meeting ist mit deinem Schlüssel
 * verschlüsselt", "Zusammenfassung verschlüsselt", "Dieses Meeting liegt in
 * eigener Obhut (Souverän)" — sits inside a branch that only a `souveraen`
 * tenant in customer custody reaches, and `/settings/encryption` answers this
 * account with an upsell. The one place the product states it for everyone is
 * a row of the public pricing table, "Medien server-seitig AES-256-GCM
 * verschlüsselt (at-rest)", which is a different surface and a different
 * scene. So this take ends on the recording running and stopping, and says
 * nothing about encryption at all.
 *
 * PRECONDITIONS:
 *
 *   1. A room created with the demo account (`POST /api/meet/create-room`);
 *      `RAVEN_ROOM_LINK` is its HOST link (the `_ht=` one — the record button
 *      exists only for the host, `recording-button.tsx:61`).
 *   2. `RAVEN_HOST_VOICE` points at Marlene's voice file (default
 *      `artifacts/.media/Marlene Ostwald.wav`, git-ignored).
 *
 * AFTERWARDS: the take leaves a room session and one meeting per device. End
 * the room (`POST /api/meet/end-room`), wait until the meeting is no longer
 * `processing` — deleting it earlier is undone, the transcription finalizer
 * recreates it — then delete it.
 *
 * INVOCATION (GPU host)::
 *
 *     RAVEN_ROOM_LINK=… FEATURECAST_BOX_ENV=RAVEN_ROOM_LINK \
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-videoraum.ts --devices desktop-wide,iphone
 */

const GASTGEBERIN = 'Marlene Ostwald'

/** Pre-join controls. */
const KAMERA = 'button[data-lk-source="camera"]'
const MIKROFON = 'button[data-lk-source="microphone"]'
const NAME = 'input.lk-username-input, input[placeholder*="Name" i]'

/** Proof that the room is entered, not still being entered. */
const IM_RAUM = '[data-testid="meeting-leave-button"]'

/**
 * The bars are pinned for this scene, unlike the live-meeting one. There the
 * bars were left to fade so the opening grid showed four name pills; here the
 * whole scene is one control in the top bar, and a bar that goes away mid-take
 * takes the subject of the shot with it.
 *
 * ON A PHONE THIS IS NOT A CONVENIENCE, IT IS THE SCENE. Measured on staging
 * 2026-09-19 at 390x844, plain Playwright without any recording shell: the top
 * bar starts VISIBLE (`y=15`, `pointer-events: auto`), one tap on the stage
 * moves it to `y=-12.24` with `pointer-events: none`, and a second tap brings
 * it back. That is the product working as designed — on a coarse pointer there
 * is no idle clock and a tap on the stage toggles (`use-chrome-visibility.ts`
 * in `flow.raven`). What it cost was a take: the recorder's first touch landed
 * on the stage, the bar went away, and the take aborted on an occluded record
 * control before filming a frame. Nothing was wrong with Raven.
 */
const LEISTE_FESTHALTEN = '[data-testid="meeting-chrome-pin-toggle"]'

/** The record control. Host-only, and in the TOP bar, not the bottom one. */
const AUFNEHMEN = 'button[title="Aufnahme starten"]'
const STOPPEN = 'button[title="Aufnahme stoppen"]'
/** The mode menu the first click opens. */
const VIDEO_UND_TON = 'role=menuitem[name="Video + Audio"]'

/**
 * The red ring around the whole stage while the recorder runs. It IS the
 * notice, not a decoration: `recording-button.tsx` calls it "the recording
 * notice (#1275, EU AI Act Art. 50)", so a take without it on screen would be
 * showing a recording the room was not told about.
 */
const LAEUFT = '[data-recording-notice="on"]'
const LAEUFT_NICHT = '[data-recording-notice="off"]'

/** Egress takes a moment to come up; measured at about 8 s on staging. */
const AUFNAHME_FRIST_MS = 90_000

/** How long the running recording is held, so the notice can be read. */
const LAUFZEIT_MS = 9000

function pflicht(name: string): string {
  const wert = process.env[name]
  if (wert === undefined || wert === '') {
    throw new Error(
      `${name} is not set; see the header of demo/raven-videoraum.ts.`,
    )
  }
  return wert
}

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING
export const locale = RAVEN_LOCALE

/**
 * Her voice, not her face. The microphone file is the same one the
 * live-meeting scene uses; no camera is declared, because the scene is about a
 * room with the camera off and a synthetic camera would only paint a green
 * test picture behind the silhouette.
 */
export const fakeMedia = {
  microphone:
    process.env.RAVEN_HOST_VOICE ?? 'artifacts/.media/Marlene Ostwald.wav',
}

/** Joins the room with the camera off, and holds the bars still. */
export async function prepare(app: Frame): Promise<void> {
  const link = pflicht('RAVEN_ROOM_LINK')
  if (!link.startsWith(RAVEN_URL)) {
    throw new Error(`RAVEN_ROOM_LINK has to point at ${RAVEN_URL}.`)
  }
  await app.goto(link)
  const beitreten = app.getByRole('button', { name: 'Raum beitreten' })
  await beitreten.waitFor({ state: 'visible', timeout: 30_000 })

  const kamera = app.locator(KAMERA).first()
  await kamera.waitFor({ state: 'visible', timeout: 15_000 })
  if ((await kamera.getAttribute('aria-pressed')) === 'true')
    await kamera.click()
  const mikrofon = app.locator(MIKROFON).first()
  await mikrofon.waitFor({ state: 'visible', timeout: 15_000 })
  if ((await mikrofon.getAttribute('aria-pressed')) === 'false')
    await mikrofon.click()

  const name = app.locator(NAME).first()
  // The same hydration proof the live-meeting scene needs: a fill before
  // hydration is reset to '' and the button stays disabled.
  for (let versuch = 0; versuch < 20; versuch += 1) {
    await name.fill('')
    await name.fill(GASTGEBERIN)
    await app.waitForTimeout(500)
    if (
      (await name.inputValue()) === GASTGEBERIN &&
      (await beitreten.isEnabled())
    ) {
      break
    }
  }
  await beitreten.click()
  await app.locator(IM_RAUM).waitFor({ state: 'visible', timeout: 60_000 })

  // Pinned by KEYBOARD, not by clicking the pin. The shortcut is a window-level
  // listener (`chrome-pin-button.tsx`), so it works whether or not the bar is
  // on screen and whether or not it is hit-testable — while a click on the pin
  // needs the very bar whose disappearance is the problem. The state is then
  // read back, because a scene that films an unpinned room fails minutes later
  // and looks like something else.
  const anheften = app.locator(LEISTE_FESTHALTEN).first()
  await anheften.waitFor({ state: 'attached', timeout: 20_000 })
  for (let versuch = 0; versuch < 5; versuch += 1) {
    if ((await anheften.getAttribute('aria-pressed')) === 'true') break
    await app.press('body', 'Alt+s')
    await app.waitForTimeout(600)
  }
  if ((await anheften.getAttribute('aria-pressed')) !== 'true') {
    throw new Error(
      'The bars are not pinned, so a single touch on the stage takes the ' +
        'record control off screen mid-take (measured: y=15 → y=-12.24 on a ' +
        '390x844 phone). Filming without the pin is filming a coin flip.',
    )
  }
  // The tile paints its placeholder and the name pill a moment after the room
  // is entered; the first frame should already have both.
  await app.waitForTimeout(3000)
}

export default async function videoraum(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  // The room as it stands: one tile, no camera, the name on the pill.
  await demo.hold(2500)

  await ruhigKlicken(demo, AUFNEHMEN)
  await warteAuf(page, VIDEO_UND_TON, 10_000)
  await demo.hold(1200)
  await ruhigKlicken(demo, VIDEO_UND_TON)

  // The notice is the proof, not the button's own state: the button flips as
  // soon as the request is sent, the ring appears when the recorder actually
  // runs.
  await warteAuf(page, LAEUFT, AUFNAHME_FRIST_MS)
  await demo.hold(LAUFZEIT_MS)

  await ruhigKlicken(demo, STOPPEN)
  await warteAuf(page, LAEUFT_NICHT, 30_000)
  await demo.hold(NACH_KLICK_MS + 2500)
}
