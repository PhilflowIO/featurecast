import type { CDPSession, Page } from 'playwright'

import type {
  ScreencastFrame,
  ScreencastStartResult,
  ScreencastTransport,
} from './capture.js'

/**
 * Drives Chromium's screencast over a raw CDP session instead of through
 * `page.screencast`.
 *
 * Why not the shortcut: Playwright's Chromium delegate sends exactly four
 * fields to `Page.startScreencast` — `format`, `quality`, `maxWidth`,
 * `maxHeight` — and `page.screencast.start()` accepts only `onFrame`, `path`,
 * `size` and `quality`. Current Chromium carries two further parameters on that
 * command, and the one this project needs (`maxFramesInFlight`) decides how
 * many frames the browser will hand out before it starts dropping them.
 * Measured: it is worth 11.1 points of capture yield and it is what makes the
 * yield reproducible at all (`docs/CAPTURE-CADENCE.md`, "Which half of the
 * patch earns the yield"). Through the shortcut it cannot be reached at any
 * browser version, so the shortcut has to go.
 *
 * Everything else about this module exists to hold two guarantees that the
 * shortcut used to hold for us.
 */

/** Chromium's screencast frame event, narrowed to the fields we read. */
type ScreencastFramePayload = {
  data: string
  metadata: {
    deviceHeight?: number
    deviceWidth?: number
    timestamp?: number
  }
  sessionId: number
}

export type CdpScreencastOptions = {
  /**
   * A CDP session to drive the screencast on. Defaults to a session of its
   * own — deliberately not the one `src/session.ts` opens for input, so that
   * frames and acknowledgements do not queue behind mouse and touch commands
   * during a recording.
   */
  openSession?: (page: Page) => Promise<CDPSession>
}

/**
 * Asks a running browser whether it knows `maxFramesInFlight`.
 *
 * Not by version number: `src/browser.ts` records why that witness is
 * unusable — a patched and an unpatched build report the same version string,
 * and attributing a measurement to the wrong one has already cost this project
 * three days. Not by reading the protocol definition either: that lives on the
 * browser's DevTools HTTP endpoint, and Playwright launches Chromium over a
 * pipe rather than a port, so there is no endpoint to read.
 *
 * What is left is to ask the command itself. A browser that knows the
 * parameter validates it and rejects zero; a browser that does not know it
 * ignores the field entirely and starts a screencast. Measured against
 * Chrome for Testing 153.0.8010.47 and 154.0.8037.0 on 2026-09-17:
 *
 * | sent                      | 153      | 154                                   |
 * | ------------------------- | -------- | ------------------------------------- |
 * | `maxFramesInFlight: 12`   | resolves | resolves                              |
 * | `maxFramesInFlight: 0`    | resolves | rejects, "must be a positive integer" |
 * | `maxFramesInFlight: "x"`  | resolves | rejects, "Invalid parameters"         |
 * | a parameter that does not exist | resolves | resolves                        |
 *
 * The last row is what makes the probe sound rather than lucky: 153 swallows
 * anything it does not recognise, so a rejection can only come from a browser
 * that recognises this one.
 *
 * On a browser without the parameter the probe does start a screencast, at two
 * pixels square and for as long as it takes to stop it again.
 */
export async function supportsFramesInFlight(
  cdp: CDPSession,
): Promise<boolean> {
  try {
    await cdp.send(
      'Page.startScreencast' as never,
      {
        format: 'jpeg',
        maxFramesInFlight: 0,
        maxHeight: 2,
        maxWidth: 2,
        quality: 1,
      } as never,
    )
  } catch {
    return true
  }
  await cdp.send('Page.stopScreencast')
  return false
}

/** `Page.startScreencast` wants even edge lengths; so did Playwright. */
function evenEdge(value: number): number {
  return value & ~1
}

/**
 * Opens a screencast transport for `page`.
 *
 * The returned transport is single-use: `start` may be called once, and
 * `detach` releases the session whether or not `stop` ran.
 */
