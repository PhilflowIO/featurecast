import type { Frame } from 'playwright'

import type { DeviceSpec } from '../src/devices.js'
import type { Demo, RecordPage } from '../src/record.js'
import {
  gaesteBeitreten,
  gaesteVerlassen,
  prepare as gastgeberinTrittBei,
  default as videoraum,
} from './raven-videoraum.js'

/**
 * Product film, scene M3 "Dein eigener Videoraum", filmed a third time — in
 * the readable 1280x800 window of `raven-videoraum-quer.ts`, AND WITH OTHER
 * PEOPLE IN THE ROOM.
 *
 * WHY THIS EXISTS. The take of 2026-09-21 is right in every way but one: at
 * about 31 s the top bar reads "Teilnehmer 0", legibly, at exactly the moment
 * the film says the recording notice is visible "für alle". A room with
 * nobody in it does not merely fail to support that sentence, it contradicts
 * it. Cropping the number away is not open either — the number sits inside
 * the red ring, and the red ring IS the notice, so any crop that removes the
 * one removes an edge of the other.
 *
 * WHAT CHANGED, AND WHAT DID NOT. Two guests join before the camera rolls;
 * everything else is the scene as shot: the same window, the same beat on
 * "Bildschirm teilen", the same "Aufnehmen", the same nine seconds of
 * unbroken red ring. The guests keep their cameras off — the film shows no
 * faces, and inventing four of them was never the fix.
 *
 * TWO AND NOT ONE. The header counts everybody except the person looking at
 * it, so one guest reads "Teilnehmer 1". See `gaesteBeitreten` in
 * `raven-videoraum.ts` for the source of that count.
 *
 * WHY A FILE OF ITS OWN, AGAIN. `tools/gpu-box/record.sh` files a take under
 * the script's name and mirrors that directory back with `rsync --delete`.
 * Re-recording `raven-videoraum-quer.ts` would therefore delete the take the
 * film is cut from today, before it is known whether this one is better.
 *
 * PRECONDITIONS are those of `demo/raven-videoraum.ts` — read its header —
 * plus one: `RAVEN_ROOM_NAME`, the TENANT-PREFIXED name of the same room
 * `RAVEN_ROOM_LINK` points at. The guests' invites are minted through the
 * host's session, which needs it.
 *
 * INVOCATION (GPU host)::
 *
 *     RAVEN_ROOM_LINK=… RAVEN_ROOM_NAME=… \
 *     FEATURECAST_BOX_ENV=RAVEN_ROOM_LINK,RAVEN_ROOM_NAME \
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-videoraum-quer-zu-zweit.ts
 *
 * RENDER::
 *
 *     pnpm render artifacts/raven-videoraum-quer-zu-zweit/desktop-quer \
 *         artifacts/raven-videoraum-quer-zu-zweit/desktop-quer-flat-ohne-zeiger \
 *         --formats 1280x800 --zoom 1 --idle-threshold 600000 --no-cursor
 */

export {
  allowFramingOfApp,
  fakeMedia,
  hideSelectors,
  locale,
  storageStatePath,
  url,
} from './raven-videoraum.js'

/** The window of the landscape re-shoot, filed under its own name. */
export const devices: readonly DeviceSpec[] = [
  {
    as: 'desktop-quer',
    capture: { height: 800, width: 1280 },
    extends: 'desktop-wide',
    output: { height: 800, width: 1280 },
  },
]

/**
 * The host joins first, then the guests.
 *
 * The order is not taste. The LiveKit room is created lazily by the HOST's
 * join (`connection-details` in `flow.raven`); a guest who arrives before her
 * is answered with 425 and parks on the "waiting for the host" screen.
 */
export async function prepare(app: Frame): Promise<void> {
  await gastgeberinTrittBei(app)
  await gaesteBeitreten(app)
}

export default async function videoraumZuZweit(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  try {
    await videoraum(page, demo)
  } finally {
    // Closed whatever happened: two browsers left running would keep the room
    // populated for the next take and hold their sockets open.
    await gaesteVerlassen()
  }
}
