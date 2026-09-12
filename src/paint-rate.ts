import type { Page } from 'playwright'

/**
 * Starts an in-page change-tick probe: timestamps every vsync tick
 * (`Date.now()`-domain, the same clock `capture.ts`'s manifest and
 * `m1-benchmark.ts`'s motion windows already use) **during which the page
 * gave evidence of an actual visual change**.
 *
 * **This is context, not a frame count, and it must never be a
 * denominator again.** It was one until #21, and it was wrong in the
 * direction that hides failure: the callback runs on the renderer's main
 * thread, while smooth scrolling is driven by the compositor thread and
 * keeps presenting frames whether or not the main thread gets a slice. So
 * during exactly the motion this project exists to record, the count is too
 * low — measured in one real window, 66 frames presented against 51 ticks
 * seen. `captured / ticks` therefore rises as the machine degrades, and on
 * a real acceptance run it reported 100.9% capture efficiency, which the
 * 95% gate passed. No filter fixes this; the signal simply is not
 * observable from the main thread. Chromium's own presented-frame count is
 * (`src/presented.ts`), and that is what `src/efficiency.ts` divides by
 * now. What this probe still tells you is how much of the page's motion the
 * page's own JavaScript could see, which is worth reporting beside the
 * presented count, and nothing more.
 *
 * Deliberately not a raw `requestAnimationFrame` tick count. A registered
 * `requestAnimationFrame` callback fires on every vsync for a visible tab
 * **regardless of whether the compositor produced a new frame** — proven
 * directly against a real M1 acceptance run (`artifacts/m1-007`): every
 * `*:sort-desc` motion window (a click that produces no further visible
 * change, immediately followed by a scripted 400ms wait —
 * `sortFirstColumn`'s second call in `src/m1-benchmark.ts`) ticked a clean
 * ~60-61fps of raw rAF while `captureScreencast` correctly captured **zero**
 * new frames, because the screencast only fires on an actual repaint. A raw
 * rAF count would score that window's capture efficiency at 0% for a window
 * this pipeline handled perfectly. This probe instead only timestamps a
 * tick when at least one of three change signals fired since the previous
 * tick: a DOM mutation (`MutationObserver`, covers real content
 * changes — e.g. MUI DataGrid row virtualization), a `scroll` event
 * (capture-phase, covers scrolling a container that doesn't itself mutate
 * the DOM), or a currently-running CSS animation/transition
 * (`document.getAnimations()`, covers compositor-only `@keyframes`
 * animation that produces neither a DOM mutation nor a scroll event, such
 * as this milestone's own synthetic light/dense cadence fixtures).
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
  // `__name(fn, "tick")` call for named local functions (to preserve
  // `Function.prototype.name` across its own bundling), and that helper does
  // not exist in the standalone browser-side realm `page.evaluate` runs a
  // closure's `toString()` in — every other `page.evaluate` call in this
  // codebase happens to be a single expression with no local named binding,
  // which is why this has not surfaced before. A string literal is sent to
  // the browser byte-for-byte and never passes through that transform.
  await page.evaluate(`
    (function () {
      window.__featurecastPaintTimestamps = [];
      var mutatedSinceLastTick = false;
      var scrolledSinceLastTick = false;
      new MutationObserver(function () {
        mutatedSinceLastTick = true;
      }).observe(document.documentElement, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      document.addEventListener(
        'scroll',
        function () {
          scrolledSinceLastTick = true;
        },
        { capture: true, passive: true },
      );
      function hasRunningAnimation() {
        if (!document.getAnimations) return false;
        var animations = document.getAnimations();
        for (var i = 0; i < animations.length; i++) {
          if (animations[i].playState === 'running') return true;
        }
        return false;
      }
      function tick() {
        if (mutatedSinceLastTick || scrolledSinceLastTick || hasRunningAnimation()) {
          window.__featurecastPaintTimestamps.push(Date.now());
        }
        mutatedSinceLastTick = false;
        scrolledSinceLastTick = false;
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
