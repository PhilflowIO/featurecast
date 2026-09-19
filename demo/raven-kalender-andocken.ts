import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchChromium, resolveBrowserRequest } from '../src/browser.js'
import type { Demo, RecordPage } from '../src/record.js'
import {
  FILM_SCROLL_TEMPO,
  RAVEN_HIDE_SELECTORS,
  RAVEN_LOCALE,
  RAVEN_STATE,
  RAVEN_URL,
  VOR_KLICK_MS,
  inDieMitte,
  ruhigKlicken,
  vorbereiten,
  warteAuf,
} from './raven-common.js'

/**
 * Product film, scene M4 "Kalender andocken": a customer brings their own
 * calendar.
 *
 * The scene shows the choice first — Google, Microsoft 365, Apple/iCloud and
 * any other CalDAV server all stand on the page as equals — and then walks one
 * of them the whole way: "Verbinden", the provider's own consent screen, back
 * in Raven, "Verbunden" with the account's name under it.
 *
 * ── Why exactly one of the four is walked ────────────────────────────────
 *
 * Not a choice of convenience. The other three were tried and could not be
 * filmed honestly:
 *
 * * **Microsoft** stops at its own tenant policy, not at Raven. Both available
 *   test accounts answer the consent step with "Administratorgenehmigung
 *   erforderlich" — the app needs an admin's blanket consent in that
 *   directory. Nothing in Raven can be changed to get past it, and granting it
 *   would be a change to an identity tenant, not to a recording.
 * * **Apple/iCloud** needs an Apple ID and an app-specific password. Neither
 *   exists in the secret store. A connection cannot be faked; the card would
 *   have to be filled with something, and something is not an Apple account.
 * * **CalDAV** has no reachable test server.
 *
 * The page still shows all four, which is the honest picture: the product
 * offers them, this recording exercises the one it can prove.
 *
 * ── Why this scene is DESKTOP ONLY ───────────────────────────────────────
 *
 * A phone recording films the application inside a frame served from the
 * application's own origin (`src/framed.ts`), and the framing headers are
 * relaxed for that origin alone. The consent screen is on the provider's
 * origin and refuses every frame: measured on the recording host, the frame
 * commits a 401 error page instead of a sign-in. So the one moment this scene
 * exists for cannot happen on the phone at all. Filming the phone up to the
 * "Verbinden" tap and stopping there would show a scene about docking a
 * calendar in which no calendar is docked.
 *
 * ── The session, and why no password is ever typed ───────────────────────
 *
 * The recording browser starts with the provider account ALREADY signed in,
 * so the film goes straight from "Verbinden" into the consent screen. The
 * sign-in itself is a preparation step with its own browser (below), never
 * part of a take: a filmed password field is a password field on film, and a
 * consent screen is the part of this story that is worth watching anyway.
 *
 * Prepare the combined session once, then record::
 *
 *     GOOGLE_DEMO_EMAIL=… GOOGLE_DEMO_PW=… \
 *         pnpm exec tsx demo/raven-kalender-andocken.ts anmelden
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-kalender-andocken.ts --devices desktop-wide
 *
 * The two values are in the secret store and belong in neither this
 * repository nor a shell history. The state file they produce IS the access to
 * both accounts and lives under `auth/`, which git ignores.
 *
 * ── After a take ─────────────────────────────────────────────────────────
 *
 * The connection is real and stays. Disconnect it in Raven ("Trennen") when
 * the scenes that need a calendar are done, and withdraw the grant in the
 * provider account, so the next take meets a fresh consent screen instead of
 * a silent redirect.
 */

/** Where the recording's browser finds Raven AND the provider signed in. */
export const KALENDER_STATE =
  process.env.RAVEN_DEMO_KALENDER_STATE ?? 'auth/state-kalender.json'

const KARTE = (anbieter: string) =>
  `[data-testid="integration-card-${anbieter}"]`

/** The four ways in, in the order the page lists them. */
const GOOGLE = KARTE('google')
const MICROSOFT = KARTE('microsoft')
const APPLE = KARTE('apple')
const CALDAV = KARTE('caldav')

/** The card's own button, scoped so the four do not collide. */
const VERBINDEN = `${GOOGLE} >> role=button[name="Verbinden"]`

