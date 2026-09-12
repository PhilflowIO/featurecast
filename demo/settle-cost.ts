import { record } from '../src/record.js'

/**
 * Settle cost against a genuinely still page: one interaction, and ten.
 * Timed inside the script so browser launch and `goto` are excluded; the
 * pointer travel is identical on both sides of the comparison, so the
 * difference between two builds is the settle criterion.
 */
const buttons = Array.from(
  { length: 10 },
  (_unused, index) =>
    `<button id="b${String(index)}" style="position:absolute;left:${String(
      100 + index * 100,
    )}px;top:${String(80 + index * 50)}px;width:80px;height:40px;">B</button>`,
).join('')
const URL =
  'data:text/html,' +
  encodeURIComponent(
    `<!doctype html><html><body style="margin:0">${buttons}</body></html>`,
  )

async function run(
  count: number,
  label: string,
  index: number,
): Promise<number> {
  let elapsed = 0
  await record(
    { out: `artifacts/settle-cost/${label}-${String(index)}`, seed: 3 },
    async (page, demo) => {
      await page.goto(URL)
      const started = Date.now()
      for (let i = 0; i < count; i += 1) await demo.click(`#b${String(i)}`)
      elapsed = Date.now() - started
    },
  )
  return elapsed
}

const mean = (values: number[]): number =>
  Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)

const single: number[] = []
const ten: number[] = []
for (let index = 0; index < 3; index += 1) {
  single.push(await run(1, 'single', index))
  ten.push(await run(10, 'ten', index))
}
console.log(
  'single still target ms:',
  single.join(', '),
  '-> mean',
  mean(single),
)
console.log('ten interactions ms:', ten.join(', '), '-> mean', mean(ten))
