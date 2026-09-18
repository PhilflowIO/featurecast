import type { Frame } from 'playwright'

import type { Demo, RecordPage } from '../src/record.js'
import {
  NACH_KLICK_MS,
  RAVEN_ALLOW_FRAMING,
  RAVEN_HIDE_SELECTORS,
  RAVEN_STATE,
  RAVEN_URL,
  ruhigKlicken,
  warteAuf,
} from './raven-common.js'

/**
 * Product film, scene S1 "Live-Meeting": a browser meeting with four people
 * talking, filmed from the host's seat. The host raises her hand, sends a
 * reaction, and a guest's hand goes up in answer.
 *
 * TWO TOOLS, ONE ROOM. This script is the host, Marlene Ostwald (the demo
 * account's own name), with her face on the camera and her voice on the
 * microphone (`fakeMedia` with files, featurecast#166). The three guests —
 * Ayla Demirci, Sven Kowalczyk, Deniz Aktas — come from flow.raven's
 * demo-meeting tool in guest-only mode (`ui/scripts/demo-meeting/`,
 * `DEMO_RAUM=…`, flow.raven#7287), each with face and voice, from a second
 * container on the same machine.
 *
 * ONE TIMELINE. All four voices are the tracks of one conversation, anchored
 * on the same wall-clock instant and looped: the guests via
 * `DEMO_STIMMEN_AB`, the host via `RAVEN_VOICE_EPOCH` here. Both containers
 * run on the same host, so they share the clock, and it does not matter which
 * browser opens its microphone first. The film carries no sound; the voices
 * are there for the speaking indicators, which only light on real audio.
 *
 * THE GUEST'S HAND IS AN ANSWER, NOT A TIMER. The guest tool raises Sven's
 * hand 2.5 s after the host's reaction reaches his page. The script waits for
 * that badge instead of guessing when it comes.
 *
 * NO RECORDING. The red recording frame belongs to the scene "the recording
 * starts by itself" (`raven-auto-aufnahme.ts`); here it would say a second
 * thing and put a ring over the grid this scene is about. It would also leave
 * a meeting with a transcript in the demo workspace to clean up.
 *
 * NO FIXED CLOCK. A room shows no relative dates, and pinning `Date` under a
 * live WebRTC call only risks timers the call depends on.
 *
 * "NICHT ANGEMELDET". The guests' tiles carry that badge. It is correct
 * product behaviour (flow.raven #5081, `unverified-identity-badge.tsx`): a
 * guest who only typed a name is marked for the host. It sits inside the name
 * pill, so no crop removes it without cutting the names; it stays in.
 *
 * PRECONDITIONS, per device (each device needs its own fresh room, because
 * the script ends the room at the end):
 *
 *   1. A room created with the demo account (`POST /api/meet/create-room`).
 *      `RAVEN_ROOM_LINK` = its host link (full URL), `RAVEN_ROOM_NAME` = its
 *      name with the tenant prefix.
 *   2. The guest tool is started against that room with the same epoch. The
 *      guests wait on "waiting for the host" until this script joins.
 *   3. The persona files exist (defaults under `artifacts/.media/`, which is
 *      ignored by git): `RAVEN_HOST_CAMERA` (Y4M), `RAVEN_HOST_VOICE` (WAV).
 *
 * INVOCATION (GPU host)::
 *
 *     RAVEN_ROOM_LINK=… RAVEN_ROOM_NAME=… RAVEN_VOICE_EPOCH=<epoch ms> \
 *     FEATURECAST_BOX_ENV=RAVEN_ROOM_LINK,RAVEN_ROOM_NAME,RAVEN_VOICE_EPOCH \
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-live-meeting.ts --devices iphone
 */

const GASTGEBERIN = 'Marlene Ostwald'
const GAESTE = ['Ayla Demirci', 'Sven Kowalczyk', 'Deniz Aktas'] as const
/** The guest whose hand answers the host's reaction (guest tool: `DEMO_HAND`). */
const HAND_GAST = 'Sven Kowalczyk'

