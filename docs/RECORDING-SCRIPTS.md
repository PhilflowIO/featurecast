# Turning an existing Playwright script into a recording

This guide takes a script that already exists — one from a test suite, one
from `playwright codegen` — and turns it into a featurecast recording. Nothing
is changed in the wrapper itself; everything here runs through the public
interfaces from `src/record.ts`.

Everything written here applies to the state of things today (M0 and M2). What
has not been decided yet is at the end, under [What does not exist
yet](#what-does-not-exist-yet) — and not disguised as a recipe somewhere in
between.

## What comes out of it

`record()` writes two files into the `out` folder:

- `events.jsonl` — event log v1: a header line with `fps` and `seed`, then the
  pointer track at 60 hertz, clicks, taps, holds, scrolls and typing events,
  each with the bounding box of the element that was hit. Structure and
  guarantees: [INTERNALS.md](INTERNALS.md#event-log-v1).
- `browser.json` — which Chromium actually ran (path, version, SHA-256 of the
  binary).

**No video comes out of this.** `record()` itself only writes the event log.
Anyone who wants a video does not call `record()` but `featurecast run` — see
[One command for the whole chain](#one-command-for-the-whole-chain) further
down.

## The conversion

A Playwright script becomes a recording by routing its interactions through
`demo` instead of through `page`. Only the interactions — navigation, waiting
and everything invisible stay as they are.

```ts
import { record } from '../src/record.js'

await record({ out: 'artifacts/feature-xy', seed: 1 }, async (page, demo) => {
  await page.goto('https://app.example.com/feature')
  await demo.click('#nav-settings')
  await demo.type('#search', 'Invoice 2026')
  await demo.hold(1200)
  await demo.scroll(0, 900)
  await demo.click('#row-3')
})
```

The translation, line by line:

| Playwright                 | featurecast            | Difference                                           |
| -------------------------- | ---------------------- | ---------------------------------------------------- |
| `page.click(sel)`          | `demo.click(sel)`      | smooth approach first, the click is logged           |
| `page.tap(sel)`            | `demo.tap(sel)`        | needs a touch context                                |
| `page.hover(sel)`          | `demo.point(sel)`      | travels there, does not click                        |
| `page.fill(sel, text)`     | `demo.type(sel, text)` | travels there, focuses, types real keys with a delay |
| `page.mouse.wheel(dx, dy)` | `demo.scroll(dx, dy)`  | smoothed to 60 hertz, default pace 700 px/s          |
| `page.waitForTimeout(ms)`  | `demo.hold(ms)`        | waits the same, but advances the time scale          |
| `page.goto(url)`           | `page.goto(url)`       | unchanged                                            |

`demo.scroll` optionally takes a pace —
`demo.scroll(0, 900, { speedPxPerSecond: 400 })` for a slower reveal.

A target is either a CSS selector as a string or a ready-made Playwright
locator. Both work everywhere `sel` appears above.

### The options that exist

`record()` knows exactly four:

| Option            | Default | Meaning                                                      |
| ----------------- | ------- | ------------------------------------------------------------ |
| `out`             | —       | target folder, required                                      |
| `seed`            | `1`     | seed for movement and typing delay                           |
| `device`          | none    | name from Playwright's device registry, resolved at run time |
| `settleTimeoutMs` | `5000`  | budget per interaction until the geometry stands still       |

No more than that. Capture and output format, pointer rendering and the
curated presets from [DEVICES.md](DEVICES.md) are M5 — whatever appears next to
`device` in the examples there is a draft, not an interface.

### What `page` can do in a script — and what it cannot

The `page` the wrapper hands over is deliberately a narrow slice of the real
Playwright page: `goto`, `locator`, `evaluate`, `keyboard.type`, `mouse`,
`touchscreen`, `viewportSize`, `waitForTimeout`, `hasTouch`.

Everything else — `waitForSelector`, `waitForResponse`, `expect`, `route`,
`screenshot` — is not available there. A test script containing such calls has
two routes: pull them out ahead of the call to `record()` (setup, teardown and
assertions do not belong in the video anyway), or — under `featurecast run` —
into a `prepare` step that gets the full Playwright page and runs outside the
capture window.

And one quirk that bites quickly: `page.evaluate` here takes a function **with
no arguments**. Values from the script do not reach the page as parameters,
they have to go into the text of the function.

## One command for the whole chain

`featurecast run` takes a recording script, plays it once per device, captures
the frames as it goes, sends them through post-processing — zoom, pointer,
idle compression — and uploads the result on request.

What is delivered is the one size the device promises; `--all-formats` turns
that into 16:9, 9:16 and 1:1 out of the same recording. Beside the recording
folder, a second one appears with the videos and `decisions.json`.

```sh
pnpm featurecast run demo/feature-xy.ts --devices desktop-wide --upload
```

For this, a script looks different from the one above: it **exports the body
of the recording instead of calling `record()` itself**. The browser, the
device and the frame capture around it belong to the command; a module that
calls `record()` on load would open a second, uncaptured browser.

```ts
import type { Demo, RecordPage } from '../src/record.js'

export default async function featureXy(page: RecordPage, demo: Demo) {
  await page.goto('https://app.example.com/feature')
  await demo.click('#nav-settings')
  await demo.scroll(0, 900)
}
```

A complete example is in [`demo/feature-xy.ts`](../demo/feature-xy.ts).
Instead of `default`, an export named `recording` also works.

A third, optional export: **`url` names the application** that is being filmed.
For a pointer device that is voluntary — the script navigates there itself —
but for a touch device it is mandatory, because the shell the application is
filmed in is served from the application's own origin
([`src/framed.ts`](../src/framed.ts)). If it is missing, the chain aborts
before a browser starts.

### What a script may say about the browser context

Three further exports describe not the recording but the context it takes
place in. They are part of the contract because a script simply _cannot_ set
them itself: it receives an already-opened page, and all three have to hold
before that page exists.

| Export             | Type       | Meaning                                                       |
| ------------------ | ---------- | ------------------------------------------------------------- |
| `storageStatePath` | `string`   | path to a saved sign-in (`storageState`) — never its contents |
| `hideSelectors`    | `string[]` | areas that disappear before the page runs its own scripts     |
| `fixedTime`        | `string`   | the moment every recording claims; also freezes `Math.random` |

```ts
import type { Demo, RecordPage } from '../src/record.js'

export const url = 'https://app.example.com'
export const storageStatePath = 'auth/state.json'
export const hideSelectors = ['#cookie-banner', '#internal-address-card']
export const fixedTime = '2026-01-15T09:00:00Z'

export default async function list(page: RecordPage, demo: Demo) {
  await page.goto('https://app.example.com/meetings')
  await demo.click('#row-3')
}
```

```sh
pnpm featurecast run demo/my-recording.ts --devices desktop-wide
```

Wrongly written values are rejected before a browser starts, and the message
names the file and the export. That is not formalism: a `hideSelectors` that
is accidentally a single string would be accepted without complaint in the
browser, would hide nothing — and the recording would be flawless apart from
the card that was not supposed to be in it.

A complete example that runs against the real application is
[`demo/raven-meetings.ts`](../demo/raven-meetings.ts).

| Switch      | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `--devices` | comma-separated list of presets and Playwright names. Required.           |
| `--out`     | root folder; one subfolder per device. Default `artifacts/<script-name>`. |
| `--upload`  | uploads every finished video and prints the URL.                          |
| `--encoder` | `x264` (default), `nvenc-h264`, `nvenc-hevc`.                             |
| `--seed`    | seed for movement and typing delay. Default `1`.                          |

The credentials for `--upload` come exclusively from the environment
(`.env.example` names the variables). If one is missing, the run aborts
**before** the first browser starts — an error that is recognisable at the
outset should not surface only after capture and encode.

**A device that aborts does not stop the others.** Every error is collected and
named at the end together with the stage that rejected it; the command's exit
code is then non-zero. A recording is minutes of work, and throwing a finished
one away to report another device's problem sooner helps nobody.

**What really runs through today.** Only `desktop-wide`. Every mobile preset
aborts with the M3 notice (the capture area is undecided there), and `desktop`
and `safari` demand a capture area of 2560×1440 while `src/capture.ts` captures
a fixed 2560×1600. Which of the two numbers applies is unresolved between
[PLAN.md](../PLAN.md) and [DEVICES.md](DEVICES.md) (see
[CAPTURE-CADENCE.md](CAPTURE-CADENCE.md)) — the command names the conflict
instead of quietly picking one of the two. The M6 acceptance example
`--devices desktop,iphone` is therefore not achievable today.

## Recipe: recording while signed in

A signed-in recording is an ordinary script of the main chain: it names the
saved session, and `featurecast run` establishes the context, films and
renders.

```ts
export const storageStatePath = 'auth/state.json'
export const hideSelectors = ['#cookie-banner', '#internal-address-card']
export const fixedTime = '2026-01-15T09:00:00Z'

export default async function featureXy(page: RecordPage, demo: Demo) {
  await page.goto('https://app.example.com/feature')
  await demo.click('#nav-settings')
}
```

Until those three exports became part of the contract, a second recording
route sat beside it in `demo/`, opening its own browser in order to set them —
and it wrote an event log and not a single frame. It no longer exists; for a
signed-in recording there is no longer any reason to work around the main
chain.

### Capturing the session once

The session state is created once by hand, in a visible browser, and reused
afterwards:

```sh
pnpm exec playwright codegen --save-storage=auth/state.json https://app.example.com/login
```

Sign in, dismiss the cookie banner, close the window — the file then contains
the cookies and `localStorage` of the signed-in state.

`auth/` is reserved for exactly that and is **deliberately not versioned**:
`.gitignore` excludes `auth/*` (only `auth/.gitkeep` remains, so the folder
exists), `.prettierignore` does not touch it either, and
[AGENTS.md](../AGENTS.md) says the same in words. Credentials and saved
sessions do not belong in the repository. A `storageState` file is a sign-in
state, not a configuration artifact — passing it on means passing on the
access.

Sessions expire. When a recording suddenly films the sign-in page, it is not
the script that is broken but the file that is old: repeat the command above.

### Or the session in a sign-in step of its own

A target with an ordinary sign-in form needs no human for this.
`demo/raven-meetings.ts` splits it into two invocations: the sign-in signs in
headlessly and writes `auth/state.json`, after which the recording runs like
any other through `featurecast run`.

```sh
RAVEN_DEMO_EMAIL=… RAVEN_DEMO_PW=… pnpm exec tsx demo/raven-meetings.ts anmelden
pnpm featurecast run demo/raven-meetings.ts --devices desktop-wide
```

The sign-in is deliberately **not** a `prepare` export. The contract knows a
step of that name, but it runs against the already-opened page shortly before
the recording; the sign-in here is a separate operation with its own browser,
which may run weeks earlier and whose result is a file.

Two decisions in it are deliberate and not taste.

**Through the form, not through the sign-in API.** An HTTP call would give the
same session cookie in a fraction of the time, but the interface also lays
down state in the browser while signing in. Anyone who only fetches the cookie
films, on the first run, a state no human would ever get to see.

**The wait is on the heading, not on the address.** The address changes before
the list has loaded. A state saved at that moment can contain half a login —
and the error then shows up only in the recording.

The credentials appear in no line of the script. They come from the
environment, and they belong in a secret store — for the same reason `auth/`
is not versioned.

## Recipe: hiding cookie banners

Two routes, and the first is usually the better one.

**Through the session.** Anyone who dismisses the banner while creating
`auth/state.json` has the consent cookie in the file. The banner then never
appears in the first place — nothing has to be suppressed, because nothing is
there.

**Through an init script.** When that does not work (consent held
server-side, a new domain, a banner inside a frame), an init script hides the
node before the page runs its own scripts. That is exactly what the
`hideSelectors` export does: the chain then attaches a `<style>` to every
document of the context (`hideOverlay` in
[`src/recipes.ts`](../src/recipes.ts)), with its own
`display:none !important` rule per selector.

`hideSelectors` takes any number of selectors, because rarely is it only the
banner that gets in the way — the product card with the internal address has to
go just as much. Each selector gets its own rule rather than a comma-separated
group selector: a group is parsed as a unit, and a single selector inside it
that the browser does not understand makes it discard the whole rule, silently
taking the valid selectors with it.

Hiding rather than clicking away is deliberate. A click on "Accept" is an
interaction that appears in the video and in the event log, and costs two
seconds of pointer movement per recording that nobody wants to watch.

## Recipe: freezing the clock and randomness

Two recordings only look identical if the interface looks identical. Two
things make sure it does not: relative times ("3 minutes ago") and everything
that comes out of `Math.random()`. The `fixedTime` export nails down both —
the clock through Playwright's `clock.setFixedTime`, the randomness through a
replacement for `Math.random` with a fixed seed (`freezeTimeAndRandomness` in
[`src/recipes.ts`](../src/recipes.ts)).

**Do not use `clock.install()`.** By Playwright's own description that fakes
`requestAnimationFrame` and `performance` alongside `Date` — and those two are
exactly what drives, inside the page, the measurement the wrapper uses before
every interaction to check whether the target's geometry stands still
(`observeFrames` in `src/record.ts`). A faked frame loop delivers no more
frames to that measurement; the interaction then runs into `settleTimeoutMs`
instead of into a click. `setFixedTime` touches only `Date` and leaves the
frame loop alone.

`record()`'s own seed (`seed`) covers something different: the randomness of
the pointer movement and of the typing delays. Same `seed`, same track. It
does not reach the randomness **of the page** — that is what the init script is
for.

## The trap that catches every injected script

All demo scripts in this repository run through `tsx`, and `tsx` compiles with
esbuild's `keepNames`. That wraps every **named** function in an inserted
`__name(...)` call. Playwright serialises the source text of a payload for
`page.evaluate` or `addInitScript` into the page — and there is no `__name`
there. Result: `ReferenceError: __name is not defined`, and only in a real
run, never in the Vitest suite, because that compiles without `keepNames`.
`tests/tsx-pipeline.test.ts` catches exactly this by starting
`demo/record-smoke.ts` as a real subprocess.

For your own payloads that means:

- Keep functions anonymous — pass `function () { … }` directly as the argument,
  not `function tick() { … }` and not `const tick = () => …` (esbuild derives
  the name from the assignment too).
- Assignment to a **property** of an existing object is the one form the name
  derivation does not catch — `Math.random = () => …` is therefore safe, and
  `src/record.ts` uses the same trick.
- Safest is a payload as a string: that is never compiled. That is how
  `hideOverlay` in `src/recipes.ts` does it.

## When it aborts

| Message (excerpt)                                       | Cause and remedy                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `has no visible intersection with the … viewport`       | The target lies outside the frame. There is no automatic scrolling — put a `demo.scroll` before it. |
| `Target moved during pointer travel …`                  | The target wandered off during the approach. Better an abort than a click that never happened.      |
| `Unknown device "…". Close names: …`                    | Device name not in Playwright's registry; the message names similar ones.                           |
| `Target geometry did not settle within settleTimeoutMs` | The page does not come to rest. Raise the budget, or switch off the permanent background animation. |

## What does not exist yet

So that nobody goes looking for it:

- **Mobile recordings** — `device` already resolves Playwright's profiles, but
  portrait video, touch rendering and the WebKit-versus-Chromium question are
  M3.
- **Zoom, rendered pointer, idle compression, aspect ratios** — post-processing
  from the event log is M4.
- **Presets and custom capture/output fields** — M5.
- **Mobile through the command** — `featurecast run` exists, but every mobile
  preset aborts with the M3 notice, and `desktop`/`safari` with the unresolved
  dispute over the capture area. What can be recorded today is `desktop-wide`.