export async function openCdpScreencast(
  page: Page,
  options: CdpScreencastOptions = {},
): Promise<ScreencastTransport> {
  const openSession =
    options.openSession ??
    ((target: Page): Promise<CDPSession> =>
      target.context().newCDPSession(target))
  const cdp = await openSession(page)
  let stopping = false
  let detached = false

  return {
    async detach(): Promise<void> {
      if (detached) return
      detached = true
      try {
        await cdp.detach()
      } catch {
        // A session whose page or browser is already gone is not a failure
        // of the capture that used it.
      }
    },

    async start({
      framesInFlight,
      onError,
      onFrame,
      quality,
      size,
    }): Promise<ScreencastStartResult> {
      const supported = await supportsFramesInFlight(cdp)

      // Subscribe before starting, or the first frame is delivered into
      // nothing. Playwright has the same ordering.
      cdp.on('Page.screencastFrame', (payload: ScreencastFramePayload) => {
        // ACKNOWLEDGE FIRST, before anything else in this handler.
        //
        // Chromium stops sending frames once too many are unacknowledged —
        // that limit is the whole reason this module exists — so the ack is
        // the one thing that must never wait for our own work. It waits for
        // nothing here: not for the base64 decode, not for the metadata
        // check, not for the write queue.
        //
        // This is strictly faster than the path it replaces. Playwright acks
        // from the continuation of whatever `onFrame` returns, which for us
        // meant a microtask, a client IPC hop and a dispatcher round trip
        // before `Page.screencastFrameAck` went out. The previous version of
        // this code had a long comment explaining how to avoid making that
        // path any slower (return nothing from `onFrame`, never await a
        // write); that advice is now structural rather than a convention to
        // remember.
        //
        // A frame that is acknowledged and then fails to enqueue is fine: the
        // only way it fails is the queue-overflow guard, which aborts the
        // whole capture anyway.
        void cdp
          .send('Page.screencastFrameAck', { sessionId: payload.sessionId })
          .catch((error: unknown) => {
            if (stopping) return
            // Before the stop, an ack that does not arrive silences the
            // source: the browser waits for a permission that never comes and
            // the recording ends up quietly half-empty. Playwright sends this
            // through `_sendMayFail` and cannot tell the two cases apart; we
            // can, so we do.
            onError(
              error instanceof Error
                ? new Error(
                    `Screencast frame could not be acknowledged: ${error.message}`,
                  )
                : new Error(
                    `Screencast frame could not be acknowledged: ${String(error)}`,
                  ),
            )
          })

        const frame = decodeScreencastFrame(payload)
        if (frame instanceof Error) {
          onError(frame)
          return
        }
        onFrame(frame)
      })

      // `maxFramesInFlight` is not in the protocol types Playwright ships
      // (they are generated from the Chromium it bundles, which does not have
      // it yet), so the parameters go through untyped. Precedent for the same
      // cast: `src/presented.ts`.
      await cdp.send(
        'Page.startScreencast' as never,
        {
          format: 'jpeg',
          maxHeight: evenEdge(size.height),
          maxWidth: evenEdge(size.width),
          quality,
          ...(supported ? { maxFramesInFlight: framesInFlight } : {}),
        } as never,
      )
      return { framesInFlight: supported ? framesInFlight : null }
    },

    async stop(): Promise<void> {
      stopping = true
      await cdp.send('Page.stopScreencast')
    },
  }
}

/**
 * Turns Chromium's wire shape into the frame the capture writer expects, or
 * returns the error that makes this frame unusable.
 *
 * Three conversions, each of which has exactly one right answer:
 *
 * - `data` arrives base64-encoded and has to be decoded byte-exactly.
 * - `metadata.timestamp` is seconds since the epoch; the manifest, and
 *   everything that reads it, is in milliseconds.
 * - the viewport comes from `metadata.deviceWidth`/`deviceHeight`, i.e. from
 *   the frame that was actually delivered — never from the size that was
 *   ordered, or `validateCaptureManifest`'s geometry check could never fire
 *   again.
 *
 * And one deliberate departure from Playwright: it falls back to `Date.now()`
 * when a frame carries no timestamp. We refuse the frame instead.
 * `manifest.frames[].timestamp` is the axis `src/efficiency.ts` counts
 * presentation instants against and that `validateCaptureManifest` requires to
 * increase strictly; silently mixing an arrival clock into it would corrupt
 * every number derived from the manifest without anything looking wrong.
 */
export function decodeScreencastFrame(
  payload: ScreencastFramePayload,
): Error | ScreencastFrame {
  const { deviceHeight, deviceWidth, timestamp } = payload.metadata
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return new Error(
      'Screencast frame arrived without a capture timestamp; refusing to substitute an arrival clock',
    )
  }
  if (
    deviceWidth === undefined ||
    deviceHeight === undefined ||
    !Number.isFinite(deviceWidth) ||
    !Number.isFinite(deviceHeight)
  ) {
    return new Error('Screencast frame arrived without viewport dimensions')
  }
  return {
    data: Buffer.from(payload.data, 'base64'),
    timestamp: timestamp * 1000,
    viewportHeight: deviceHeight,
    viewportWidth: deviceWidth,
  }
}
