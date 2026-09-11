import { fileURLToPath } from 'node:url'

import { record } from '../src/record.js'

/**
 * Exercises `demo.scroll`'s eased, distance-over-time cadence (issue #15)
 * through the real `tsx` CLI in a separate OS process each run — the
 * strongest available proof that `events.jsonl` is bit-identical across
 * runs, since two Node processes share nothing but the script and the seed.
 * See tests/scroll-cadence-determinism.test.ts, which runs this file twice
 * and `cmp`s the output.
 */
const FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0;height:3000px">' +
      '<button id="a" style="position:absolute;left:20px;top:20px;width:60px;height:30px;">A</button>' +
      '</body></html>',
  )

export async function runScrollCadenceSmoke(out: string): Promise<void> {
  await record({ out, seed: 5 }, async (page, demo) => {
    await page.goto(FIXTURE_URL)
    await demo.click('#a')
    // Default speed, then an explicit override — both scroll code paths.
    await demo.scroll(0, 525)
    await demo.scroll(120, -40, { speedPxPerSecond: 900 })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runScrollCadenceSmoke(
    process.argv[2] ?? 'artifacts/scroll-cadence-smoke',
  )
}
