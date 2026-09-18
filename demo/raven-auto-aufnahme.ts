import type { Frame } from 'playwright'

import type { Demo, RecordPage } from '../src/record.js'
import {
  RAVEN_ALLOW_FRAMING,
  RAVEN_FIXED_TIME,
  RAVEN_HIDE_SELECTORS,
  RAVEN_URL,
  warteAuf,
} from './raven-common.js'

/**
 * "The recording starts by itself": a guest opens a room invitation, agrees to
 * the recording, joins, and the recording starts without anybody pressing
 * anything.
 *
 * The consent gate and the automatic start are `flow.raven` PR #6950; the
 * one-sentence consent that names the workspace is PR #7175, and the single
 * notice in consent rooms is PR #7179. The selectors below were read from
 * `flow.raven` `dev` after all three were merged, and first run against
 * staging on 2026-09-18.
 *
 * PRECONDITIONS, IN THIS ORDER. Each one is a way to film the wrong thing
 * without any error:
 *
 *   1. As an owner or admin of the workspace, switch on "record meetings
 *      automatically" (the workspace flag `auto_recording_enabled`,
 *      `PUT /api/settings/flags/auto_recording_enabled` with
 *      `{"value": true}`). The default is off; switch it back afterwards.
 *   2. Create the room AFTER that (`POST /api/meet/create-room`). A room
 *      freezes the answer when it is created, so a room made before the switch
 *      never asks for consent and never records by itself. The film would then
 *      show a guest walking into an ordinary meeting.
 *   3. The host is already in the room, in a second browser that stays open
 *      for the whole recording. Without a host a guest lands in the waiting
 *      screen, and the recording starts only when the first participant who
 *      is not the host arrives. The host's display name is on the host's
 *      tile, so it is the demo persona, not a real person. Camera off, or the
 *      tile shows Chromium's green test picture.
 *   4. `RAVEN_ROOM_LINK` holds the guest invitation link of that room, the
 *      full address with its token.
 *   5. Nobody else has joined that room yet. The first guest starts the
 *      recording; a room that already records films no start.
 *
 * NO SESSION, ON PURPOSE. The guest is a stranger with no account, which is
 * the case the consent gate is for. It also keeps the host's account out of
 * the picture.
 *
 * WHAT THE SENTENCE NAMES. The consent sentence carries the workspace's name
 * ("Ich willige ein, dass <Arbeitsbereich> dieses Meeting …"). That name is
 * in the video, so the room has to belong to a demo workspace, never to a
 * customer's.
 *
 * WHAT THE SCRIPT DOES NOT DO: it never opens the user menu, and it never
 * scrolls sideways (capture yield).
 *
 * INVOCATION::
 *
 *     RAVEN_ROOM_LINK='https://staging.raven.ceo/meet/…?t=…&e=…' \
 *         pnpm featurecast run demo/raven-auto-aufnahme.ts
 */

/** An invented name. It is what the other participants see on the guest's tile. */
const GAST_NAME = process.env.RAVEN_GUEST_NAME ?? 'Jonas Brandt'

/** The agreement box. */
const EINWILLIGUNG = '[data-testid="prejoin-consent-checkbox"]'

/**
 * The sentence the guest agrees to. Waited for in `prepare`: it is filled
 * from the room lookup and is the last part of the card to arrive.
 */
const EINWILLIGUNG_SATZ = '[data-testid="prejoin-consent-text"]'

/**
 * The camera switch on the pre-join card (LiveKit's `TrackToggle`).
 * `aria-pressed="true"` means the camera is on.
 */
const KAMERA = 'button[data-lk-source="camera"]'

/** The name field on the pre-join card. */
const NAME = '#username'

/** The join button. It stays disabled until the box is ticked. */
const BEITRETEN = 'role=button[name="Raum beitreten"]'

/** Proof of being in the room: the control bar's leave button. */
const IM_RAUM = '[data-testid="meeting-leave-button"]'

/**
 * The room-wide recording notice: a red ring around the stage
 * (`ui/src/components/meet/recording-indicator.tsx`). It exists as `off`
 * before the recording starts, so only `on` counts.
 */
const AUFNAHME_LAEUFT = '[data-recording-notice="on"]'

