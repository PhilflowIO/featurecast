import type { Demo, RecordPage } from '../src/record.js'
import {
  NACH_KLICK_MS,
  RAVEN_ALLOW_FRAMING,
  RAVEN_HIDE_SELECTORS,
  RAVEN_LOCALE,
  RAVEN_STATE,
  RAVEN_URL,
  STEINKAUZ_FIXED_TIME,
  STEINKAUZ_ID,
  VOR_KLICK_MS,
  imBild,
  jetztSichtbar,
  ruhigKlicken,
  vorbereitenBei,
  warteAuf,
} from './raven-common.js'

/**
 * Product film, scene M6 "Zusammenfassung direkt aus dem Meeting versenden":
 * the summary leaves the house by mail, and NOBODY TYPES AN ADDRESS.
 *
 * THE WHOLE SCENE IS THE ADDRESS BOOK. Two of the meeting's participants have
 * no address stored on their row; a tick on each sends Raven to the connected
 * contacts ("Email wird gesucht …") and the address stands under the name a
 * moment later. A third recipient who was not in the meeting at all is added
 * by typing THREE LETTERS and choosing a face from the list. If a full mail
 * address is ever typed on camera in this scene, the scene has lost its point
 * and should be re-shot, not re-cut.
 *
 * WHY NOTHING LEAVES THE HOUSE. Two independent guarantees, both measured
 * before this script was written (2026-09-21). Staging's API resolves
 * `SMTP_HOST=mailpit`, `SMTP_PORT=1025` — every mail it sends is sunk into the
 * Mailpit container on the staging box and reaches no mailbox. And every
 * address in this scene sits on `demo.raven.ceo`, a domain that does not exist
 * in DNS. Either one alone would be enough. Do NOT point this scene at an
 * account whose contacts carry reachable addresses.
 *
 * THE CONFIRMATION IS THE LAST BEAT, AND IT IS SHORT. `send-dialog.tsx` closes
 * the dialog two seconds after the green strip appears (`setTimeout(…, 2000)`),
 * so the green line is roughly two seconds long and nothing this script does
 * can stretch it. It is the last thing that happens on purpose: the film has a
 * stretch of silence after the narration, and the confirmation is what
 * resolves it.
 *
 * AFTER A TAKE. One mail per device lands in staging's Mailpit; there is
 * nothing to delete in Raven itself — the dialog writes no row. A
 * manually confirmed address WOULD be written back to the contacts
 * (`/api/contacts/sync`), which is the second reason this scene never types
 * one.
 *
 * INVOCATION (GPU host)::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-versenden.ts --devices desktop-wide,iphone
 *
 * RENDER (the two the film consumes)::
 *
 *     pnpm render artifacts/raven-versenden/desktop-wide \
 *         artifacts/raven-versenden/desktop-wide-flat-ohne-zeiger \
 *         --formats 2560x1600 --zoom 1 --idle-threshold 600000 --no-cursor
 *     pnpm render artifacts/raven-versenden/iphone \
 *         artifacts/raven-versenden/iphone-flat-ohne-zeiger \
 *         --formats 9:16 --zoom 1 --idle-threshold 600000 --no-cursor
 */

/** The filled primary under the summary (`send-dialog.tsx`, `DialogTrigger`). */
const VERSENDEN = 'role=button[name="Versenden"] >> nth=0'

/**
 * The open dialog, named by a line only it carries.
 *
 * Not `[role="dialog"]` alone: the meeting page mounts more than one dialog
 * component, and an ambiguous locator has no geometry for the recorder to
 * point at.
 */
const DIALOG = '[role="dialog"]:has-text("Alle auswählen")'

/**
 * A participant's row, addressed by the name written in it.
 *
 * The clickable element is the row `div`, not the checkbox — the checkbox
 * carries `role="checkbox"` with no accessible name at all
 * (`send-dialog.tsx`, `CustomCheckbox`), so there is nothing to name it by.
 * The row is the first `cursor-pointer` ancestor of the name span.
 */
function zeile(name: string): string {
  return (
    `span:text-is("${name}") >> ` +
    'xpath=ancestor::div[contains(@class,"cursor-pointer")][1]'
  )
}

/**
 * The two whose address Raven has to go and find.
 *
 * Both are participants of the Steinkauz round whose `participants` row holds
 * no email (measured on staging, 2026-09-21), and both ARE in the connected
 * address book — so the tick produces the lookup AND the answer. The host's
 * own row carries her address already and would show neither.
 */
const NACHSCHLAG = ['Sven Kowalczyk', 'Ayla Demirci'] as const

/** The field for somebody who was not in the meeting. */
const WEITERE = 'input[placeholder="name@firma.de"]'

/**
 * The letters that are typed. Three, and no more.
 *
 * The dropdown needs two (`emailInput.length < 2` in `send-dialog.tsx`) and
 * debounces for 300 ms. Three is one more than the product needs and still
 * unmistakably not an address — which is the sentence the scene is making.
 */
const BUCHSTABEN = 'Cla'

