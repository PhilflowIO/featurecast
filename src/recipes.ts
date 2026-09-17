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
 * Pins `Date` to one instant and replaces `Math.random` with a seeded
 * generator, so two runs of the same script render the same relative
 * timestamps and the same "random" sample data.
 *
 * `clock.setFixedTime` is used rather than `clock.install`: `install`
 * also fakes `requestAnimationFrame` and `performance`, and the recorder's
 * geometry settling is driven by exactly those two in page context
 * (`observeFrames` in `src/record.ts`), so an installed fake clock would
 * starve it until `settleTimeoutMs` runs out.
 *
 * The `Math.random` payload assigns an arrow function to a property of an
 * existing object. That is the one shape esbuild's name inference does not
 * cover, so it survives the `keepNames` compile described above.
 */
export async function freezeTimeAndRandomness(
  context: BrowserContext,
  fixedTime: string,
): Promise<void> {
  await context.clock.setFixedTime(new Date(fixedTime))
  await context.addInitScript(() => {
    let state = 0x2f6e2b1
    Math.random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x1_0000_0000
    }
  })
}
