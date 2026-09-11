import { fileURLToPath } from 'node:url'

import { record } from '../src/record.js'

/**
 * Exercises record()'s full interaction surface (goto, click, scroll, the
 * settle-on-read path, click again) through the real `tsx` CLI, not Vitest.
 * This matters because Vitest's esbuild transform does not set keepNames,
 * so a bug where a named function inside a `page.evaluate()` payload breaks
 * under tsx's `keepNames: true` (esbuild injects `__name(...)`, which does
 * not exist once Playwright serializes the closure into the browser) can
 * pass every in-process test and still crash for real. See
 * tests/tsx-pipeline.test.ts, which runs this file as a subprocess.
 */
const FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0;height:1400px">' +
      '<button id="a" style="position:absolute;left:20px;top:20px;width:60px;height:30px;">A</button>' +
      '<button id="b" style="position:absolute;left:20px;top:1000px;width:60px;height:30px;">B</button>' +
      '</body></html>',
  )

export async function runRecordSmoke(out: string): Promise<void> {
  await record({ out, seed: 1 }, async (page, demo) => {
    await page.goto(FIXTURE_URL)
    await demo.click('#a')
    await demo.scroll(0, 900)
    // Resolving '#b' right after the scroll is what exercises the
    // settle-on-read polling path in src/record.ts.
    await demo.click('#b')
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runRecordSmoke(process.argv[2] ?? 'artifacts/tsx-smoke')
}
