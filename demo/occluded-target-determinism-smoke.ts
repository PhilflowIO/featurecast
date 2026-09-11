import { fileURLToPath } from 'node:url'

import { record } from '../src/record.js'

/**
 * Issue #13 acceptance: `events.jsonl` must stay bit-identical across
 * *separate OS processes* when the interaction point comes from the probe
 * grid rather than the plain center. Two Node processes share nothing but
 * this script and the seed, so any dependence on iteration order,
 * event-loop scheduling or wall-clock timing inside the flood fill would
 * show up as a hash difference here even though running the same script
 * twice in one process could never reveal it. See
 * tests/occluded-target-determinism.test.ts, which runs this file three
 * times and compares sha256(events.jsonl).
 */
const FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
      '<div style="position:fixed;left:0;top:0;width:100%;height:230px;' +
      'background:#ccc;z-index:9"></div>' +
      '<div style="position:fixed;left:0;top:260px;width:100%;' +
      'height:2000px;background:#ccc;z-index:9"></div>' +
      '<button id="t" style="position:absolute;left:600px;top:0;width:80px;' +
      'height:300px;" onclick="window.__clicked=true">T</button>' +
      '</body></html>',
  )

export async function runOccludedTargetDeterminismSmoke(
  out: string,
): Promise<void> {
  await record({ out, seed: 3 }, async (page, demo) => {
    await page.goto(FIXTURE_URL)
    await demo.click('#t')
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out] = process.argv.slice(2)
  await runOccludedTargetDeterminismSmoke(
    out ?? 'artifacts/occluded-target-determinism-smoke',
  )
}