/** Bottom-bar controls (`raise-hand-button.tsx`, `reactions/reactions-toggle.tsx`). */
const HAND_HEBEN = 'role=button[name="Hand heben"]'
const REAGIEREN = 'role=button[name="Reagieren"]'
/** One of the eight reactions (`reactions/types.ts`). Applause suits a status round. */
const APPLAUS = 'role=button[name="Applaus"]'

const IM_RAUM = '[data-testid="meeting-leave-button"]'
const KAMERA = 'button[data-lk-source="camera"]'
const MIKROFON = 'button[data-lk-source="microphone"]'
const NAME = 'input.lk-username-input, input[placeholder*="Name" i]'

function kachel(name: string): string {
  return `.lk-participant-tile:has(.lk-participant-name:text-is("${name}"))`
}

/** The guest's hand, on his tile (`raised-hands-badge.tsx`). */
const GAST_HAND = `${kachel(HAND_GAST)} [data-testid="raised-hand-tile-badge"] >> nth=0`

/** The top bar's count of raised hands; two = Marlene's and Sven's (`raised-hands-badge.tsx`). */
const ZWEI_MELDUNGEN =
  '[data-testid="raised-hands-badge"][title="2 Wortmeldungen"]'

/** The top bar's participant list and its queue of raised hands (`raised-hands-section.tsx`). */
const TEILNEHMER = 'role=button[name="Teilnehmerliste öffnen"]'
const GAST_MELDUNG = `[data-testid="raised-hand-row"]:has-text("${HAND_GAST}") >> nth=0`

/** How long the guests may take to be in the room once the host is. */
const GAESTE_FRIST_MS = 180_000

function pflicht(name: string): string {
  const wert = process.env[name]
  if (wert === undefined || wert === '') {
    throw new Error(
      `${name} is not set; see the header of demo/raven-live-meeting.ts.`,
    )
  }
  return wert
}

function epoche(): number | undefined {
  const roh = process.env.RAVEN_VOICE_EPOCH
  if (roh === undefined || roh === '') return undefined
  const ms = /^\d+$/.test(roh) ? Number(roh) : Date.parse(roh)
  if (!Number.isFinite(ms)) {
    throw new Error(`RAVEN_VOICE_EPOCH is neither epoch ms nor ISO: ${roh}`)
  }
  return ms
}

export const url = RAVEN_URL
export const devices = ['iphone', 'desktop-wide']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

const startsAt = epoche()
/** Marlene's face and voice; see the header, "ONE TIMELINE". */
export const fakeMedia = {
  camera: process.env.RAVEN_HOST_CAMERA ?? 'artifacts/.media/lena.y4m',
  microphone: {
    file:
      process.env.RAVEN_HOST_VOICE ?? 'artifacts/.media/Marlene Ostwald.wav',
    ...(startsAt === undefined ? {} : { startsAt }),
  },
}

/**
 * Joins the room as host and waits until all three guests are on screen, so
 * the first frame is a full grid and not a room filling up.
 */
export async function prepare(app: Frame): Promise<void> {
  const link = pflicht('RAVEN_ROOM_LINK')
  if (!link.startsWith(RAVEN_URL)) {
    throw new Error(`RAVEN_ROOM_LINK has to point at ${RAVEN_URL}.`)
  }
  pflicht('RAVEN_ROOM_NAME')

  // The bars are left at the product's default, NOT pinned the way the e2e
  // helper pins them. On a desktop they fade after four seconds without
  // pointer movement, so the opening grid shows all four name pills (pinned,
  // the bottom bar covers the lower-right one; first take, 2026-09-18), and
  // the pointer's travel to "Hand heben" brings them back. A raised hand then
  // keeps them up (`use-chrome-visibility.ts`). On a phone they only toggle on
  // a tap on the stage, so they stay up for the whole take either way.
  await app.goto(link)
  const beitreten = app.getByRole('button', { name: 'Raum beitreten' })
  await beitreten.waitFor({ state: 'visible', timeout: 30_000 })
  for (const quelle of [KAMERA, MIKROFON]) {
    const knopf = app.locator(quelle).first()
    await knopf.waitFor({ state: 'visible', timeout: 15_000 })
    if ((await knopf.getAttribute('aria-pressed')) === 'false')
      await knopf.click()
  }
  const name = app.locator(NAME).first()
  // Same hydration proof as flow.raven's `submitPrejoin`: a fill before
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

  for (const gast of GAESTE) {
    await app
      .locator(kachel(gast))
      .first()
      .waitFor({ state: 'visible', timeout: GAESTE_FRIST_MS })
  }
  // Video arrives a moment after the tile; give every face time to paint.
  await app.waitForTimeout(4000)
}

