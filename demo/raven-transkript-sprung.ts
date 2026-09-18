import type { Demo, RecordPage } from '../src/record.js'
import {
  FILM_SCROLL_TEMPO,
  NACH_KLICK_MS,
  RAVEN_ALLOW_FRAMING,
  RAVEN_HIDE_SELECTORS,
  RAVEN_STATE,
  RAVEN_URL,
  STEINKAUZ_FIXED_TIME,
  STEINKAUZ_ID,
  inDieMitte,
  ruhigKlicken,
  vorbereitenBei,
  warteAuf,
} from './raven-common.js'

/**
 * Product film, scene S3 "Transkript-Sprung": the recording plays, a click on
 * one sentence in the middle of the transcript moves the player there, and the
 * highlight walks on with the speech.
 *
 * The meeting is the Steinkauz status round (`STEINKAUZ_ID`). The sentence is
 * Sven's "Einverstanden, wenn wir parallel einen zweiten Giesser anfragen."
 * at 1:19, segment 18 of 32. From there the highlight moves to 1:23 ("Ich will
 * nicht noch einmal an einem einzigen Lieferanten hängen.") after about four
 * seconds, and the page scrolls with it — measured on staging in the GPU
 * host's browser, both layouts.
 *
 * Timing constraint, not taste: Raven scrolls the transcript to the active
 * segment whenever it changes (`karaoke-transcript.tsx`, `scrollIntoView` on
 * `activeIndex`). The first segment starts at 0:11, so from "Abspielen" to the
 * click there are eleven seconds in which nothing scrolls on its own. The scene
 * therefore opens with the sentence already on screen, just below the middle,
 * and the scripted scroll before the click is short. Starting at the top of the
 * transcript would take 4000 px on a phone, and Raven would pull the page back
 * to 0:11 halfway through.
 *
 * Playback in the headless recording browser: the virtual clock is started by
 * the click on "Abspielen", a real input event, and the six media elements
 * follow it (all six unpaused and advancing, measured on the GPU host). No
 * autoplay flag is needed because the click is the user activation.
 *
 * The faces are not in this scene. Raven shows the video only in fullscreen
 * (`vod-grid-player`, #2357), and fullscreen covers the transcript the scene
 * is about. The sticky player bar with its moving waveform stays in frame.
 *
 * INVOCATION (GPU host, session copied over explicitly)::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-transkript-sprung.ts --devices desktop-wide,iphone
 */

/** The sentence that is clicked. Its own text, so the target never drifts. */
const SATZ = 'p:has-text("Einverstanden, wenn wir parallel") >> nth=0'

/** Proof that the click moved the player: the row is the active one. */
const SATZ_AKTIV =
  '[data-transcript-active="true"]:has-text("Einverstanden, wenn wir parallel")'

/** The play button in the sticky player bar. */
const ABSPIELEN = 'button[aria-label="Abspielen"] >> nth=0'

/** How long the highlight is filmed walking on after the click. */
const NACHLAUF_MS = 7000

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const fixedTime = STEINKAUZ_FIXED_TIME
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

/**
 * Opens the meeting with the sentence at 72 % of the height: on screen from
 * the first frame, and a short, visible scroll away from the middle.
 */
export const prepare = vorbereitenBei(`/meetings/${STEINKAUZ_ID}`, SATZ, 0.72)

export default async function transkriptSprung(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await demo.hold(1000)

  // The recording plays. `ruhigKlicken` holds 1.5 s after the click; half a
  // second more makes the two seconds of playback the shot list asks for.
  await ruhigKlicken(demo, ABSPIELEN)
  await demo.hold(2000 - NACH_KLICK_MS)

  // The sentence to the middle, then the jump.
  await inDieMitte(page, demo, SATZ, { tempo: FILM_SCROLL_TEMPO })
  await ruhigKlicken(demo, SATZ)
  // A take in which the click did not move the player shows nothing; abort it.
  await warteAuf(page, SATZ_AKTIV, 3000)
  await demo.hold(NACHLAUF_MS - NACH_KLICK_MS)
}
