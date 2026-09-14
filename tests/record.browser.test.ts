import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'

import {
  record,
  DEFAULT_SCROLL_SPEED_PX_PER_SECOND,
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

/** Static at settle time, jumps away 350ms later — mid-way through any
 * realistic pointer travel — to prove arrival-time re-verification. */
const MOVES_AFTER_SETTLE_FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
      '<button id="t" style="position:absolute;left:600px;top:300px;width:80px;height:30px;" ' +
      'onclick="window.__moved=true">T</button>' +
      "<script>setTimeout(function(){document.getElementById('t').style.top='650px'},350)</script>" +
      '</body></html>',
  )

/**
 * Grows around a fixed center 350ms after settling: the interaction point
 * still hit-tests correctly throughout (same center, before and after), so
 * the corrective-move branch never fires — the only way to catch a stale
 * logged bbox here is refreshing it unconditionally after arrival.
 */
const GROWS_FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
      '<button id="t" style="position:absolute;left:600px;top:300px;width:80px;height:30px;">T</button>' +
      "<script>setTimeout(function(){var t=document.getElementById('t');" +
      "t.style.left='560px';t.style.top='285px';t.style.width='160px';t.style.height='60px'},350)</script>" +
      '</body></html>',
  )

/** Replaced with a fresh DOM node (not just moved) 250ms after settling. */
const RERENDER_FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
      '<button id="t" style="position:absolute;left:600px;top:300px;width:80px;height:30px;" ' +
      'onclick="window.__rerendered=true">T</button>' +
      "<script>setTimeout(function(){var o=document.getElementById('t');" +
      "var n=o.cloneNode(true);n.style.top='500px';o.replaceWith(n)},250)</script>" +
      '</body></html>',
  )

/** Only the bottom 20px of a 200px-tall target is not behind a fixed header. */
const STICKY_OVERLAY_FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
      '<div id="hdr" style="position:fixed;left:0;top:0;width:100%;height:220px;' +
      'background:#ccc;z-index:9"></div>' +
      '<button id="t" style="position:absolute;left:600px;top:40px;width:80px;height:200px;" ' +
      'onclick="window.__stickyClicked=true">T</button>' +
      '</body></html>',
  )

/**
 * A tall target with two fixed overlays leaving only a 30px band free in
 * its middle — away from its center and from every one of the nine fixed
 * edge/corner/center probes the point search used before issue #13.
 */
const PINCHED_BAND_FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
      '<div style="position:fixed;left:0;top:0;width:100%;height:230px;' +
      'background:#ccc;z-index:9"></div>' +
      '<div style="position:fixed;left:0;top:260px;width:100%;' +
      'height:2000px;background:#ccc;z-index:9"></div>' +
      '<button id="t" style="position:absolute;left:600px;top:0;width:80px;' +
      'height:300px;" onclick="window.__bandClicked=true">T</button>' +
      '</body></html>',
  )

/**
 * Fully unoccluded at settle time (so the initial point search picks the
 * target's plain center); 300ms later — well inside the pointer's own
 * 0.4s+ minimum travel time — two overlays appear and cover exactly that
 * center, leaving only a middle band free. Only reachable if the
 * arrival-time re-verification (moveTo's corrective branch) re-runs the
 * occlusion search against the live, now-occluded page instead of trusting
 * the point resolved before travel started.
 */
const OVERLAY_APPEARS_DURING_TRAVEL_FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
      '<button id="t" style="position:absolute;left:500px;top:300px;' +
      'width:300px;height:50px;" onclick="window.__midTravelClicked=true">T' +
      '</button>' +
      '<script>setTimeout(function(){' +
      "var l=document.createElement('div');" +
      "l.style.cssText='position:fixed;left:0;top:0;width:680px;" +
      "height:100vh;background:#ccc;z-index:9';" +
      'document.body.appendChild(l);' +
      "var r=document.createElement('div');" +
      "r.style.cssText='position:fixed;left:750px;top:0;width:530px;" +
      "height:100vh;background:#ccc;z-index:9';" +
      'document.body.appendChild(r)' +
      '},300)</script>' +
      '</body></html>',
  )

/** A native `overflow:auto` container, scrolled by our own demo.scroll(). */
const OVERFLOW_AUTO_FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0">' +
      '<div id="c" style="position:absolute;left:100px;top:100px;width:400px;' +
      'height:300px;overflow:auto">' +
      '<div style="height:2000px;position:relative">' +
      '<button id="above" style="position:absolute;left:20px;top:20px;width:60px;' +
      'height:30px;">Above</button>' +
      '<button id="t" style="position:absolute;left:20px;top:900px;width:80px;' +
      'height:30px;" onclick="window.__overflowClicked=true">T</button>' +
      '</div></div>' +
      '</body></html>',
  )

