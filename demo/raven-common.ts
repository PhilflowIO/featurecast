import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Frame } from 'playwright'

import { launchChromium, resolveBrowserRequest } from '../src/browser.js'
import type { Demo, RecordPage } from '../src/record.js'

/**
 * What every recording of Raven shares.
 *
 * Several scripts film the same application: `raven-meetings.ts`,
 * `raven-startseite.ts`, `raven-besprechen.ts`, `raven-auto-aufnahme.ts` and
 * the three product-film scenes on the Steinkauz meeting
 * (`raven-protokoll.ts`, `raven-transkript-sprung.ts`,
 * `raven-steinkauz-fragen.ts`), and the live-meeting scene
 * `raven-live-meeting.ts`.
 * The target, the saved session, the areas no viewer may see, the fixed clock,
 * the framing permission, the visibility poller and the sign-in step are the same for all of them. They
 * live here once so that they cannot drift apart. The failure that drift
 * causes is a privacy leak, not a style problem: a selector added to one hide
 * list and forgotten in the others puts an internal address into a
 * public video.
 *
 * This module is deliberately NOT a recording script. It exports no `default`
 * and no `recording`, and it never calls `record()`. A module that recorded
 * itself on import would open a second, unfilmed browser in every script that
 * imports it (see `importScript` in `src/pipeline.ts`).
 */

/** The application that is filmed. Staging deploys Raven's `dev` branch. */
export const RAVEN_URL =
  process.env.RAVEN_DEMO_URL ?? 'https://staging.raven.ceo'

/**
 * The path to the saved session, never its contents.
 *
 * A `storageState` file contains the cookies and local storage of a signed-in
 * account, so it IS the access. That is why it lives under `auth/`, which
 * `.gitignore` excludes, and why no script contains a single credential.
 */
export const RAVEN_STATE = process.env.RAVEN_DEMO_STATE ?? 'auth/state.json'

/**
 * Two areas no viewer should see: the cookie notice (noise) and the
 * personal-room card, which shows the internal pre-production address in every
 * frame of the meetings list.
 *
 * The card is hidden by selector and not by feature flag because it cannot be
 * switched off per account. It hangs on the kill switch for the whole
 * deployment (`FEATURE_PERMANENT_ROOMS`,
 * `api/app/services/personal_room.py:38-55` in `flow.raven`), and the call site
 * `ui/src/app/meetings/page.tsx:151` renders it without any feature condition.
 * Withdrawing `FEATURE_PERMANENT_ROOMS_SURFACE` has already been tried and does
 * nothing here.
 */
export const RAVEN_HIDE_SELECTORS: readonly string[] = [
  '#cookie-banner',
  '[data-testid="personal-room-card"]',
]

/**
 * Raven forbids framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`),
 * which is right for the product and stays so. A phone or tablet is filmed
 * through the framed shell (`src/framed.ts`), and the shell needs a frame, so
 * every Raven script lets the recording browser relax exactly those two
 * headers on the filmed document. Nothing changes in Raven or in any browser
 * a user has; what is relaxed and why that is safe is in the header of
 * `src/framed.ts`. Decided 2026-09-18 (featurecast issue 138, variant A).
 */
export const RAVEN_ALLOW_FRAMING = true

/**
 * Raven is a German product, used in German browsers: filmed in an English
 * one, every correctly spelled German word typed on camera got a red
 * spellcheck squiggle (featurecast#172). The locale sets the page's language
 * and the browser's, which is where the dictionary comes from (src/locale.ts).
 */
export const RAVEN_LOCALE = 'de-DE'

/**
 * The wall clock Raven is filmed on.
 *
 * The sibling of `RAVEN_LOCALE`, and needed for the same class of reason: the
 * language decides the words on screen, this decides the numbers. A recording
 * runs in a container whose clock is UTC, so without it every time Raven
 * prints is an hour or two off — and in a scene that ASKS for a time (M2 asks
 * for "10 Uhr") the picture then contradicts the sentence that produced it.
 * Measured against staging on 2026-09-20: the same appointment read back as
 * `08:00–09:00` in the calendar grid without it and as `10:00–11:00` with it.
 */