/**
 * The account chooser, which stands between "Verbinden" and the consent.
 *
 * A browser that is already signed in does not go to a sign-in form; it goes
 * to "Konto auswählen" and waits for a tile to be picked. The tile is the one
 * list entry on that page carrying an address, and it is addressed that way
 * rather than by the account's name for two reasons: the recording must not
 * carry a test account's address in the repository, and the name is the
 * provider's markup, which it rewrites without telling anyone. Measured on the
 * recording host: `li:has-text("@")` matches exactly one node there, with real
 * geometry; the provider's own `data-identifier` hook matches none any more.
 */
const KONTO_WAEHLEN = 'li:has-text("@") >> nth=0'

/**
 * The consent screen's grant button.
 *
 * Matched on the button and not on a headline: the headline is the provider's
 * wording and changes without warning, while a consent screen that has no
 * grant button is not a consent screen. Two spellings are in the field — the
 * chooser path ends on "Zulassen", the sign-in-form path on "Weiter" — so the
 * scene takes whichever is actually there (`zustimmenKnopf`) instead of
 * betting on one and timing out on the other.
 */
const ZULASSEN = 'role=button[name="Zulassen"] >> nth=0'
const WEITER = 'role=button[name="Weiter"] >> nth=0'

/** The card once the round trip has come back. */
const VERBUNDEN = `${GOOGLE} >> text=Verbunden >> nth=0`

/** The connection's own account, printed under the card. */
const KONTO = `${GOOGLE} >> text=@ >> nth=0`

/** A round trip through a provider is slower than anything inside Raven. */
const ANBIETER_FRIST_MS = 90_000

/**
 * How many screens the provider may put up before it hands us back.
 *
 * Three is a backstop, not an expectation: one or two were observed. It exists
 * so a provider that decides to loop cannot keep the camera running forever.
 */
const ANBIETER_SCHRITTE = 3

/**
 * How long ONE consent screen may take to appear, inside the loop.
 *
 * Deliberately shorter than `ANBIETER_FRIST_MS`: at this point the question is
 * no longer "did the provider answer at all" but "is there ANOTHER screen", and
 * the answer "no, we are being redirected home" has to be cheap.
 */
const EIN_SCHRITT_FRIST_MS = 25_000

export const url = RAVEN_URL
export const devices = ['desktop-wide']
export const storageStatePath = KALENDER_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const locale = RAVEN_LOCALE

// NO `fixedTime` HERE, AND THAT IS THE POINT.
//
// Every other Raven scene pins the clock so "3 days ago" reads the same in two
// takes. This one must not, and it cost three takes to find out why: the pin is
// an init script on the whole browser CONTEXT (`pinClockAndRandomness` in
// `src/recipes.ts`), so it replaces `Date` on the PROVIDER's pages too. Their
// sign-in runs on a browser claiming a date three days in the past, and it
// answers the way you would expect: it stops trusting the session and bounces
// the flow into re-identification (`…/signin/oauth/id`), where there is no
// consent screen to answer and the take dies on a connection nobody made.
//
// Every headless probe passed because it had the real clock; every take failed
// because it did not. Nothing is lost by dropping it: this scene is a settings
// page and a consent screen, and neither shows a relative time.

/** The integrations page, loaded before the camera rolls. */
export const prepare = vorbereiten('/settings/integrations', GOOGLE)

