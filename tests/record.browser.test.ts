import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

import {
  record,
  type BoundingBox,
  type Demo,
  type RecordPage,
} from '../src/record.js'

/**
 * M2 acceptance: proves the wrapper's contract against a real headless
 * Chromium, not only the fast `fakePage()` unit tests in record.test.ts.
 * Ground truth for every bbox check comes from `getBoundingClientRect()`
 * evaluated in the page — never from `locator.boundingBox()`, which is what
 * `src/record.ts` itself uses to build the log. Reusing the same API on both
 * sides would prove the wrapper agrees with itself, not that it is correct.
 */

const ARTIFACTS_ROOT = 'artifacts/m2-001'
const FIXTURE_HTML =
  '<!doctype html><html><body style="margin:0;height:2400px;position:relative">' +
  '<button id="far" style="position:absolute;left:20px;top:20px;width:60px;height:30px;">Far</button>' +
  '<button id="save" style="position:absolute;left:150px;top:300px;width:100px;height:40px;">Save</button>' +
  '<input id="title" style="position:absolute;left:20px;top:400px;width:200px;height:30px;" />' +
  '<button id="a" style="position:absolute;left:60px;top:60px;width:60px;height:30px;">A</button>' +
  '<button id="below" style="position:absolute;left:60px;top:1200px;width:100px;height:40px;" ' +
  'onclick="window.__belowClicked=true">Below</button>' +
  '</body></html>'
const FIXTURE_URL = `data:text/html,${encodeURIComponent(FIXTURE_HTML)}`

function roundBox(box: BoundingBox): BoundingBox {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}

/** Independent ground truth: raw DOM geometry, not Playwright's element API. */
async function getBoundingClientRect(
  page: Page,
  selector: string,
): Promise<BoundingBox> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel)
    if (element === null) throw new Error(`Fixture is missing ${sel}`)
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }, selector)
}

describe('record against a real headless Chromium', () => {
  it('produces bit-identical, jump-capped, bbox-accurate events.jsonl across two runs', async () => {
    const runA = join(ARTIFACTS_ROOT, 'run-a')
    const runB = join(ARTIFACTS_ROOT, 'run-b')
    await rm(runA, { force: true, recursive: true })
    await rm(runB, { force: true, recursive: true })

    const script = async (page: RecordPage, demo: Demo) => {
      await page.goto(FIXTURE_URL)
      await demo.point('#far')
      await demo.click('#save')
      await demo.type('#title', 'Featurecast')
      await demo.scroll(0, 80)
    }

    await record({ out: runA, seed: 42 }, script)
    await record({ out: runB, seed: 42 }, script)

    const logA = await readFile(join(runA, 'events.jsonl'), 'utf8')
    const logB = await readFile(join(runB, 'events.jsonl'), 'utf8')
    expect(logB).toBe(logA)

    const events = logA
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const pointerEvents = events.filter((event) => event.type === 'pointer')
    let maxStep = 0
    for (let index = 1; index < pointerEvents.length; index += 1) {
      const previous = pointerEvents[index - 1]!
      const current = pointerEvents[index]!
      maxStep = Math.max(
        maxStep,
        Math.hypot(
          Number(current.x) - Number(previous.x),
          Number(current.y) - Number(previous.y),
        ),
      )
    }
    expect(maxStep).toBeLessThanOrEqual(20)

    const browser = await chromium.launch({ headless: true })
    try {
      const page = await (await browser.newContext()).newPage()
      await page.goto(FIXTURE_URL)
      const expectedSave = roundBox(await getBoundingClientRect(page, '#save'))
      const expectedTitle = roundBox(
        await getBoundingClientRect(page, '#title'),
      )

      const click = events.find((event) => event.type === 'click')
      const typed = events.find((event) => event.type === 'type')
      expect(click).toMatchObject({ bbox: expectedSave })
      expect(typed).toMatchObject({ bbox: expectedTitle })
    } finally {
      await browser.close()
    }
  }, 30_000)

  it('resolves a fresh bounding box and actually hits the target after a scroll settles', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-scroll-click')
    await rm(out, { force: true, recursive: true })

    let belowRectAfterScroll: BoundingBox | undefined
    let belowClicked: unknown

    await record({ out, seed: 3 }, async (page, demo) => {
      await page.goto(FIXTURE_URL)
      await demo.click('#a')
      await demo.scroll(0, 900)
      // Independent ground truth captured live, in-page, right after the
      // scroll our own wrapper considers settled — not recomputed later
      // from a second, separately loaded page.
      belowRectAfterScroll = await page.evaluate(() => {
        const element = document.querySelector('#below')
        if (element === null) throw new Error('Fixture is missing #below')
        const rect = element.getBoundingClientRect()
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }
      })
      await demo.click('#below')
      belowClicked = await page.evaluate(
        () =>
          (window as unknown as { __belowClicked?: boolean }).__belowClicked,
      )
    })

    // Proves the click landed on the real element, not merely that some
    // bbox happened to match — a stale bbox can still log plausible
    // numbers while the synthetic click misses in the live page.
    expect(belowClicked).toBe(true)

    const log = await readFile(join(out, 'events.jsonl'), 'utf8')
    const events = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const clicks = events.filter((event) => event.type === 'click')
    const belowClick = clicks.at(-1)
    expect(belowClick).toMatchObject({
      bbox: roundBox(belowRectAfterScroll!),
    })
  }, 30_000)

  it('taps through a real touch device context instead of crashing on hasTouch', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-touch')
    await rm(out, { force: true, recursive: true })

    await record(
      { device: 'iPhone 15 Pro', out, seed: 1 },
      async (page, demo) => {
        await page.goto(FIXTURE_URL)
        await demo.tap('#save')
      },
    )

    const log = await readFile(join(out, 'events.jsonl'), 'utf8')
    const events = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const tap = events.find((event) => event.type === 'tap')
    expect(tap).toBeDefined()
    expect(tap).toMatchObject({ bbox: { width: 100, height: 40 } })
  }, 30_000)

  it('rejects an unknown device name with the available names, not a crash', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-unknown-device')
    await rm(out, { force: true, recursive: true })

    await expect(
      record(
        { device: 'Nonexistent Device 9000', out, seed: 1 },
        async (page) => {
          await page.goto(FIXTURE_URL)
        },
      ),
    ).rejects.toThrow(/Unknown device/)
  }, 30_000)

  it('really waits at least the requested duration during hold', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-hold')
    await rm(out, { force: true, recursive: true })

    const started = Date.now()
    await record({ out, seed: 1 }, async (page, demo) => {
      await page.goto(FIXTURE_URL)
      await demo.hold(500)
    })
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(500)
  }, 15_000)
})