export const RAVEN_TIMEZONE = 'Europe/Berlin'

/**
 * A fixed clock, so two recordings show the same relative times ("3 days ago"
 * otherwise moves between two runs).
 */
export const RAVEN_FIXED_TIME = '2026-09-16T09:00:00Z'

/**
 * The one demo meeting with a real recording: four faces, 32 transcript
 * segments with named speakers, a summary with decisions and open points. Recorded
 * on staging 2026-09-18 around 19:44 UTC. The product-film scenes
 * (`raven-protokoll.ts`, `raven-transkript-sprung.ts`,
 * `raven-steinkauz-fragen.ts`) all film it.
 */
export const STEINKAUZ_ID = '623f6852-b219-5550-899f-1caadb4b2ca5'
export const STEINKAUZ_TITEL = 'Projekt Steinkauz — Statusrunde — KW 38'

/**
 * The clock for the Steinkauz scenes: a quarter of an hour after the meeting.
 *
 * Not `RAVEN_FIXED_TIME`. That instant is two days BEFORE this meeting, and
 * the meetings list would date the newest row in the future. The detail page
 * prints the absolute "18.09.2026 · 19:44" and no relative time (read on
 * staging, 2026-09-18), so only the list in the chat scene depends on it.
 * Just after the meeting also suits the story: the protocol is written while
 * the meeting is fresh.
 */
export const STEINKAUZ_FIXED_TIME = '2026-09-18T20:00:00Z'

/** The pace every scripted scroll in the product-film scenes uses (px/s). */
export const FILM_SCROLL_TEMPO = 400

/** Stillness before a click and after it, from the video team's shot list. */
export const VOR_KLICK_MS = 700
export const NACH_KLICK_MS = 1500

/**
 * A click the way the shot list wants it: the pointer arrives, rests
 * `VOR_KLICK_MS`, clicks, and the picture rests `NACH_KLICK_MS` so the cut has
 * a still frame on both sides of the action.
 */
export async function ruhigKlicken(demo: Demo, ziel: string): Promise<void> {
  await demo.point(ziel)
  await demo.hold(VOR_KLICK_MS)
  await demo.click(ziel)
  await demo.hold(NACH_KLICK_MS)
}

/**
 * The first row of the meetings list.
 *
 * The `nth=0` is not cosmetic. `a[href^="/meetings/"]` matches every visible
 * row, and Playwright refuses to report geometry for an ambiguous locator. The
 * recorder needs exactly that geometry to move the pointer there. Without the
 * restriction the recording aborts with a timeout that looks like a loading
 * problem and is not one.
 */
export const ERSTE_ZEILE = 'a[href^="/meetings/"] >> nth=0'

/**
 * Whether `selector` matches a visible node at this moment, without waiting.
 *
 * `boundingBox()` alone is the wrong question for a poll: it waits for the node
 * to exist, up to Playwright's default 30 s, and then throws. A loop asking "is
 * the failure notice there yet?" therefore blocked on its first pass and could
 * only ever end in a timeout. Counting first returns at once when nothing
 * matches; the box then says whether the match has an area.
 */
export async function jetztSichtbar(
  page: RecordPage,
  selector: string,
): Promise<boolean> {
  const knoten = page.locator(selector)
  if ((await knoten.count()) === 0) return false
  try {
    return (await knoten.boundingBox()) !== null
  } catch {
    // A node that IS in the document but has no box yet — mid-navigation, or
    // still at the first keyframe of the animation that mounts it — makes
    // `boundingBox()` wait out its OWN timeout and then throw, rather than
    // answer "not visible". Without this catch that throw escapes `warteAuf`
    // and ends the take after 30 s, whatever deadline the caller asked for:
    // scene M2 asked for 120 s for a gate card that mounts animated, and died
    // at 30 with a Playwright stack instead of its own message. "Not yet" is
    // the honest answer to the question this function asks.
    return false
  }
}

