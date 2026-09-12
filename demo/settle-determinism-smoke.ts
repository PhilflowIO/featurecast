import { fileURLToPath } from 'node:url'

import { record } from '../src/record.js'

/**
 * Issue #12 acceptance: `events.jsonl` must be bit-identical across
 * *separate OS processes* for a target whose geometry never stops
 * changing. Two Node processes share nothing but this script and the seed,
 * so any remaining dependence on animation phase, event-loop scheduling or
 * machine load shows up as a hash difference here even though running the
 * same script twice inside one process could never reveal it. See
 * tests/settle-determinism.test.ts, which runs this file three times per
 * case — under load, because that is where the guarantee broke.
 */
const FIXTURES: Record<string, string> = {
  // Extent oscillates forever around a fixed centre.
  pulsing:
    'data:text/html,' +
    encodeURIComponent(
      '<!doctype html><html><body style="margin:0">' +
        '<style>@keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.6)}' +
        '100%{transform:scale(1)}}#t{position:absolute;left:600px;top:300px;' +
        'width:80px;height:40px;animation:pulse 0.3s linear infinite}</style>' +
        '<button id="t" onclick="window.__clicked=true">Go</button>' +
        '</body></html>',
    ),
  // The centre itself moves, not just the extent. This is the case three
  // processes disagreed on by one pixel, in the click point and the box.
  bounce:
    'data:text/html,' +
    encodeURIComponent(
      '<!doctype html><html><body style="margin:0">' +
        '<style>@keyframes bounce{0%{transform:translateY(0)}' +
        '50%{transform:translateY(15px)}100%{transform:translateY(0)}}' +
        '#t{position:absolute;left:600px;top:300px;width:80px;height:40px;' +
        'animation:bounce 0.4s ease-in-out infinite}' +
        '</style><button id="t" onclick="window.__clicked=true">Go</button>' +
        '</body></html>',
    ),
  // Rests 70% of every cycle and briefly peaks: the box logged here is
  // decided by the dwell histogram, not by an average.
  asymmetric:
    'data:text/html,' +
    encodeURIComponent(
      '<!doctype html><html><body style="margin:0">' +
        '<style>@keyframes peak{0%,70%{transform:scale(1)}' +
        '85%{transform:scale(1.6)}100%{transform:scale(1)}}' +
        '#t{position:absolute;left:600px;top:300px;width:80px;height:40px;' +
        'animation:peak 1s linear infinite}</style>' +
        '<button id="t" onclick="window.__clicked=true">Go</button>' +
        '</body></html>',
    ),
}

export async function runSettleDeterminismSmoke(
  caseName: string,
  out: string,
): Promise<void> {
  const url = FIXTURES[caseName]
  if (url === undefined) {
    throw new Error(
      `Unknown settle determinism case "${caseName}". Known: ${Object.keys(FIXTURES).join(', ')}`,
    )
  }
  await record(
    { out, seed: 3, settleTimeoutMs: 15_000 },
    async (page, demo) => {
      await page.goto(url)
      await demo.click('#t')
    },
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [caseName, out] = process.argv.slice(2)
  await runSettleDeterminismSmoke(
    caseName ?? 'pulsing',
    out ?? 'artifacts/settle-determinism-smoke',
  )
}
