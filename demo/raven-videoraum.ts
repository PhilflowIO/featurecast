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
 * Product film, scene M3 "Dein eigener Videoraum": the host puts the meeting's
 * protocol on the shared screen, starts the recording, and the room says what
 * it is doing while it does it.
 *
 * NO FACES, AND NOT AN EMPTY ROOM EITHER. The four AI faces are out of the
 * film, so the host sits alone with her camera off. The first version of this
 * scene stopped there and was filmed: a single tile is full-bleed, so the frame
 * was a grey silhouette a metre tall beside "Teilnehmer 0". Every pixel true,
 * and none of it saying "your own video room". A shared screen fixes that
 * without inventing anybody — it is also simply what a status round looks like.
 *
 * WHAT IS ON THE SHARED SCREEN IS RAVEN. The file is one of this repository's
 * own renders of the meeting protocol (scene S2), so the room shows the real
 * product and nothing staged. The pointer-free render on purpose: a shared
 * screen carrying a second mouse cursor next to the recording's own reads as a
 * mistake.
 *
 * A HEADLESS BROWSER CANNOT SHARE A REAL SCREEN, which is measured, not
 * assumed: `getDisplayMedia` does return a live 1280x720@30 track, but with
 * `--use-fake-device-for-media-stream` its source is Chromium's synthetic
 * screen under every selection switch. So the share is fed from a file
 * (`fakeMedia.screen`, featurecast#190) exactly as the microphone is.
 *
 * WHAT IS DELIBERATELY ABSENT: A CLAIM ABOUT ENCRYPTION. The product says
 * nothing about it that a Team-tier workspace can see — every encryption
 * string in the app sits inside a branch only a `souveraen` tenant in customer
 * custody reaches, and `/settings/encryption` answers this account with an
 * upsell. The one place it is stated for everyone is a row of the public
 * pricing table, which is a different surface and a different scene.
 *
 * PRECONDITIONS:
 *
 *   1. A room created with the demo account (`POST /api/meet/create-room`);
 *      `RAVEN_ROOM_LINK` is its HOST link (the `_ht=` one — the record control
 *      exists only for the host).
 *   2. Her voice at `artifacts/.media/Marlene Ostwald.wav` and the shared
 *      picture at `artifacts/.media/geteilter-bildschirm.mp4`. Both are
 *      git-ignored and have to be placed in the run directory by hand.
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
 * The pin. On a phone this is not a convenience, it is the scene.
 *
 * Measured on staging 2026-09-19 at 390x844, plain Playwright without any
 * recording shell: the top bar starts VISIBLE (`y=15`, `pointer-events: auto`),
 * one tap on the stage moves it to `y=-12.24` with `pointer-events: none`, and
 * a second tap brings it back. That is the product working as designed — on a
 * coarse pointer there is no idle clock and a tap on the stage toggles
 * (`use-chrome-visibility.ts` in `flow.raven`). What it cost was a take: the
 * recorder's first touch landed on the stage, the bar went away, and the take
 * aborted on an occluded record control. Nothing was wrong with Raven.
 */
const LEISTE_FESTHALTEN = '[data-testid="meeting-chrome-pin-toggle"]'

/** Sharing. The toggle only renders at all if `getDisplayMedia` exists. */
const TEILEN = 'button[title="Bildschirm teilen"]'
const GETEILTE_KACHEL = '[data-lk-source="screen_share"] >> nth=0'

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

/** Her voice and the picture she shares — never her face. */
export const fakeMedia = {
  microphone:
    process.env.RAVEN_HOST_VOICE ?? 'artifacts/.media/Marlene Ostwald.wav',
  screen:
    process.env.RAVEN_SHARE_VIDEO ??
    'artifacts/.media/geteilter-bildschirm.mp4',
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

  // Pinned by KEYBOARD, not by clicking the pin. The shortcut is a
  // window-level listener (`chrome-pin-button.tsx`), so it works whether or not
  // the bar is on screen and whether or not it is hit-testable — while a click
  // on the pin needs the very bar whose disappearance is the problem.
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
  await app.waitForTimeout(3000)
}

export default async function videoraum(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await demo.hold(2000)

  // The protocol goes on the shared screen first, so the recording that starts
  // next has something to record and the room has something to look at.
  await ruhigKlicken(demo, TEILEN)
  await warteAuf(page, GETEILTE_KACHEL, 45_000)
  await demo.hold(3500)

  await ruhigKlicken(demo, AUFNEHMEN)
  await warteAuf(page, VIDEO_UND_TON, 10_000)
  await demo.hold(1200)
  await ruhigKlicken(demo, VIDEO_UND_TON)

  // The notice is the proof, not the button's own state: the button flips as
  // soon as the request is sent, the ring appears when the recorder runs.
  await warteAuf(page, LAEUFT, AUFNAHME_FRIST_MS)
  await demo.hold(LAUFZEIT_MS)

  await ruhigKlicken(demo, STOPPEN)
  await warteAuf(page, LAEUFT_NICHT, 30_000)
  await demo.hold(NACH_KLICK_MS + 2500)
}