function roundBox(box: BoundingBox): BoundingBox {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
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

  /**
   * P2 (issue #15) acceptance: proves the fix against a real headless
   * Chromium, not just the pure `computeScrollPositions` property test. The
   * old 40px wheel-packet splitter drove a 500px+ scroll in a handful of
   * evenly-spaced giant jumps, which a real recorder measured at 21.6-29.5
   * fps with most in-window output frames repeated. Sampling `scrollY` from
   * inside the page (via a `scroll` listener, not polling) is ground truth
   * for how many distinct on-screen states the scroll actually produced —
   * independent of anything this wrapper logs about itself.
   */
  it('produces at least 50 distinct scroll positions per second in a real browser', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-scroll-cadence')
    await rm(out, { force: true, recursive: true })

    const CADENCE_FIXTURE_URL =
      'data:text/html,' +
      encodeURIComponent(
        '<!doctype html><html><body style="margin:0;height:3000px">' +
          '<script>window.__scrollSamples=[];' +
          "window.addEventListener('scroll',function(){" +
          'window.__scrollSamples.push(' +
          '{y:window.scrollY,t:performance.now()})},{passive:true});' +
          '</script>' +
          '</body></html>',
      )
    const SCROLL_DISTANCE_PX = 500

    let samples: { t: number; y: number }[] = []
    let elapsedMs = 0
    await record({ out, seed: 3 }, async (page, demo) => {
      await page.goto(CADENCE_FIXTURE_URL)
      const before = Date.now()
      await demo.scroll(0, SCROLL_DISTANCE_PX)
      elapsedMs = Date.now() - before
      samples = await page.evaluate(
        () =>
          (window as unknown as { __scrollSamples: { t: number; y: number }[] })
            .__scrollSamples,
      )
    })

    const distinctPositions = new Set(samples.map((sample) => sample.y)).size
    // The denominator is how long the page was *moving*, read from the
    // page's own scroll samples — not how long the call took. Since #40 the
    // call also waits out the scroll's tail, and counting that idle tail as
    // motion time pushed this ratio into its own threshold: 47.3-50 against
    // a floor of 50, red on every other run (#38).
    const first = samples.at(0)
    const last = samples.at(-1)
    if (first === undefined || last === undefined) {
      throw new Error('The page reported no scroll samples at all')
    }
    const movingSeconds = (last.t - first.t) / 1000
    const positionsPerSecond = distinctPositions / movingSeconds
    expect(positionsPerSecond).toBeGreaterThanOrEqual(50)

    // Wall time should track the intended default speed
    // (SCROLL_DISTANCE_PX / DEFAULT_SCROLL_SPEED_PX_PER_SECOND). Generous
    // tolerance covers real scheduling jitter and the rare case where the
    // per-step cap's growth loop lengthens the scroll slightly.
    const expectedSeconds =
      SCROLL_DISTANCE_PX / DEFAULT_SCROLL_SPEED_PX_PER_SECOND
    const callSeconds = elapsedMs / 1000
    expect(callSeconds).toBeGreaterThan(expectedSeconds * 0.7)
    expect(callSeconds).toBeLessThan(expectedSeconds * 1.6)
  }, 30_000)

  /**
   * #40 acceptance in a real browser. Two things have to be true at once,
   * and the first is what makes the second mean anything:
   *
   * 1. The fixture really keeps moving after the last wheel event — it
   *    carries the input into an rAF-driven glide, the way a page with
   *    momentum or an animated container does. Without that there is no
   *    tail to wait out and any assertion below would pass for free.
   * 2. No scroll happens after `demo.scroll` returns. That is the property
   *    the motion window depends on: the window closes on return, so a
   *    scroll arriving later is a scroll the window does not describe.
   *
   * Ground truth is the page's own `scroll` and `wheel` timestamps, not
   * anything the wrapper reports about itself.
   */
  it('returns from a scroll only once the page has actually stopped moving', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-scroll-rest')
    await rm(out, { force: true, recursive: true })

    const GLIDE_FIXTURE_URL =
      'data:text/html,' +
      encodeURIComponent(
        '<!doctype html><html><body style="margin:0;height:6000px">' +
          '<script>' +
          'window.__lastWheel=0;window.__lastScroll=0;window.__velocity=0;' +
          "window.addEventListener('scroll',function(){" +
          'window.__lastScroll=performance.now()},{passive:true});' +
          "window.addEventListener('wheel',function(event){" +
          'window.__lastWheel=performance.now();' +
          // Every wheel event re-arms the same glide, whatever its delta:
          // the tail has to be a property of the fixture, not of how the
          // input happened to be paced. Accumulating `deltaY` made it the
          // latter -- a minimum-jerk scroll ends in sub-pixel steps, so the
          // tail collapsed to a single frame as soon as input dispatch
          // waited for Chromium's acknowledgement again (#45).
          'window.__velocity=event.deltaY>0?25:-25;' +
          'event.preventDefault()},{passive:false});' +
          'function glide(){' +
          'if(Math.abs(window.__velocity)>0.5){' +
          'window.scrollBy(0,window.__velocity);' +
          'window.__velocity*=0.82}' +
          'requestAnimationFrame(glide)}' +
          'requestAnimationFrame(glide);' +
          '</script></body></html>',
      )

    let lastWheel = 0
    let lastScrollAtReturn = 0
    let lastScrollAfterIdle = 0
    await record({ out, seed: 3 }, async (page, demo) => {
      await page.goto(GLIDE_FIXTURE_URL)
      await demo.scroll(0, 900)
      const atReturn = await page.evaluate(() => ({
        lastScroll: (window as unknown as { __lastScroll: number })
          .__lastScroll,
        lastWheel: (window as unknown as { __lastWheel: number }).__lastWheel,
      }))
      lastWheel = atReturn.lastWheel
      lastScrollAtReturn = atReturn.lastScroll
      // Longer than any glide this fixture can produce: from 25 px per
      // frame, a decay of 0.82 reaches half a pixel within 20 frames, so
      // the tail is ~330ms however the wheels arrived.
      await page.waitForTimeout(600)
      lastScrollAfterIdle = await page.evaluate(
        () => (window as unknown as { __lastScroll: number }).__lastScroll,
      )
    })

    // 1. The fixture has a tail at all: scrolling went on well past the
    //    last wheel event. Read after the idle stretch, so this holds
    //    whether or not the scroll waited — it says something about the
    //    fixture, not about the code under test. Without it, assertion 2
    //    would pass for free on a page that stops the instant input does.
    expect(lastScrollAfterIdle - lastWheel).toBeGreaterThan(30)
    // 2. And that tail was already over when the call returned: nothing
    //    scrolled during the idle stretch. This is the assertion that fails
    //    when the wait is removed.
    expect(lastScrollAtReturn).toBe(lastScrollAfterIdle)
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

  it('corrects course and still hits a target that moves during pointer travel', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-moves-after-settle')
    await rm(out, { force: true, recursive: true })

    let moved: unknown
    await record({ out, seed: 7 }, async (page, demo) => {
      await page.goto(MOVES_AFTER_SETTLE_FIXTURE_URL)
      await demo.click('#t')
      moved = await page.evaluate(
        () => (window as unknown as { __moved?: boolean }).__moved,
      )
    })

    // The old behavior: geometry settled before travel, no re-check after
    // it, so this click landed on stale coordinates and the listener
    // never fired even though record() reported success.
    expect(moved).toBe(true)
  }, 30_000)

  it('stays bit-identical across two runs even when the corrective path fires', async () => {
    // The determinism test above (produces bit-identical...) only uses a
    // static fixture, so it never exercises moveTo()'s corrective branch —
    // exactly the code path whose motion seed must NOT be drawn from the
    // shared random() stream, or an extra (even zero-length) correction
    // would shift every later move's curve and break reproducibility on any
    // page with a chance of triggering it.
    const runA = join(ARTIFACTS_ROOT, 'run-determinism-corrective-a')
    const runB = join(ARTIFACTS_ROOT, 'run-determinism-corrective-b')
    await rm(runA, { force: true, recursive: true })
    await rm(runB, { force: true, recursive: true })

    const script = async (page: RecordPage, demo: Demo) => {
      await page.goto(MOVES_AFTER_SETTLE_FIXTURE_URL)
      await demo.click('#t')
    }

    await record({ out: runA, seed: 7 }, script)
    await record({ out: runB, seed: 7 }, script)

    const logA = await readFile(join(runA, 'events.jsonl'), 'utf8')
    const logB = await readFile(join(runB, 'events.jsonl'), 'utf8')
    expect(sha256(logB)).toBe(sha256(logA))
  }, 30_000)

  it('logs the bbox at arrival, not before travel, even when no correction fires', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-grows-during-travel')
    await rm(out, { force: true, recursive: true })

    let liveRectAtClick: BoundingBox | undefined
    await record({ out, seed: 7 }, async (page, demo) => {
      await page.goto(GROWS_FIXTURE_URL)
      // The center never moves, so the interaction point keeps hit-testing
      // '#t' throughout — the corrective-move branch must never fire here.
      await demo.click('#t')
      liveRectAtClick = await page.evaluate(() => {
        const element = document.querySelector('#t')
        if (element === null) throw new Error('Fixture is missing #t')
        const rect = element.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
    })

    // Grown to 160x60 by the time of the click; the pre-travel bbox was
    // still 80x30. A stale-bbox bug logs the latter.
    expect(roundBox(liveRectAtClick!)).toEqual({
      x: 560,
      y: 285,
      width: 160,
      height: 60,
    })

    const log = await readFile(join(out, 'events.jsonl'), 'utf8')
    const events = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const click = events.find((event) => event.type === 'click')
    expect(click).toMatchObject({ bbox: roundBox(liveRectAtClick!) })
  }, 30_000)

  it('corrects course and still hits a target replaced with a fresh DOM node during travel', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-rerender')
    await rm(out, { force: true, recursive: true })

    let rerendered: unknown
    await record({ out, seed: 7 }, async (page, demo) => {
      await page.goto(RERENDER_FIXTURE_URL)
      await demo.click('#t')
      rerendered = await page.evaluate(
        () => (window as unknown as { __rerendered?: boolean }).__rerendered,
      )
    })

    expect(rerendered).toBe(true)
  }, 30_000)

  it('finds a clickable point on a target mostly hidden behind a sticky overlay', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-sticky-overlay')
    await rm(out, { force: true, recursive: true })

    let stickyClicked: unknown
    await record({ out, seed: 7 }, async (page, demo) => {
      await page.goto(STICKY_OVERLAY_FIXTURE_URL)
      await demo.click('#t')
      stickyClicked = await page.evaluate(
        () =>
          (window as unknown as { __stickyClicked?: boolean }).__stickyClicked,
      )
    })

    // The old behavior: the clamped midpoint of the full bbox landed on
    // the fixed header covering its top 220px, not on the 20px of #t that
    // was actually visible below it.
    expect(stickyClicked).toBe(true)
  }, 30_000)

  it('scrolls a native overflow:auto container and hits the revealed target', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-overflow-auto')
    await rm(out, { force: true, recursive: true })

    let overflowClicked: unknown
    await record({ out, seed: 7 }, async (page, demo) => {
      await page.goto(OVERFLOW_AUTO_FIXTURE_URL)
      // Positions the pointer over the container first, so the wheel
      // events below land on it and trigger its native scrolling — not
      // the page's.
      await demo.click('#above')
      await demo.scroll(0, 900)
      await demo.click('#t')
      overflowClicked = await page.evaluate(
        () =>
          (window as unknown as { __overflowClicked?: boolean })
            .__overflowClicked,
      )
    })

    expect(overflowClicked).toBe(true)
  }, 30_000)

  it('finds and clicks a free band pinched between two overlays, not just an edge or corner', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-pinched-band')
    await rm(out, { force: true, recursive: true })

    let bandClicked: unknown
    await record({ out, seed: 3 }, async (page, demo) => {
      await page.goto(PINCHED_BAND_FIXTURE_URL)
      await demo.click('#t')
      bandClicked = await page.evaluate(
        () => (window as unknown as { __bandClicked?: boolean }).__bandClicked,
      )
    })

    expect(bandClicked).toBe(true)
  }, 30_000)

  it('corrects course and finds the still-free band when an overlay appears mid-travel, covering the originally chosen point', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-overlay-appears-during-travel')
    await rm(out, { force: true, recursive: true })

    let midTravelClicked: unknown
    await record({ out, seed: 7 }, async (page, demo) => {
      await page.goto(OVERLAY_APPEARS_DURING_TRAVEL_FIXTURE_URL)
      await demo.click('#t')
      midTravelClicked = await page.evaluate(
        () =>
          (window as unknown as { __midTravelClicked?: boolean })
            .__midTravelClicked,
      )
    })

    expect(midTravelClicked).toBe(true)
  }, 30_000)
})
