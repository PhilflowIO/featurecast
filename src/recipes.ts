import type { BrowserContext } from 'playwright'

/**
 * What a browser context carries before its first page exists.
 *
 * Everything in here is a context-level fact — an init script, a clock, a
 * restored session — and that is exactly why none of it can live in a
 * recording script. A script is handed a page that is already open; by then
 * the session is either restored or not, and an init script can no longer
 * run before the page's own scripts. So the chain has to apply it, and the
 * script can only *name* it (`src/pipeline.ts`, `LoadedScript`).
 *
 * These two were written for `demo/recipe-authenticated.ts`, which drove its
 * own browser and produced an event log but no frames. They moved here
 * unchanged; the recipe file is gone, because with the chain doing this
 * there is nothing left for it to do.
 */

/**
 * Hides the named surfaces for every document of the context, before the
 * page's own scripts run.
 *
 * The payload is a plain string on purpose. A function payload is compiled
 * by `tsx` with esbuild's `keepNames`, which wraps every named function in
 * an injected `__name(...)` that does not exist once Playwright serializes
 * the source text into the page (`tests/tsx-pipeline.test.ts`). A string is
 * never compiled at all, so the question cannot arise.
 */
export async function hideOverlay(
  context: BrowserContext,
  selectors: readonly string[],
): Promise<void> {
  if (selectors.length === 0) return
  // One rule per selector, never one comma-joined group. A group selector is
  // parsed as a unit: a single selector the browser does not understand makes
  // it drop the entire rule, and the valid selectors next to it go silently
  // unhidden. Separate rules fail one at a time.
  const css = JSON.stringify(
    selectors
      .map((selector) => `${selector}{display:none!important}`)
      .join('\n'),
  )
  await context.addInitScript(
    '(function () {' +
      `  var css = ${css};` +
      '  var inject = function () {' +
      '    var style = document.createElement("style");' +
      '    style.textContent = css;' +
      '    (document.head || document.documentElement).appendChild(style);' +
      '  };' +
      '  if (document.documentElement) { inject(); }' +
      '  else { document.addEventListener("DOMContentLoaded", inject); }' +
      '})()',
  )
}

/**
 * Starts every document's `Date` at one instant and replaces `Math.random`
 * with a seeded generator, so two runs of the same script render the same
 * relative timestamps and the same "random" sample data.
 *
 * `Date` is the only clock that is touched. It begins at `fixedTime` when the
 * document starts and runs forward at real speed from there, measured on the
 * page's own `performance.now()`. `performance`, `requestAnimationFrame`, the
 * timers and the animation timeline stay the browser's own.
 *
 * Why not Playwright's clock (featurecast#144). `clock.setFixedTime` was used
 * here, on the belief that it touches only `Date`. It does not: it installs
 * Playwright's whole fake clock first, which replaces `performance`,
 * `requestAnimationFrame` and the timers. The fake `performance.now()` then
 * drifts away from `document.timeline`, the clock the browser runs Web
 * Animations on — measured at 3.6 s. Framer Motion starts its accelerated
 * animations with `startTime = performance.now()`, so under the fake clock
 * each one began seconds in the future and held its first keyframe. On
 * Raven that keyframe is `opacity: 0`: the DOM had the meeting rows, the
 * screencast filmed an empty card. The same fake frame loop also halved the
 * frames the screencast delivered (87 against 179 for one script), and it
 * would starve the recorder's own settling, which runs on
 * `requestAnimationFrame` (`observeFrames` in `src/record.ts`).
 *
 * Why `Date` keeps running instead of standing still. A page measures elapsed
 * time with `Date.now()` as often as with timers — lodash's `debounce` does —
 * and a clock that never moves never lets such a wait end. Seconds of drift
 * cannot change "3 days ago".
 *
 * Both payloads avoid named functions, for the `keepNames` trap described on
 * `hideOverlay`: the `Date` one is a plain string, and the `Math.random` one
 * assigns an arrow function to a property of an existing object, the one shape
 * esbuild's name inference does not cover.
 */
export async function pinClockAndRandomness(
  context: BrowserContext,
  fixedTime: string,
): Promise<void> {
  const startMs = new Date(fixedTime).getTime()
  if (Number.isNaN(startMs)) {
    throw new Error(`fixedTime is not an instant a Date can read: ${fixedTime}`)
  }
  await context.addInitScript(
    '(function () {' +
      '  var Real = Date;' +
      `  var start = ${String(startMs)};` +
      '  var origin = performance.now();' +
      '  var now = function () {' +
      '    return start + Math.floor(performance.now() - origin);' +
      '  };' +
      '  var Pinned = function () {' +
      '    if (!new.target) return new Real(now()).toString();' +
      '    var args = arguments.length === 0 ? [now()] : Array.prototype.slice.call(arguments);' +
      '    return Reflect.construct(Real, args, new.target);' +
      '  };' +
      '  Object.setPrototypeOf(Pinned, Real);' +
      '  Pinned.prototype = Real.prototype;' +
      '  Pinned.now = now;' +
      '  Pinned.parse = Real.parse;' +
      '  Pinned.UTC = Real.UTC;' +
      '  Object.defineProperty(Pinned, "name", { value: "Date" });' +
      '  Object.defineProperty(Pinned, "length", { value: 7 });' +
      '  globalThis.Date = Pinned;' +
      '})()',
  )
  await context.addInitScript(() => {
    let state = 0x2f6e2b1
    Math.random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x1_0000_0000
    }
  })
}
