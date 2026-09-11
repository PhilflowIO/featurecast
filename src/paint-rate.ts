import type { Page } from 'playwright'

/**
 * Starts an in-page `requestAnimationFrame` counter that timestamps every
 * paint in the same `Date.now()`-domain clock `capture.ts`'s manifest and
 * `m1-benchmark.ts`'s motion windows already use, so painted-frame counts
 * can be compared against captured-frame counts window-by-window without a
 * second clock to reconcile (`src/efficiency.ts` does that comparison).
 *
 * Must be called once, before the scripted interactions begin, on the same
 * `page` `captureScreencast` is attached to. Survives OnlyDash's
 * client-side table switches (a React Router route change keeps the same
 * JS realm); a full page navigation would reset the counter to empty, which
 * is the correct behaviour for a fresh realm, not a bug to guard against —
 * this milestone's benchmark only navigates once, in `warmUpOnlyDash`,
 * before this is called.
 */
export async function startPaintRateProbe(page: Page): Promise<void> {
  // A raw source string, not a compiled closure: `tsx`/esbuild injects a
  // `__name(fn, "tick")` call for the named local function below (to
  // preserve `Function.prototype.name` across its own bundling), and that
  // helper does not exist in the standalone browser-side realm
  // `page.evaluate` runs a closure's `toString()` in — every other
  // `page.evaluate` call in this codebase happens to be a single expression
  // with no local named binding, which is why this has not surfaced before.
  // A string literal is sent to the browser byte-for-byte and never passes
  // through that transform.
  await page.evaluate(`
    (function () {
      window.__featurecastPaintTimestamps = [];
      function tick() {
        window.__featurecastPaintTimestamps.push(Date.now());
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    })();
  `)
}

/** Reads back every paint timestamp recorded since `startPaintRateProbe`. */
export async function readPaintTimestamps(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __featurecastPaintTimestamps?: number[] })
        .__featurecastPaintTimestamps ?? [],
  )
}
