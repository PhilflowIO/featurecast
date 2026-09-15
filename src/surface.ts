import type { Frame, Page } from 'playwright'

import type { LocatorLike, RecordPage } from './record.js'

/**
 * The seam between "the document being filmed" and "the page being
 * recorded". For a desktop capture those are the same thing; for a framed
 * mobile capture they are not, and every difference between them lives here.
 *
 * `src/record.ts` needs a page-shaped object with three unrelated
 * capabilities: it queries elements, it drives input, and it asks how large
 * the picture is. Only the first belongs to the application's own document.
 * Input is delivered to the browser page as a whole — there is one pointer,
 * not one per frame — and the picture is the recorded area, which is the
 * shell's viewport rather than the app's. So the facade below is not a
 * wrapper around a page: it is the composition of two objects, and which
 * member comes from which is the point of it.
 */

/**
 * Builds the object the recording script is driven against.
 *
 * `scale` is picture pixels per application pixel — 1 for a direct capture.
 *
 * The recorder speaks one language throughout: the picture's. Playwright
 * already reports `boundingBox` and takes input in main-frame coordinates,
 * and the two page-side measurements that do *not* — the box sampled every
 * frame and the hit test — convert themselves, because a same-origin shell
 * lets the application read its own seat in the picture (`src/record.ts`,
 * `observeFrames` and `hitTestPoints`).
 *
 * That leaves wheel deltas as the one conversion with nowhere else to live.
 * A wheel event scrolls the application's own document in the application's
 * own pixels, and the transform then magnifies that travel. Dividing here
 * keeps every constant in `src/record.ts` — the px/s scroll speed, the
 * per-step travel cap — a statement about the finished picture, which is
 * what they were measured as.
 */
/**
 * A Playwright `Locator` narrowed to what the recorder uses.
 *
 * The narrowing is not cosmetic. `Locator.evaluate` types its argument
 * through `Unboxed<Arg>` — the transform a value undergoes crossing into the
 * page — and `LocatorLike` types it as the plain `Arg` the recorder passes.
 * The two are the same value on both sides of a structural clone, but
 * TypeScript cannot know that, so the conversion is stated once, here, rather
 * than by casting the whole page object and losing every other check with it.
 */
function locatorFor(frame: Frame, selector: string): LocatorLike {
  const locator = frame.locator(selector)
  return {
    boundingBox: async () => locator.boundingBox(),
    evaluate: async (pageFunction, arg) =>
      locator.evaluate(
        pageFunction as Parameters<typeof locator.evaluate>[0],
        arg,
      ),
  }
}

export function recordPageFor(
  frame: Frame,
  page: Page,
  options: { hasTouch: boolean; scale: number },
): RecordPage {
  const { hasTouch, scale } = options
  return {
    evaluate: async (pageFunction) => frame.evaluate(pageFunction),
    goto: async (url) => {
      await frame.goto(url)
    },
    hasTouch,
    keyboard: {
      type: async (text) => {
        await page.keyboard.type(text)
      },
    },
    locator: (selector) => locatorFor(frame, selector),
    mouse: {
      click: async (x, y) => {
        await page.mouse.click(x, y)
      },
      move: async (x, y, moveOptions) => {
        await page.mouse.move(x, y, moveOptions)
      },
      wheel: async (deltaX, deltaY) => {
        await page.mouse.wheel(deltaX / scale, deltaY / scale)
      },
    },
    touchscreen: {
      tap: async (x, y) => {
        await page.touchscreen.tap(x, y)
      },
    },
    viewportSize: () => page.viewportSize(),
    waitForTimeout: async (milliseconds) => {
      await page.waitForTimeout(milliseconds)
    },
  }
}