export default async function kalenderAndocken(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await demo.hold(1200)

  // The choice, before the walk-through: four providers, one page.
  await demo.point(GOOGLE)
  await demo.hold(900)
  await demo.point(MICROSOFT)
  await demo.hold(800)
  await demo.point(APPLE)
  await demo.hold(800)
  await demo.point(CALDAV)
  await demo.hold(1100)

  await inDieMitte(page, demo, GOOGLE, { tempo: FILM_SCROLL_TEMPO })
  await demo.hold(VOR_KLICK_MS)
  await ruhigKlicken(demo, VERBINDEN)

  // The provider asks which account first.
  await warteImFlug(page, KONTO_WAEHLEN, ANBIETER_FRIST_MS)
  await demo.hold(1500)
  await ruhigKlicken(demo, KONTO_WAEHLEN)

  // Then its consent, which is not reliably ONE screen.
  //
  // Measured across four test accounts on the recording host: most get a
  // single "Zulassen"; one was handed a second page (`…/oauth/v2/consentsummary`)
  // that asks again. A scene that clicks exactly once answered the first and
  // stood in front of the second until its deadline. So the scene answers
  // whatever the provider puts up until the browser is back on Raven's origin
  // — which is the only reliable signal that the provider is finished with us.
  //
  // The first screen is the one worth watching (it lists what Raven asks for),
  // so it gets the long look; any follow-up is a confirmation and gets a short
  // one.
  for (let schritt = 0; schritt < ANBIETER_SCHRITTE; schritt += 1) {
    if (!(await beimAnbieter(page))) break
    const zustimmen = await zustimmenKnopf(page)
    if (zustimmen === null) break
    await demo.hold(schritt === 0 ? 3500 : 1500)
    await ruhigKlicken(demo, zustimmen)
    await demo.hold(1500)
  }

  // Back in Raven, connected, with the account named. Still `warteImFlug`:
  // the way home runs through the provider's redirect and Raven's own reload.
  //
  // If it does not arrive, the message has to say WHERE the take is standing.
  // A bare "Verbunden did not appear" is true of a missed click, a declined
  // consent and a broken callback alike, and the frames are gone by the time
  // anyone reads it.
  try {
    await warteImFlug(page, VERBUNDEN, ANBIETER_FRIST_MS)
  } catch (fehler) {
    throw new Error(
      `${fehler instanceof Error ? fehler.message : String(fehler)} — the ` +
        `page is standing at ${await adresse(page)}. Still on the provider ` +
        'means the grant was never answered; back in Raven and not connected ' +
        'means the callback failed.',
    )
  }
  await warteAuf(page, KONTO, 20_000)
  await inDieMitte(page, demo, GOOGLE, { tempo: FILM_SCROLL_TEMPO })
  await demo.point(VERBUNDEN)
  await demo.hold(4000)
}

/**
 * "Is this on screen right now" — for a page that is still navigating.
 *
 * `boundingBox()` does not answer `null` while a navigation is in flight; it
 * THROWS after its own 30 s timeout with "waiting for navigation to finish".
 * The first M4 take died exactly there: the provider puts one or two redirects
 * between the account tile and the consent screen, the poller asked during
 * one, and a question meaning "not yet" came back as a failed recording.
 *
 * Everything that polls a foreign, navigating origin has to go through here.
 * Inside Raven the plain `warteAuf` is fine — a single-page application does
 * not navigate under the question.
 */
async function stehtDa(page: RecordPage, selector: string): Promise<boolean> {
  try {
    return (await page.locator(selector).boundingBox()) !== null
  } catch {
    // Mid-navigation. Not an answer, and not a failure either.
    return false
  }
}

/**
 * `warteAuf` for a page that may navigate under the question.
 *
 * Same contract as the shared one — wait until it is there, throw when the
 * deadline passes — but it asks through `stehtDa`, so a redirect in flight
 * postpones the answer instead of ending the take.
 */