/**
 * The person picked from the list.
 *
 * Clara Wingert on purpose: she was NOT in the meeting, and she is the one
 * contact of this address book with a portrait photo, so the dropdown row
 * shows a face, a name and an address — the proof that this is an address
 * book and not an autocomplete over something typed earlier.
 */
const KONTAKT = 'Clara Wingert'

/** Her row in the dropdown (`send-dialog.tsx`, the suggestions list). */
const VORSCHLAG = `button:has(div:text-is("${KONTAKT}"))`

/** The send button. Its label counts the recipients, so it is matched loosely. */
const SENDEN = 'button:has-text("Empfänger senden")'

/** The green strip. `send-dialog.tsx` writes "An {n} Empfänger gesendet". */
const GESENDET = 'text=Empfänger gesendet'

/** Reading time on something the viewer is meant to actually read. */
const LESEZEIT_MS = 1800

/** How long a mail send may take before the take is called off. */
const SENDE_FRIST_MS = 60_000

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const fixedTime = STEINKAUZ_FIXED_TIME
export const locale = RAVEN_LOCALE
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING

/**
 * The meeting, opened with the summary above the fold and its "Versenden"
 * button already in the picture.
 *
 * `vorbereitenBei` and not `vorbereiten`: the button sits below a full summary
 * (y = 1715 in a 800 px window, measured on staging), and a scene that opens
 * on a scroll nobody asked for wastes its first four seconds. At 0.62 of the
 * height the summary above it is still what the frame is mostly made of, which
 * is the picture this scene needs to start on.
 */
export const prepare = vorbereitenBei(
  `/meetings/${STEINKAUZ_ID}`,
  VERSENDEN,
  0.62,
)

export default async function versenden(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  // The meeting with its summary, before anything happens to it.
  await demo.hold(1800)

  await imBild(page, demo, VERSENDEN)
  await ruhigKlicken(demo, VERSENDEN)
  await warteAuf(page, DIALOG, 20_000)
  // The pointer moves INTO the dialog before anything else. A scroll acts
  // where the pointer stands, and left on the trigger behind the overlay every
  // scroll below would move the page instead of the dialog (`raven-teilen.ts`).
  await demo.point(DIALOG)
  await demo.hold(1200)

  // ── The two addresses Raven goes and finds ───────────────────────────────
  for (const name of NACHSCHLAG) {
    await imBild(page, demo, zeile(name))
    await demo.point(zeile(name))
    await demo.hold(VOR_KLICK_MS)
    await demo.click(zeile(name))
    // The spinner is not waited for — it is 300 to 600 ms on staging and a
    // wait that misses it would abort a take over a frame. The ANSWER is the
    // proof, and that is what the take hangs on.
    await warteAufAdresse(page, name, 20_000)
    await demo.hold(NACH_KLICK_MS)
  }

  // ── The third recipient, who was not in the meeting ──────────────────────
  await imBild(page, demo, WEITERE)
  await demo.point(WEITERE)
  await demo.hold(VOR_KLICK_MS)
  await demo.type(WEITERE, BUCHSTABEN)
  await warteAuf(page, VORSCHLAG, 20_000)
  await imBild(page, demo, VORSCHLAG)
  await demo.point(VORSCHLAG)
  // The face, the name and the address, standing still long enough to be read
  // as an address book rather than as something that was typed.
  await demo.hold(LESEZEIT_MS)
  await demo.click(VORSCHLAG)
  await demo.hold(NACH_KLICK_MS)

  // ── Send, and hold on the confirmation ───────────────────────────────────
  await imBild(page, demo, SENDEN)
  await demo.point(SENDEN)
  // The button now counts three recipients and none of them was typed. Let it
  // be read before it is pressed.
  await demo.hold(LESEZEIT_MS)
  await demo.click(SENDEN)
  await warteAuf(page, GESENDET, SENDE_FRIST_MS)
  // Two seconds is all there is: the dialog closes itself on a 2 s timer.
  await demo.hold(2000)
  // And the page behind it, so the clip does not cut on a closing dialog.
  await demo.hold(1500)
}

/**
 * Waits until the participant's row carries a mail address.
 *
 * The row shows the found address under the name once the contacts answered
 * (`send-dialog.tsx`: `isChecked && effectiveEmail`). If the lookup comes back
 * empty the row instead opens a field reading "Email eingeben …" — the one
 * picture this scene must never contain — so a take in which it happened has
 * to end here rather than be noticed in the edit.
 */
async function warteAufAdresse(
  page: RecordPage,
  name: string,
  fristMs: number,
): Promise<void> {
  // The `@` is the whole test, and it is scoped to this participant's row —
  // `RecordPage` is a narrow surface with no `textContent`, and a page-wide
  // search for an address would pass on somebody else's.
  const adresse = `${zeile(name)} >> text=@ >> nth=0`
  const ende = Date.now() + fristMs
  for (;;) {
    if (await jetztSichtbar(page, adresse)) return
    if (Date.now() > ende) {
      throw new Error(
        `No address appeared under "${name}" within ${String(fristMs)} ms. ` +
          'The connected address book answered nothing, so the dialog is ' +
          'offering a field to type one into — which is exactly the picture ' +
          'this scene exists not to show.',
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 200))
  }
}
