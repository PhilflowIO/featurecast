import type { DeviceSpec } from '../src/devices.js'

/**
 * Product film, scene M3 "Dein eigener Videoraum", filmed again for LANDSCAPE
 * in a browser window a viewer can read.
 *
 * WHY A SECOND FILE AND NOT A SECOND DEVICE IN `raven-videoraum.ts`. The scene
 * is the same down to the last hold — this file re-exports it and changes one
 * thing, the window. But `tools/gpu-box/record.sh` files a take under the
 * script's name, clears that directory on the host and mirrors it back with
 * `rsync --delete`. A second device in the old script would therefore have
 * deleted the `desktop-wide` and `iphone` takes the film is cut from, and
 * every render beside them. A script of its own lands in
 * `artifacts/raven-videoraum-quer/` and touches nothing that exists.
 *
 * WHY THE WINDOW IS NARROWER. Every desktop preset records 2560x1600 CSS
 * pixels, because the zoom needs room to push in (`DESKTOP_CAPTURE_SIZE` in
 * `src/devices.ts`). This scene never pushes in — it is shown whole — and in a
 * whole 2560 px frame Raven's recording notice is unreadable once the film
 * scales it to 1080p: the red ring around the stage is 3 px on the picture's
 * edge and the sentence "Dieses Meeting wird aufgezeichnet und KI-gestützt
 * transkribiert und zusammengefasst" stands 10-13 px tall. The film worked
 * around it by padding the phone take into 16:9, which left two thirds of the
 * frame empty. At 1280x800 the same interface is twice as large in the
 * picture; the screencast records CSS pixels whatever the density
 * (`src/session.ts`), so the window's size IS the lever.
 *
 * 16:10 and not 16:9, like `desktop-wide` itself: a 16:9 cut drops 40 px top
 * and bottom, and the ring sits exactly there. The film letterboxes or scales
 * the whole frame instead.
 *
 * NO ZOOM ROOM, ON PURPOSE. Capture and output are the same rectangle, so the
 * renderer clamps every push-in to 1.00x. Render it flat
 * (`--formats 1280x800 --zoom 1`), with and without the pointer.
 *
 * Preconditions, media and the clean-up afterwards are those of
 * `demo/raven-videoraum.ts`; read its header first.
 *
 * INVOCATION (GPU host)::
 *
 *     RAVEN_ROOM_LINK=… FEATURECAST_BOX_ENV=RAVEN_ROOM_LINK \
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-videoraum-quer.ts
 */

export * from './raven-videoraum.js'
export { default } from './raven-videoraum.js'

/** The one difference: a window of 1280x800, filed under its own name. */
export const devices: readonly DeviceSpec[] = [
  {
    as: 'desktop-quer',
    capture: { height: 800, width: 1280 },
    extends: 'desktop-wide',
    output: { height: 800, width: 1280 },
  },
]
