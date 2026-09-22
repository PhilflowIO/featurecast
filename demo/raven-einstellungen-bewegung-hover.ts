import { aufnahme } from './raven-einstellungen-bewegung.js'

/**
 * The settings motion again, but with the pointer resting on each entry for
 * 600 ms before it clicks.
 *
 * NOT a product film, for the same reason as its twin
 * `raven-einstellungen-bewegung.ts`: it exists to be judged, not published.
 *
 * WHAT THIS ONE FILMS. The rest on the entry is a hover, and a hover is what
 * the query cache (#7441) turns into a head start: the settings page's data is
 * prefetched while the pointer rests, so the arrival can land on a filled
 * frame. This variant films that head start.
 *
 * WHY THE OTHER VARIANT EXISTS. Filming a hover measures the prefetch fix, not
 * the state of the page. The twin therefore arrives and clicks in one go, the
 * way an impatient person does it, and shows what a viewer sees without the
 * head start. The pair answers the question together; either one alone does
 * not.
 *
 * WHY A FILE OF ITS OWN. The body is shared (see `aufnahme` in the twin); only
 * the entry file is separate, because `featurecast run` names the output
 * directory after the script — one file with a switch would overwrite its own
 * recording.
 *
 * INVOCATION::
 *
 *     # the session is shared with every Raven script; sign in once with
 *     RAVEN_DEMO_EMAIL=… RAVEN_DEMO_PW=… \
 *         pnpm exec tsx demo/raven-einstellungen-bewegung.ts anmelden
 *     pnpm featurecast run demo/raven-einstellungen-bewegung-hover.ts \
 *         --devices desktop-wide \
 *         --out artifacts/raven-einstellungen-bewegung-hover-<datum>
 */

export {
  allowFramingOfApp,
  fixedTime,
  hideSelectors,
  locale,
  prepare,
  storageStatePath,
  url,
} from './raven-einstellungen-bewegung.js'

export default aufnahme({ hoverMs: 600 })
