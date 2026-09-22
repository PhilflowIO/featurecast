import { fileURLToPath } from 'node:url'

import type { Demo, RecordPage } from '../src/record.js'
import {
  anmelden,
  RAVEN_ALLOW_FRAMING,
  RAVEN_FIXED_TIME,
  RAVEN_HIDE_SELECTORS,
  RAVEN_LOCALE,
  RAVEN_STATE,
  RAVEN_URL,
  vorbereiten,
  warteAuf,
} from './raven-common.js'

/**
 * The settings motion, filmed so it can be judged instead of described.
 *
 * NOT a product film. Nobody should ever publish this: it exists to answer one
 * question — what does a viewer actually see between clicking a settings entry
 * and the page being there. Phil's verdict on staging was that it looks bad,
 * and a verdict on motion cannot be checked by reading a diff.
 *
 * WHAT IS BEING FILMED, AND WHAT IS NOT. Staging runs Raven's `dev` branch, so
 * this films the state BEFORE the query cache (#7441): every settings page
 * fetches its data after mount, and the motion therefore runs over an empty
 * frame. Whether the motion itself is also wrong is a separate question, and
 * the only one this recording can answer — the data half is already fixed on a
 * branch.
 *
 * WHY THE POINTER ONLY ARRIVES AND CLICKS. Any hold ON an entry before the
 * click would be a hover, and hover is exactly what the fix turns into a head
 * start. Filming a hover here would measure the fix, not the state of staging.
 * The pointer therefore moves and clicks in one go, the way an impatient
 * person does it.
 *
 * INVOCATION::
 *
 *     RAVEN_DEMO_EMAIL=… RAVEN_DEMO_PW=… \
 *         pnpm exec tsx demo/raven-einstellungen-bewegung.ts anmelden
 *     pnpm featurecast run demo/raven-einstellungen-bewegung.ts --devices desktop-wide \
 *         --out artifacts/raven-einstellungen-bewegung-<datum>
 *
 * The dated `--out` is not decoration: without it the run writes to
 * `artifacts/raven-einstellungen-bewegung` and overwrites the previous
 * recording, which is the one the next is compared against.
 */

export const url = RAVEN_URL
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const fixedTime = RAVEN_FIXED_TIME
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING
export const locale = RAVEN_LOCALE

/** The map on the desktop shell. Both shells draw it under this name. */
const KARTE = 'nav[aria-label="Einstellungsbereiche"]'

/**
 * The entries that are visited, in the order a person would wander through
 * them. Each is a different SHAPE of page — a form, a list of connections, a
 * set of switches — so the motion is seen carrying different weights rather
 * than the same one four times.
 */
const STATIONEN = [
  '/settings/sicherheit',
  '/settings/integrations',
  '/settings/meetings',
  '/settings/notifications',
  '/settings/profile',
] as const

/**
 * Opens the profile with the map beside it before the camera rolls, so the
 * clip does not open on a white page and the first transition filmed is
 * already a real one.
 */
export const prepare = vorbereiten('/settings/profile', KARTE)

/**
 * The body of the recording, shared by this script and its hover twin
 * (`raven-einstellungen-bewegung-hover.ts`). The two differ in one thing only:
 * how long the pointer rests on an entry before it clicks.
 *
 * WHY TWO ENTRY FILES AND NOT ONE WITH A SWITCH. `featurecast run` names the
 * output directory after the script's file name (`artifacts/<script name>`,
 * `src/cli.ts`). One file with a flag would write both variants into the same
 * directory, and the second run would overwrite the first recording — the very
 * comparison the two exist for. So each variant keeps a file of its own, and
 * only the body is shared.
 *
 * `hoverMs` of 0 means no rest at all: not even a zero-length hold is issued,
 * so the pointer arrives and clicks in one go.
 */
export function aufnahme({
  hoverMs,
}: {
  hoverMs: number
}): (page: RecordPage, demo: Demo) => Promise<void> {
  return async (page, demo) => {
    // A beat on the starting page, so the first transition has something to
    // be a transition FROM.
    await demo.hold(900)

    for (const ziel of STATIONEN) {
      const eintrag = `${KARTE} a[href="${ziel}"]`
      await demo.point(eintrag)
      if (hoverMs > 0) {
        // Hover variant: rest on the entry so the prefetch (#7441) gets its
        // head start.
        await demo.hold(hoverMs)
      }
      // Without a rest this is arrive-and-click: see the header on why a hover
      // would film the fix rather than the state.
      await demo.click(eintrag)
      // Long enough that the whole arrival is on camera — the empty frame, the
      // placeholder if one appears, the content landing, and the motion that
      // carries all three.
      await demo.hold(2600)
    }

    await warteAuf(page, 'h1')
    await demo.hold(800)
  }
}

export default aufnahme({ hoverMs: 0 })

// The sign-in only; the recording runs through `featurecast run`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [schritt] = process.argv.slice(2)
  if (schritt === 'anmelden') {
    await anmelden()
  } else {
    throw new Error(
      'Usage: tsx demo/raven-einstellungen-bewegung.ts anmelden — the ' +
        'recording runs through featurecast run',
    )
  }
}