/**
 * The link from the environment, checked before the first frame.
 *
 * It is read when the recording is prepared and not when the module is
 * loaded, so that the chain's checks of the exports, which only import this
 * file, do not need a room.
 */
function einladung(): string {
  const link = process.env.RAVEN_ROOM_LINK
  if (link === undefined || link === '') {
    throw new Error(
      'RAVEN_ROOM_LINK has to hold the guest invitation link of a room that ' +
        'was created AFTER automatic recording was switched on (see the ' +
        'header of demo/raven-auto-aufnahme.ts).',
    )
  }
  if (!link.startsWith(RAVEN_URL)) {
    throw new Error(
      `RAVEN_ROOM_LINK has to point at ${RAVEN_URL}; it points elsewhere.`,
    )
  }
  return link
}

/** The application that is filmed. */
export const url = RAVEN_URL

/** The pre-join card and the room are filmed on the desktop. */
export const devices = ['desktop-wide']

/** The shared list; see `raven-common.ts`. */
export const hideSelectors = RAVEN_HIDE_SELECTORS

/** A fixed clock, so nothing time-dependent moves between two runs. */
export const fixedTime = RAVEN_FIXED_TIME

/**
 * Raven forbids framing; the phone is filmed through a frame. See
 * `RAVEN_ALLOW_FRAMING` in `raven-common.ts`.
 */
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

/**
 * A synthetic camera and microphone, already permitted. Without them the
 * recording browser has no media, and the pre-join card opens with a red
 * "Du bist ohne Kamera und Mikrofon dabei" banner above everything else
 * (observed on staging, 2026-09-18). No guest with a working browser sees
 * that.
 */
export const fakeMedia = true

/**
 * Opens the invitation before the camera rolls, so the clip starts on the
 * join card and not on a white page. Not `vorbereiten` from
 * `raven-common.ts`: that takes a path, and this link carries its own token
 * and comes from the environment.
 *
 * It waits for the consent SENTENCE, not for the name field: the field is
 * there in a room that does not record itself too. If the sentence never
 * appears, precondition 1 or 2 is missing, and the run stops here instead of
 * filming an ordinary join.
 *
 * Then it switches the camera off. The synthetic camera paints a green test
 * picture into the preview, the largest thing on the card.
 */
export async function prepare(app: Frame): Promise<void> {
  await app.goto(einladung())
  await app
    .locator(EINWILLIGUNG_SATZ)
    .waitFor({ state: 'visible', timeout: 30_000 })
  const kamera = app.locator(KAMERA).first()
  await kamera.waitFor({ state: 'visible', timeout: 15_000 })
  if ((await kamera.getAttribute('aria-pressed')) === 'true') {
    await kamera.click()
  }
  await app
    .locator(`${KAMERA}[aria-pressed="false"]`)
    .first()
    .waitFor({ timeout: 15_000 })
}

export default async function autoAufnahme(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  // `prepare` has opened the card and seen the sentence. Long enough to read
  // it once before anything moves. The pointer stays where it is, in the
  // corner: pointed at, the block puts the pointer over its own text (the
  // first take covered "Mehr erfahren" for the whole of this hold).
  await demo.hold(3500)

  await demo.type(NAME, GAST_NAME)
  await demo.hold(600)
  // Point at the still disabled button: a name alone no longer opens the
  // room, and that is half of what this clip shows.
  await demo.point(BEITRETEN)
  await demo.hold(1500)

  await demo.click(EINWILLIGUNG)
  // Straight back to the button, which is enabled now. Left on the box, the
  // pointer covers the first letters of the sentence's second and third
  // line, and this is the moment the viewer reads what was agreed to.
  await demo.point(BEITRETEN)
  await demo.hold(2500)
  await demo.click(BEITRETEN)

  // Getting in is a LiveKit connection, not a page load, so the wait is long.
  await warteAuf(page, IM_RAUM, 60_000)
  // Nobody presses record. The first guest's arrival starts it: webhook,
  // claim, recording-manager. The e2e spec allows 90 s; measured on staging
  // on 2026-09-18: about 8 s from the click.
  await warteAuf(page, AUFNAHME_LAEUFT, 90_000)
  // The toast that names the recording stays five seconds; the ring stays.
  await demo.hold(5000)
}