async function warteImFlug(
  page: RecordPage,
  selector: string,
  fristMs: number,
): Promise<void> {
  const ende = Date.now() + fristMs
  for (;;) {
    if (await stehtDa(page, selector)) return
    if (Date.now() > ende) {
      throw new Error(
        `Did not become visible within ${String(fristMs)} ms: ${selector}`,
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}

/** The page's own address, for waiting on stillness and for error messages. */
async function adresse(page: RecordPage): Promise<string> {
  try {
    return await page.evaluate(() => window.location.href)
  } catch {
    return ''
  }
}

/**
 * Is the browser still on the provider, rather than back on Raven?
 *
 * Compared by ORIGIN and never by "does the address contain Raven's host":
 * the provider's own account-chooser URL carries Raven's address inside its
 * `continue=` parameter, so a substring test says "we are home" while the
 * chooser is still on screen. A probe written that way reported exactly that.
 */
async function beimAnbieter(page: RecordPage): Promise<boolean> {
  const jetzt = await adresse(page)
  if (jetzt === '') return false
  try {
    return new URL(jetzt).origin !== new URL(RAVEN_URL).origin
  } catch {
    return false
  }
}

/**
 * Waits for the consent screen to STAND STILL and returns its grant button.
 *
 * Two spellings, one screen: see `ZULASSEN` / `WEITER`. Whichever is there is
 * taken — a fixed guess would wait out the full deadline on the other one.
 *
 * The stillness is the part that was missing. Between the account tile and the
 * consent screen the provider runs one or two interstitials, and one of them
 * carries a "Weiter" of its own. The second take grabbed that button, clicked
 * a page that was about to redirect anyway, and then sat in front of the real
 * consent screen without ever answering it — the take died 90 s later on a
 * connection that was never made, with nothing in the message about why.
 * So the button only counts once it has been there across two checks with the
 * address unchanged between them: an interstitial moves on, a consent screen
 * waits for a person.
 */
async function zustimmenKnopf(page: RecordPage): Promise<string | null> {
  const ende = Date.now() + EIN_SCHRITT_FRIST_MS
  for (;;) {
    for (const knopf of [ZULASSEN, WEITER]) {
      if (!(await stehtDa(page, knopf))) continue
      const vorher = await adresse(page)
      await new Promise((fertig) => setTimeout(fertig, 1200))
      if ((await adresse(page)) === vorher && (await stehtDa(page, knopf))) {
        return knopf
      }
    }
    // No still grant button in this window. That is not a failure here — it
    // is how "the provider is done with us" looks from inside the loop, and
    // the caller's own wait for a connected card decides the take.
    if (Date.now() > ende) return null
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}

/**
 * Adds the provider's session to Raven's and writes the combined state.
 *
 * It STARTS from `auth/state.json`, the session every other Raven recording
 * already replays, and only signs in at the provider — so this step needs the
 * provider's credentials and no Raven ones. One file at the end, because a
 * recording replays exactly one: a Playwright storage state carries the
 * cookies of every origin its context saw, so Raven's session and the
 * provider's travel together, and nobody has to merge two session files by
 * hand.
 *
 * The provider's sign-in is driven here and NOT with `demo`, on purpose: this
 * is not filmed, so it may use the plain page, fill the password field
 * instantly, and never render a keystroke.
 */
export async function anmeldenMitKalender(): Promise<void> {
  const googleMail = process.env.GOOGLE_DEMO_EMAIL
  const googlePw = process.env.GOOGLE_DEMO_PW
  if (googleMail === undefined || googlePw === undefined) {
    throw new Error(
      'GOOGLE_DEMO_EMAIL and GOOGLE_DEMO_PW have to be set. They are in the ' +
        'secret store, not in this repository.',
    )
  }

  const { browser } = await launchChromium(
    { headless: true },
    resolveBrowserRequest(process.env),
  )
  try {
    const context = await browser.newContext({
      locale: RAVEN_LOCALE,
      storageState: RAVEN_STATE,
      viewport: { height: 1100, width: 1600 },
    })
    const page = await context.newPage()

    await page.goto('https://accounts.google.com/')
    const adresse = page.locator('#identifierId, input[type="email"]').first()
    await adresse.waitFor({ state: 'visible', timeout: 30_000 })
    await adresse.fill(googleMail)
    await page.keyboard.press('Enter')
    const passwort = page.locator('input[type="password"]').first()
    await passwort.waitFor({ state: 'visible', timeout: 30_000 })
    await passwort.fill(googlePw)
    await page.keyboard.press('Enter')
    // The account page is the proof that the sign-in went through. A state
    // written before it would carry half a sign-in and film a password form.
    await page.waitForURL(/myaccount\.google\.com/, { timeout: 60_000 })

    await mkdir(dirname(KALENDER_STATE), { recursive: true })
    await writeFile(
      KALENDER_STATE,
      JSON.stringify(await context.storageState(), null, 2),
    )
    await context.close()
  } finally {
    await browser.close()
  }
  console.log(`Session state written: ${KALENDER_STATE}`)
}

// The sign-in only. A script that records itself opens a second, unfilmed
// browser on mere import (`importScript` in `src/pipeline.ts`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [schritt] = process.argv.slice(2)
  if (schritt === 'anmelden' || schritt === 'prepare') {
    await anmeldenMitKalender()
  } else {
    throw new Error(
      'Usage: tsx demo/raven-kalender-andocken.ts anmelden — the recording ' +
        'runs through featurecast run demo/raven-kalender-andocken.ts ' +
        '--devices desktop-wide',
    )
  }
}
