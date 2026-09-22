import { chromium, type Browser, type Frame } from 'playwright'

import { BUNDLE_CHANNEL } from '../src/browser.js'
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

/** The establishing shot: the room, before anything happens in it. */
const TOTALE_MS = 5000

/** The shared screen, standing still long enough to be seen for what it is. */
const ZEIGEN_MS = 5000

/**
 * The label in the corner of the shared tile.
 *
 * It read "<Name>'s screen" in English until flow.raven#7468 — one string, in
 * our own file, carried in from LiveKit's body along with the tile (#5081).
 * A take that still shows it is a take with an English word in a German
 * product film, and that is exactly the defect this re-shoot exists to remove,
 * so it ends the take rather than being noticed in the edit.
 */
async function pruefeBeschriftung(page: RecordPage): Promise<void> {
  const text = await page.evaluate<string>(() => {
    const kachel = document.querySelector('[data-lk-source="screen_share"]')
    return kachel?.textContent ?? ''
  })
  if (/'s screen/i.test(text) || !text.includes('Bildschirm')) {
    throw new Error(
      `The shared tile is not labelled in German: ${JSON.stringify(text)}. ` +
        `Expected "<Name> · Bildschirm" (flow.raven#7468). Filming this ` +
        `would put an English string into a German product film.`,
    )
  }
}

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
  // The room as a wide shot, before anything happens in it. Five seconds and
  // not two: this is the establishing shot of the scene and the cut needs a
  // stretch it can sit on, not a beat it has to stretch.
  await demo.hold(TOTALE_MS)

  // The protocol goes on the shared screen first, so the recording that starts
  // next has something to record and the room has something to look at.
  await ruhigKlicken(demo, TEILEN)
  await warteAuf(page, GETEILTE_KACHEL, 45_000)
  await pruefeBeschriftung(page)
  await demo.hold(ZEIGEN_MS)

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

// ── Two more people in the room ─────────────────────────────────────────────
//
// Used by `raven-videoraum-quer-zu-zweit.ts` and by nothing else. It lives
// here rather than there because the room, the join and the pre-join
// hydration trap are this scene's knowledge, and a second copy of them would
// drift away from the first one.
//
// WHY TWO AND NOT ONE. The count in the top bar comes from
// `useRemoteParticipants()` (`roster-panel.tsx:82,184-186` in `flow.raven`),
// which counts everybody EXCEPT the person looking at it. With one guest the
// header reads "Teilnehmer 1" — the host does not count herself. Two guests
// make it read 2, which is the number the film's claim needs: the recording
// notice is shown "für alle", and a room of one contradicts that.
//
// THE RECORDER ITSELF DOES NOT SHOW UP. `recording-manager` joins with
// `hidden: true` and records per-track egress (`recording-manager/src/index.ts`
// in `flow.raven`), so starting the recording does not change the number.

/** Two plain German names, and no faces. See the module header. */
const GAESTE = ['Jonas Feddersen', 'Nadia Oberländer'] as const

/** The pre-join name field. Matched by placeholder; the class has moved once. */
const GAST_NAME = 'input.lk-username-input, input[placeholder*="Name" i]'

/** How long a guest may take to be in the room. */
const GAST_FRIST_MS = 120_000

let gastBrowser: Browser | undefined

/**
 * Mints one invite per guest through the host's own session and joins them.
 *
 * Minted rather than re-using the room's single `guestUrl`: the token store
 * binds a token to the first identity that uses it
 * (`api/app/db/room_tokens.py` in `flow.raven`), and whether a second browser
 * may share one is not settled in the source. One invite per guest is the path
 * the repository's own multi-party tool took, so it is the one taken here.
 *
 * Called from `prepare`, so the guests are in the room before the camera
 * rolls and the first frame is a full room rather than one filling up.
 */
export async function gaesteBeitreten(app: Frame): Promise<void> {
  const raum = pflicht('RAVEN_ROOM_NAME')
  const links: string[] = []
  for (let i = 0; i < GAESTE.length; i += 1) {
    // A string payload: `evaluate` passes no arguments, and a compiled
    // function would carry tsx's `__name` into the page.
    const body = JSON.stringify(JSON.stringify({ roomName: raum }))
    const antwort = await app.evaluate<{ guestUrl?: string }>(
      `fetch('/api/meet/create-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${body} }).then(function (r) { return r.json() })` as unknown as () => Promise<{
        guestUrl?: string
      }>,
    )
    if (antwort.guestUrl === undefined) {
      throw new Error(
        `No invite for guest ${String(i + 1)}: the host session could not ` +
          'mint one. RAVEN_ROOM_NAME has to be the TENANT-PREFIXED room name ' +
          'of the room RAVEN_ROOM_LINK points at.',
      )
    }
    links.push(antwort.guestUrl)
  }

  gastBrowser = await chromium.launch({
    args: [
      // No camera and no microphone is published, but the pre-join screen asks
      // for both before the toggles are read. A fake device answers without a
      // permission prompt; a real one does not exist in a container.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
    channel: BUNDLE_CHANNEL,
    headless: true,
  })
  for (const [i, gast] of GAESTE.entries()) {
    const link = links[i]
    if (link === undefined) throw new Error(`No invite for ${gast}.`)
    const kontext = await gastBrowser.newContext({
      locale: RAVEN_LOCALE,
      // Signed OUT, deliberately: a guest is a guest. The invite token is the
      // whole credential.
      storageState: { cookies: [], origins: [] },
      viewport: { height: 800, width: 1280 },
    })
    const seite = await kontext.newPage()
    await seite.goto(`${RAVEN_URL}${link}`)

    const beitreten = seite.getByRole('button', { name: 'Raum beitreten' })
    await beitreten.waitFor({ state: 'visible', timeout: GAST_FRIST_MS })
    for (const quelle of [KAMERA, MIKROFON]) {
      const knopf = seite.locator(quelle).first()
      await knopf.waitFor({ state: 'visible', timeout: 20_000 })
      if ((await knopf.getAttribute('aria-pressed')) === 'true')
        await knopf.click()
    }
    const name = seite.locator(GAST_NAME).first()
    // The same hydration proof the host's own join needs: a fill before
    // hydration is reset to '' and the button stays disabled.
    for (let versuch = 0; versuch < 20; versuch += 1) {
      await name.fill('')
      await name.fill(gast)
      await seite.waitForTimeout(500)
      if ((await name.inputValue()) === gast && (await beitreten.isEnabled())) {
        break
      }
    }
    await beitreten.click()
    await seite
      .locator(IM_RAUM)
      .waitFor({ state: 'visible', timeout: GAST_FRIST_MS })
  }

  // Their tiles arrive a moment after the connection; let the grid settle
  // before the establishing shot is filmed.
  await app.waitForTimeout(4000)
}

/** Closes the guests' browser. Called after the take, never during it. */
export async function gaesteVerlassen(): Promise<void> {
  await gastBrowser?.close()
  gastBrowser = undefined
}
