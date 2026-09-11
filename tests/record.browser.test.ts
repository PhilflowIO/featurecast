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
  '<!doctype html><html><body style="margin:0;height:3700px;position:relative">' +
  '<button id="far" style="position:absolute;left:20px;top:20px;width:60px;height:30px;">Far</button>' +
  '<button id="save" style="position:absolute;left:150px;top:300px;width:100px;height:40px;">Save</button>' +
  '<input id="title" style="position:absolute;left:20px;top:400px;width:200px;height:30px;" />' +
  '<button id="a" style="position:absolute;left:60px;top:60px;width:60px;height:30px;">A</button>' +
  '<button id="below" style="position:absolute;left:60px;top:1200px;width:100px;height:40px;" ' +
  'onclick="window.__belowClicked=true">Below</button>' +
  '<div id="hero" style="position:absolute;left:0;top:1600px;width:2000px;height:2000px;" ' +
  'onclick="window.__heroClicked=true"></div>' +
  '<button id="edge" style="position:absolute;left:1270px;top:1610px;width:20px;height:20px;" ' +
  'onclick="window.__edgeClicked=true">E</button>' +
  '</body></html>'
const FIXTURE_URL = `data:text/html,${encodeURIComponent(FIXTURE_HTML)}`

/**
 * A JS-driven inertial scroller (Lenis-style): a `wheel` handler animates an
 * inner `transform: translateY()` over several requestAnimationFrame ticks.
 * It never touches `window.scrollX/Y` at all, which is exactly the case a
 * settle check keyed on the window's own scroll offset would silently miss.
 */
const INNER_SCROLL_FIXTURE_HTML =
  '<!doctype html><html><body style="margin:0;overflow:hidden;height:100vh">' +
  '<div id="viewport" style="position:relative;overflow:hidden;height:100vh;">' +
  '<div id="track" style="position:absolute;left:0;top:0;width:100%;">' +
  '<button id="above" style="position:absolute;left:20px;top:20px;width:60px;height:30px;">Above</button>' +
  '<button id="below-inner" style="position:absolute;left:20px;top:1200px;width:100px;height:40px;" ' +
  'onclick="window.__innerBelowClicked=true">Below</button>' +
  '<div style="height:2000px"></div>' +
  '</div></div>' +
  '<script>' +
  'let offset=0,target=0,raf=null;' +
  'function animate(){' +
  'offset+=(target-offset)*0.25;' +
  "document.getElementById('track').style.transform='translateY('+(-offset)+'px)';" +
  'if(Math.abs(target-offset)>0.5){raf=requestAnimationFrame(animate)}' +
  'else{offset=target;' +
  "document.getElementById('track').style.transform='translateY('+(-offset)+'px)';" +
  'raf=null}' +
  '}' +
  "document.getElementById('viewport').addEventListener('wheel',function(e){" +
  'e.preventDefault();' +
  'target+=e.deltaY;' +
  'target=Math.max(0,Math.min(target,2000));' +
  'if(!raf){raf=requestAnimationFrame(animate)}' +
  '},{passive:false});' +
  '</script>' +
  '</body></html>'
const INNER_SCROLL_FIXTURE_URL = `data:text/html,${encodeURIComponent(INNER_SCROLL_FIXTURE_HTML)}`

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
      // scroll() itself no longer waits for the page to settle — that
      // responsibility moved to target resolution, which is what the click
      // below actually exercises. So the independent ground truth is read
      // only *after* the click, once its own settle-on-read polling has
      // already proven the page stopped moving.
      await demo.click('#below')
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
    // Full bbox, including position — not just size, which alone can't
    // distinguish "tapped the right element" from "tapped the wrong place
    // that happens to be the same size."
    expect(tap).toMatchObject({
      bbox: { x: 150, y: 300, width: 100, height: 40 },
    })
  }, 30_000)

  it('clicks a hero bigger than the viewport at its visible, clamped point', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-hero')
    await rm(out, { force: true, recursive: true })

    let heroClicked: unknown
    await record({ out, seed: 1 }, async (page, demo) => {
      await page.goto(FIXTURE_URL)
      await demo.scroll(0, 1600)
      await demo.click('#hero')
      heroClicked = await page.evaluate(
        () => (window as unknown as { __heroClicked?: boolean }).__heroClicked,
      )
    })

    expect(heroClicked).toBe(true)
  }, 30_000)

  it('clicks a sliver flush against the viewport edge without missing it', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-edge')
    await rm(out, { force: true, recursive: true })

    let edgeClicked: unknown
    await record({ out, seed: 1 }, async (page, demo) => {
      await page.goto(FIXTURE_URL)
      await demo.scroll(0, 1600)
      await demo.click('#edge')
      edgeClicked = await page.evaluate(
        () => (window as unknown as { __edgeClicked?: boolean }).__edgeClicked,
      )
    })

    expect(edgeClicked).toBe(true)
  }, 30_000)

  it('settles and clicks correctly inside a JS-driven inner scroll container, not just the window', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-inner-scroll')
    await rm(out, { force: true, recursive: true })

    let expectedRect: BoundingBox | undefined
    let clicked: unknown

    await record({ out, seed: 5 }, async (page, demo) => {
      await page.goto(INNER_SCROLL_FIXTURE_URL)
      await demo.click('#above')
      // This scroll never touches window.scrollX/Y — it drives a CSS
      // transform on an inner container via a wheel-triggered rAF loop,
      // exactly the case a window-scroll-only settle check would miss.
      await demo.scroll(0, 900)
      await demo.click('#below-inner')
      // Captured after the click, once the settle-on-read polling inside
      // that click's own target resolution has already proven the
      // transform animation finished.
      expectedRect = await page.evaluate(() => {
        const element = document.querySelector('#below-inner')
        if (element === null) throw new Error('Fixture is missing #below-inner')
        const rect = element.getBoundingClientRect()
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }
      })
      clicked = await page.evaluate(
        () =>
          (window as unknown as { __innerBelowClicked?: boolean })
            .__innerBelowClicked,
      )
    })

    // Proves the click actually landed on the live element, inside the
    // inner scroller — not merely that some bbox looked plausible.
    expect(clicked).toBe(true)

    const log = await readFile(join(out, 'events.jsonl'), 'utf8')
    const events = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const belowClick = events.filter((event) => event.type === 'click').at(-1)
    const logged = (belowClick as { bbox: BoundingBox }).bbox
    const expected = roundBox(expectedRect!)
    // The logged bbox and this second, independent read are two different
    // point-in-time snapshots of a continuous CSS-transform animation; both
    // individually satisfy their own settle criteria but can still differ
    // by a rounding pixel. Width/height don't move during a vertical-only
    // scroll and must match exactly; position gets a tight tolerance.
    expect(logged.width).toBe(expected.width)
    expect(logged.height).toBe(expected.height)
    expect(Math.abs(logged.x - expected.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(logged.y - expected.y)).toBeLessThanOrEqual(2)
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