export default async function liveMeeting(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  // The grid: four named faces, whoever is talking lit.
  if (!page.hasTouch) {
    // The recorder opens by moving the cursor to the centre, which wakes the
    // bars; they fade four seconds after the last movement. Only then is the
    // name pill of the lower-right tile out from under the bottom bar
    // (second take, 2026-09-18), so the grid is held after the fade.
    await demo.hold(4500)
  }
  await demo.hold(3000)
  if (!page.hasTouch) {
    // Wake the bars before aiming at one of their buttons: a faded bar takes
    // no pointer events, so its button is not a target yet. A one-pixel
    // nudge of the real cursor where the recorder left it (the centre) and
    // back: the page sees movement, the film sees none. Pointing at a tile
    // instead cost 30 s: a live video tile never holds still long enough for
    // the recorder's settle check (third take, 2026-09-18).
    const mitte = page.viewportSize()
    if (mitte !== null) {
      const x = Math.round(mitte.width / 2)
      const y = Math.round(mitte.height / 2)
      await page.mouse.move(x + 1, y, { steps: 1 })
      await page.mouse.move(x, y, { steps: 1 })
    }
    await demo.hold(400)
  }

  // Her own hand.
  await ruhigKlicken(demo, HAND_HEBEN)
  await demo.hold(2500 - NACH_KLICK_MS)

  // A reaction: open the strip, send applause, let it float.
  await ruhigKlicken(demo, REAGIEREN)
  await ruhigKlicken(demo, APPLAUS)
  await demo.hold(2500 - NACH_KLICK_MS)

  // Sven answers with his hand (the guest tool, 2.5 s after the reaction).
  // Waited for on the top bar's queue count, not on his tile: the grid sorts
  // by who is speaking, and on a phone his tile may be on the other page
  // (second take, 2026-09-18: eight seconds of waiting until it came back).
  await warteAuf(page, ZWEI_MELDUNGEN, 15_000)
  if (page.hasTouch) {
    // On a phone the grid shows two tiles per page, and the bottom bar sits
    // over the lower tile's name pill, where the hand badge is (first take,
    // 2026-09-18: the badge was there and covered). The participant list
    // shows the same fact named: "Wortmeldungen", Marlene 1, Sven 2.
    await ruhigKlicken(demo, TEILNEHMER)
    await warteAuf(page, GAST_MELDUNG, 5000)
    await demo.hold(2000 - NACH_KLICK_MS)
  } else {
    await warteAuf(page, GAST_HAND, 5000)
    await demo.hold(2000)
  }

  // End the room for everyone, off camera in effect: the take stops here, and
  // the guest tool leaves when its pages see the room close.
  const raum = pflicht('RAVEN_ROOM_NAME')
  // A string payload: `evaluate` passes no arguments, and a compiled function
  // would carry tsx's `__name` into the page (docs/RECORDING-SCRIPTS.md).
  const body = JSON.stringify(JSON.stringify({ roomName: raum }))
  await page.evaluate(
    `fetch('/api/meet/end-room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${body} }).then(function (r) { return r.status })` as unknown as () => Promise<number>,
  )
}