/**
 * Waits until a node genuinely has an area.
 *
 * `RecordPage` is deliberately a narrow surface and has no `waitFor`. It
 * reaches exactly as far as the recorder needs. A `boundingBox()` that no
 * longer returns `null` answers the better question here anyway: not "is the
 * node in the document" but "is it visible", and only a visible node can be
 * clicked or pointed at.
 */
export async function warteAuf(
  page: RecordPage,
  selector: string,
  fristMs = 30_000,
): Promise<void> {
  const ende = Date.now() + fristMs
  for (;;) {
    if (await jetztSichtbar(page, selector)) return
    if (Date.now() > ende) {
      throw new Error(
        `Did not become visible within ${fristMs} ms: ${selector}`,
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}

/**
 * A `prepare` step that opens `pfad` and returns once `bereit` is visible.
 *
 * Why the first navigation belongs here and not in the recording. The capture
 * starts on the empty page the browser opens with. A script whose first line
 * is `page.goto` therefore films that empty page and the whole load after it:
 * both Raven clips opened on about 4 s of white. The renderer is right not to
 * cut it, because a load is not idle time it can recognise. `prepare` runs on
 * the same page before the camera rolls (`SessionRequest.prepare` in
 * `src/session.ts`), so the first frame is the screen the clip is about.
 *
 * `bereit` names the content, not the frame around it: the first meeting row,
 * not the list's heading, because the heading is there a second before the
 * rows are fetched.
 */
export function vorbereiten(
  pfad: string,
  bereit: string,
): (app: Frame) => Promise<void> {
  return async (app) => {
    await app.goto(`${RAVEN_URL}${pfad}`)
    await app.locator(bereit).waitFor({ state: 'visible', timeout: 30_000 })
  }
}

/**
 * Like `vorbereiten`, but the scene opens with `ziel` already standing at
 * `anteil` of the viewport height instead of at the top of the page.
 *
 * For a scene that is about one part of a long page (the transcript, the
 * summary's button) and would otherwise spend its first seconds on a scroll
 * nobody asked for. The page is scrolled twice with a pause between: Raven's
 * transcript rows use `content-visibility: auto`, so rows are laid out at a
 * placeholder height until they are near the screen, and the first scroll
 * moves the target by the difference (measured on staging: a click aimed from
 * the first geometry landed in the gap between two rows).
 */
export function vorbereitenBei(
  pfad: string,
  ziel: string,
  anteil: number,
): (app: Frame) => Promise<void> {
  return async (app) => {
    await app.goto(`${RAVEN_URL}${pfad}`)
    const knoten = app.locator(ziel)
    await knoten.waitFor({ state: 'visible', timeout: 30_000 })
    for (let durchgang = 0; durchgang < 2; durchgang += 1) {
      await knoten.evaluate((element, share) => {
        const box = element.getBoundingClientRect()
        window.scrollBy(
          0,
          box.top + box.height / 2 - window.innerHeight * share,
        )
      }, anteil)
      await app.waitForTimeout(800)
    }
  }
}

/**
 * Signs in through the form and writes the session state.
 *
 * Through the form and not through the sign-in API. Better-Auth sets its
 * session cookies the same way on either route, but the interface also stores
 * state in the browser (the section last chosen, notices dismissed once). A
 * script that only fetches the cookie films, on its first run, a state no human
 * ever sees.
 *
 * Deliberately not a `prepare` export. The main chain knows a step of that name
 * that runs against the already-open page. This is a separate operation with
 * its own browser, it may run weeks before a recording, and its result is a
 * file.
 */
export async function anmelden(): Promise<void> {
  const email = process.env.RAVEN_DEMO_EMAIL
  const passwort = process.env.RAVEN_DEMO_PW
  if (email === undefined || passwort === undefined) {
    throw new Error(
      'RAVEN_DEMO_EMAIL and RAVEN_DEMO_PW have to be set. They are in the ' +
        'secret store, not in this repository.',
    )
  }

  // The same browser the recording drives later (`CHROME_BIN`, otherwise the
  // bundled one). This is not taste. A bare `chromium.launch()` can start a
  // different browser than the recording; on the measurement box it once
  // started one that never built the sign-in form, and after 30 seconds it
  // aborted with a timeout on `#email` that looked like a network problem.
  // And as a principle, a session should come from the browser that replays
  // it later.
  const { browser } = await launchChromium(
    { headless: true },
    resolveBrowserRequest(process.env),
  )
  try {
    const context = await browser.newContext({
      viewport: { height: 720, width: 1280 },
    })
    const page = await context.newPage()
    await page.goto(`${RAVEN_URL}/login`)
    await page.locator('#email').fill(email)
    await page.locator('#password').fill(passwort)
    await page.getByRole('button', { exact: true, name: 'Anmelden' }).click()
    await page.waitForURL('**/meetings', { timeout: 60_000 })
    // The heading is the proof, not the address. The address changes before
    // the list has loaded, and a state saved before the first successful fetch
    // can contain half a login.
    await page
      .getByRole('heading', { name: 'Meetings' })
      .waitFor({ timeout: 30_000 })

    await mkdir(dirname(RAVEN_STATE), { recursive: true })
    const state = await context.storageState()
    await writeFile(RAVEN_STATE, JSON.stringify(state, null, 2))
    await context.close()
  } finally {
    await browser.close()
  }
  console.log(`Session state written: ${RAVEN_STATE}`)
}

// ── The assistant, pinned to one meeting ────────────────────────────────────
// Shared by `raven-besprechen.ts` and `raven-steinkauz-fragen.ts`: both open a
// meeting, press "Mit Raven besprechen", ask one question and wait for the
// streamed answer. Kept here so a fix to the answer wait reaches both.

/**
 * The link that opens the meeting titled `titel` from the meetings list.
 *
 * NOT the shared first-row selector. A meetings row is a clickable `div` that
 * opens the preview pane. The only `a[href^="/meetings/"]` in it is the
 * 28 px chevron "Details öffnen" (`ui/src/components/meetings/meeting-list-item.tsx:121,294-301`
 * in `flow.raven`). An early trial clicked the first row's chevron while a
 * search was still in flight and opened the wrong meeting. This selector names
 * the row by its title and takes that row's chevron, so which meeting opens
 * never depends on where the list happens to stand.
 */
export function zeileMitTitel(titel: string): string {
  return (
    `h3:has-text("${titel}") >> nth=0 >> ` +
    'xpath=ancestor::div[contains(concat(" ", @class, " "), " group ")][1]' +
    '//a[starts-with(@href, "/meetings/")] >> nth=0'
  )
}

/** The button on the meeting page. There is no `data-testid` on it. */
export const BESPRECHEN = 'role=button[name="Mit Raven besprechen"]'

/**
 * The chip above the composer. `>> nth=0` because the locator has to be
 * unambiguous before the recorder will report its geometry.
 */
export const KONTEXT_CHIP = 'text=Kontext: >> nth=0'

/**
 * A finished assistant message that is an answer.
 *
 * A failed or interrupted turn is ALSO an `assistant-message`, with a marker
 * inside (`assistant-page-client.tsx:2006-2045`). The first trial waited for
 * the bare test id, took "Antwort fehlgeschlagen" for the answer, and the
 * renderer then trimmed the motionless failure away as idle time. The video
 * ended on the question.
 */
export const ANTWORT_OHNE_NUMMER =
  '[data-testid="assistant-message"]' +
  ':not(:has([data-testid="assistant-message-failed"]))' +
  ':not(:has([data-testid="assistant-message-interrupted"]))'

/**
 * The n-th finished answer, counted from zero: 0 is Raven's own opening, 1
 * the answer to `FRAGE`. A turn still streaming is a different node
 * (`assistant-message-streaming`), so this only matches once it has settled.
 */
export function antwort(nummer: number): string {
  return `${ANTWORT_OHNE_NUMMER} >> nth=${String(nummer)}`
}

/** The composer at the bottom, where the pointer waits for the answer. */
export const EINGABE = 'textarea >> nth=0'

/** The composer's send button. Enter would do too, but `demo` has no keys. */
export const SENDEN = 'role=button[name="Senden"]'

/**
 * Scrolls until `selector` stands at about 45 % of the viewport height, with a
 * visible scroll the renderer keeps (swipe on a phone, wheel on a desktop).
 *
 * A tap on something at the screen's edge is filmed as a dot on a sliver of
 * button: in the first phone take the tap on "Mit Raven besprechen" landed on
 * the bottom 6 px of the button, the rest hidden under Raven's own player strip
 * (flow.raven #7217, fixed in PR #7220). Bringing the target to the middle
 * first puts it where the zoom centres anyway, with room above and below.
 * Up to three passes, because a lazily grown list can move the target while
 * the first scroll runs; a target already within 60 px of the mark is left
 * alone, so a desktop layout that shows it at once does not scroll for show.
 * A pass that did not move the target ends the loop: the page is at its top
 * or bottom and cannot bring it closer. Without that check the first row of a
 * list, which sits above the mark on a page already at the top, was "scrolled"
 * three times for nothing — 2.5 s of a still picture in the S5 clip.
 */
export async function inDieMitte(
  page: RecordPage,
  demo: Demo,
  selector: string,
  {
    anteil = 0.45,
    tempo,
    innerhalb,
  }: {
    /** Where the target's centre should land, as a share of the height. */
    anteil?: number
    /** Scroll pace in px/s; the recorder's own default when absent. */
    tempo?: number
    /**
     * The panel the scroll lives in, when it is not the page (the recorder's
     * `ScrollOptions.within`). A calendar's hours scroll inside a grid, and a
     * gesture made anywhere else moves nothing.
     */
    innerhalb?: string
  } = {},
): Promise<void> {
  for (let durchgang = 0; durchgang < 3; durchgang += 1) {
    const box = await page.locator(selector).boundingBox()
    const hoehe = page.viewportSize()?.height
    if (box === null || hoehe === undefined) {
      throw new Error(`Cannot place ${selector}: no geometry`)
    }
    const abstand = Math.round(box.y + box.height / 2 - hoehe * anteil)
    if (Math.abs(abstand) <= 60) return
    await demo.scroll(0, abstand, {
      ...(tempo === undefined ? {} : { speedPxPerSecond: tempo }),
      ...(innerhalb === undefined ? {} : { within: innerhalb }),
    })
    const danach = await page.locator(selector).boundingBox()
    if (danach !== null && Math.abs(danach.y - box.y) < 1) return
  }
}

/**
 * Brings `selector` into the picture if it is not already comfortably in it.
 *
 * `inDieMitte` with a guard in front: it places a target that is off screen or
 * close to an edge, and leaves one that already stands well inside alone, so a
 * desktop layout that shows the whole dialog at once does not scroll for show.
 * Without it the phone take of the share scene aborted on the first thing the
 * dialog put below the fold — measured: the readout at y=3697 in a 2880 px
 * picture.
 *
 * Shared rather than copied: `raven-teilen.ts` and `raven-versenden.ts` both
 * film a dialog that is one screen on a desktop and three on a phone, and the
 * two must not drift apart on where an element counts as "in the picture".
 */
export async function imBild(
  page: RecordPage,
  demo: Demo,
  selector: string,
): Promise<void> {
  const box = await page.locator(selector).boundingBox()
  const hoehe = page.viewportSize()?.height
  if (box === null || hoehe === undefined) return
  const rand = hoehe * 0.15
  if (box.y >= rand && box.y + box.height <= hoehe - rand) return
  await inDieMitte(page, demo, selector, { tempo: FILM_SCROLL_TEMPO })
}

/** The marker of a turn that did not produce an answer. */
export const FEHLSCHLAG =
  '[data-testid="assistant-message-failed"], ' +
  '[data-testid="assistant-message-interrupted"]'

/** An answer is a model call. The slow reasoning level can take this long. */
export const ANTWORT_FRIST_MS = 90_000

/**
 * Waits for the answer, and aborts at once if the turn failed.
 *
 * A failed turn does not become an answer by waiting 90 seconds, and a
 * recording that ends on a failure is worse than none. The message names the
 * cause the trial runs actually hit: on a workstation where Docker keeps
 * creating and removing network interfaces, Chromium reports
 * `ERR_NETWORK_CHANGED` and drops the answer stream midway.
 */
export async function warteAufAntwort(
  page: RecordPage,
  nummer: number,
): Promise<void> {
  const ende = Date.now() + ANTWORT_FRIST_MS
  for (;;) {
    if (await jetztSichtbar(page, `${FEHLSCHLAG} >> nth=0`)) {
      throw new Error(
        'The assistant turn failed ("Antwort fehlgeschlagen"), so there is ' +
          'nothing to film. If this machine runs Docker containers that come ' +
          'and go, Chromium drops the answer stream on every network change ' +
          '(ERR_NETWORK_CHANGED). Record on a quiet machine and run it again.',
      )
    }
    if (await jetztSichtbar(page, antwort(nummer))) return
    if (Date.now() > ende) {
      throw new Error(
        `No answer within ${String(ANTWORT_FRIST_MS)} ms: ${antwort(nummer)}`,
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}

/**
 * The tail of the conversation, for a failure message.
 *
 * Read from the page rather than from a locator, because at the moment this
 * runs the interesting node may be a refusal, an error banner or nothing at
 * all — and a selector written for one of those three cannot report the other
 * two. Trimmed, and it carries no field values.
 */
export async function letzteAntwort(page: RecordPage): Promise<string> {
  try {
    return await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll('[data-testid="assistant-message"]'),
      )
      const letzte = nodes[nodes.length - 1]
      const text = ((letzte?.textContent ?? document.body.innerText) || '')
        .replace(/\s+/g, ' ')
        .trim()
      return `"${text.slice(-320)}"`
    })
  } catch {
    return '(the page would not answer)'
  }
}

/**
 * Waits until `selector` has no geometry any more.
 *
 * Shared by `raven-auf-zuruf.ts` and `raven-briefing.ts`: both end an
 * appointment turn on the gate card going away, and a fix to this poll (see
 * below) has to reach both.
 *
 * `warteAuf` answers "is it there yet"; the end of this scene needs the other
 * direction. A gate card that is still on screen means the write has not run,
 * and a clip that ends on an unanswered gate shows the opposite of the
 * promise the scene is about.
 */
export async function warteAufVerschwunden(
  page: RecordPage,
  selector: string,
  fristMs: number,
): Promise<void> {
  const ende = Date.now() + fristMs
  for (;;) {
    // `jetztSichtbar` and NOT a bare `boundingBox()`. A locator whose node has
    // left the document does not answer `null`; it waits out Playwright's own
    // 30 s and THROWS — so the poll that was meant to notice the gate card
    // disappearing ended the take at 30 s with a Playwright stack, on the one
    // outcome it was written to recognise. Measured on the desktop take of
    // 2026-09-20: the appointment was written, the card was gone, and the
    // recording was refused anyway.
    if (!(await jetztSichtbar(page, selector))) return
    if (Date.now() > ende) {
      throw new Error(
        `Still on screen after ${String(fristMs)} ms: ${selector}. The ` +
          'appointment gate was confirmed but nothing was written — most ' +
          'likely no calendar is connected on the recording account.',
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}
