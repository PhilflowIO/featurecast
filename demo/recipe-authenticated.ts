import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import type { BrowserContext } from 'playwright'

import {
  launchChromium,
  resolveBrowserRequest,
  writeBrowserProvenance,
} from '../src/browser.js'
import {
  createRecorder,
  type Demo,
  type RecordPage,
  type RecordRuntime,
} from '../src/record.js'

/**
 * The three M7 recipes in one runnable piece: a signed-in session restored
 * from `storageState`, a cookie banner hidden before the page's own scripts
 * run, and a frozen wall clock plus a seeded `Math.random`.
 *
 * None of this needs a change inside `src/record.ts`. `record()`'s default
 * runtime builds its own context and offers no seam for any of it, so the
 * recipes hang off the documented `RecordRuntime` seam instead
 * (`createRecorder`), exactly the way `demo/m1-capture.ts` attaches the
 * wrapper to a capture's own page.
 *
 * See `docs/RECORDING-SCRIPTS.md` for the prose version.
 */

export type RecipeSettings = {
  /** CSS selector of the consent overlay to hide; omit to hide nothing. */
  bannerSelector?: string
  /** Wall clock every recording should claim, e.g. `2026-01-15T09:00:00Z`. */
  fixedTime?: string
  /** Directory that receives `events.jsonl` and `browser.json`. */
  out: string
  /** Seed for pointer motion and keystroke delays. */
  seed?: number
  /** Playwright `storageState` file written by a prior sign-in. */
  storageStatePath?: string
  /** Budget per interaction for the page's own animations to settle. */
  settleTimeoutMs?: number
}

/**
 * Hides a consent overlay for every document of the context, before the
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
  selector: string,
): Promise<void> {
  const css = JSON.stringify(`${selector}{display:none!important}`)
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

/**
 * Runs `script` through the `demo` wrapper against a context that carries
 * the saved session, the hidden overlay and the frozen clock.
 */
export async function recordWithRecipes(
  settings: RecipeSettings,
  script: (page: RecordPage, demo: Demo) => Promise<void>,
): Promise<void> {
  const runtime: RecordRuntime = {
    async run(options, run) {
      const { browser, provenance } = await launchChromium(
        { headless: true },
        resolveBrowserRequest(process.env),
      )
      try {
        // `createRecorder` creates `options.out` itself before writing
        // `events.jsonl`, but that happens after this runtime returns —
        // `browser.json` is written now, so the directory has to exist now.
        await mkdir(options.out, { recursive: true })
        await writeBrowserProvenance(options.out, provenance)
        const context = await browser.newContext({
          storageState: settings.storageStatePath,
          viewport: { height: 720, width: 1280 },
        })
        try {
          if (settings.bannerSelector !== undefined) {
            await hideOverlay(context, settings.bannerSelector)
          }
          if (settings.fixedTime !== undefined) {
            await freezeTimeAndRandomness(context, settings.fixedTime)
          }
          const page = await context.newPage()
          const recordPage = page as unknown as RecordPage
          // The wrapper picks tap over click from this flag; a desktop
          // context has no touch.
          recordPage.hasTouch = false
          await run(recordPage)
        } finally {
          await context.close()
        }
      } finally {
        await browser.close()
      }
    },
  }

  await createRecorder(runtime)(
    {
      out: settings.out,
      seed: settings.seed ?? 1,
      settleTimeoutMs: settings.settleTimeoutMs,
    },
    script,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, out] = process.argv.slice(2)
  if (url === undefined) {
    throw new Error(
      'Usage: tsx demo/recipe-authenticated.ts <url> [out-directory]',
    )
  }
  await recordWithRecipes(
    {
      bannerSelector: '#cookie-banner',
      fixedTime: '2026-01-15T09:00:00Z',
      out: out ?? 'artifacts/recipe-authenticated',
      seed: 1,
      storageStatePath: 'auth/state.json',
    },
    async (page, demo) => {
      await page.goto(url)
      await demo.point('h1')
      await demo.hold(800)
    },
  )
}
