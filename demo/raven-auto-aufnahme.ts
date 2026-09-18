import type { Demo, RecordPage } from '../src/record.js'
import {
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
 * NOT YET RUNNABLE. The consent gate and the automatic start are
 * `flow.raven` PR #6950 (branch `feat/recording-starts-with-the-first-guest`,
 * issue #6942), which is not on staging yet. Every selector below was read
 * from that branch, not from a running page. The first real run is also the
 * first check of the selectors.
 *
 * PRECONDITIONS, IN THIS ORDER. Each one is a way to film the wrong thing
 * without any error:
 *
 *   1. As an owner or admin of the workspace, switch on "record meetings
 *      automatically" (the workspace flag `auto_recording_enabled`,
 *      `PUT /api/settings/flags/auto_recording_enabled`). The default is off.
 *   2. Create the room AFTER that. A room freezes the answer when it is
 *      created (`autoRecord` on the room row), so a room made before the switch
 *      never asks for consent and never records by itself. The film would then
 *      show a guest walking into an ordinary meeting.
 *   3. The host is already in the room. Without a host a guest lands in the
 *      waiting screen (the 425 "no host yet" answer), and the recording starts
 *      only when the first guest who is not the host arrives
 *      (`_maybe_autostart_recording`, `api/app/routers/livekit.py` on the
 *      branch). The host's display name appears on the host's tile, so the
 *      host joins under a demo identity and not under a real account.
 *   4. `RAVEN_ROOM_LINK` holds the guest invitation link of that room. It is
 *      the full link as the host copies it, including any token in it.
 *
 * NO SESSION, ON PURPOSE. The guest is a stranger with no account, which is
 * the case the consent gate is for. Without a `storageStatePath` the chain
 * opens a context without cookies. It also keeps the host's account out of
 * the picture.
 *
 * WHAT THE SCRIPT DOES NOT DO: it never opens the user menu, and it never
 * scrolls sideways (capture yield).
 *
 * UNPROVEN: whether the pre-join screen lets a browser without a camera and
 * microphone join. The chain grants no media permissions today. If the join
 * button stays disabled after the tick, that is the first thing to check.
 *
 * INVOCATION::
 *
 *     RAVEN_ROOM_LINK='https://staging.raven.ceo/meet/…' \
 *         pnpm featurecast run demo/raven-auto-aufnahme.ts
 */

/** An invented name. It is what the other participants see on the guest's tile. */
const GAST_NAME = process.env.RAVEN_GUEST_NAME ?? 'Jonas Brandt'

/**
 * The agreement box. Its `data-testid` comes from the branch
 * (`ui/src/app/meet/[roomName]/meeting-room.tsx`, #6942).
 */
const EINWILLIGUNG = '[data-testid="prejoin-consent-checkbox"]'

/** The whole agreement block, to point at before ticking it. */
const EINWILLIGUNG_BLOCK = '[data-testid="prejoin-consent-gate"]'

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
 * It is read when the recording starts and not when the module is loaded, so
 * that the chain's checks of the exports, which only import this file, do not
 * need a room.
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

export default async function autoAufnahme(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await page.goto(einladung())
  // The agreement block, not the name field. The field is there in a room that
  // does not record itself too. If the block never appears, precondition 1 or
  // 2 is missing, and the run should stop here instead of filming an ordinary
  // join.
  await warteAuf(page, EINWILLIGUNG_BLOCK)
  await demo.hold(1200)

  await demo.type(NAME, GAST_NAME)
  await demo.hold(600)
  // Point at the still disabled button first: a name alone no longer opens the
  // room, and that is half of what this clip shows.
  await demo.point(BEITRETEN)
  await demo.hold(900)

  await demo.point(EINWILLIGUNG_BLOCK)
  await demo.hold(1400)
  await demo.click(EINWILLIGUNG)
  await demo.hold(700)
  await demo.click(BEITRETEN)

  // Getting in is a LiveKit connection, not a page load, so the wait is long.
  await warteAuf(page, IM_RAUM, 60_000)
  // Nobody presses record. The first guest's arrival starts it: webhook,
  // claim, recording-manager. The e2e spec on the branch allows 90 s.
  await warteAuf(page, AUFNAHME_LAEUFT, 90_000)
  await demo.hold(3000)
}
