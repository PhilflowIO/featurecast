import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { record, type BoundingBox } from '../src/record.js'

/**
 * Issue #12 acceptance against a real headless Chromium. Every case here
 * is one the settle criterion has to get right *and* has been measured
 * getting wrong before: a finite animation that must settle in about its
 * own duration rather than a multiple of it, an asymmetric animation whose
 * logged box must be the one the element rests in rather than an average
 * of rest and peak, permanent bounded animations of every shape (resize,
 * relocate, rotate, off-centre wiggle), an animation paused mid-flight,
 * and a drift slow enough to hide under any sub-pixel tolerance.
 *
 * Ground truth for every box comes from `getBoundingClientRect()` in the
 * page, never from `locator.boundingBox()` — the API `src/record.ts` uses
 * itself. Reusing it on both sides would prove the wrapper agrees with
 * itself.
 */

const ARTIFACTS_ROOT = 'artifacts/settle-criterion-001'

function page(body: string): string {
  return (
    'data:text/html,' +
    encodeURIComponent(
      `<!doctype html><html><body style="margin:0">${body}</body></html>`,
    )
  )
}

const STILL_FIXTURE_URL = page(
  '<button id="t" style="position:absolute;left:600px;top:300px;' +
    'width:100px;height:40px;" onclick="window.__clicked=true">T</button>',
)

/** Widens 100px -> 400px over exactly 4s and then stops. The case the
 * 5000ms default was chosen for. */
const FINITE_4S_FIXTURE_URL = page(
  '<style>@keyframes grow{from{width:100px}to{width:400px}}' +
    '#t{position:absolute;left:600px;top:300px;width:100px;height:40px;' +
    'animation:grow 4s linear forwards}</style>' +
    '<button id="t" onclick="window.__clicked=true">T</button>',
)

/** Rests at scale(1) for 70% of every cycle, then briefly peaks at 1.6.
 * Its time average is a box the element never occupies. */
const ASYMMETRIC_FIXTURE_URL = page(
  '<style>@keyframes peak{0%,70%{transform:scale(1)}' +
    '85%{transform:scale(1.6)}100%{transform:scale(1)}}' +
    '#t{position:absolute;left:600px;top:300px;width:80px;height:40px;' +
    'animation:peak 1s linear infinite}</style>' +
    '<button id="t" onclick="window.__clicked=true">Go</button>',
)

const PULSING_FIXTURE_URL = page(
  '<style>@keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.6)}' +
    '100%{transform:scale(1)}}#t{position:absolute;left:600px;top:300px;' +
    'width:80px;height:40px;animation:pulse 0.3s linear infinite}</style>' +
    '<button id="t" onclick="window.__clicked=true">Go</button>',
)

const BOUNCE_FIXTURE_URL = page(
  '<style>@keyframes bounce{0%{transform:translateY(0)}' +
    '50%{transform:translateY(15px)}100%{transform:translateY(0)}}' +
    '#t{position:absolute;left:600px;top:300px;width:80px;height:40px;' +
    'animation:bounce 0.5s linear infinite}</style>' +
    '<button id="t" onclick="window.__clicked=true">Go</button>',
)

const WIGGLE_FIXTURE_URL = page(
  '<style>@keyframes wiggle{0%{transform:rotate(0deg)}' +
    '25%{transform:rotate(8deg)}75%{transform:rotate(-8deg)}' +
    '100%{transform:rotate(0deg)}}' +
    '#t{position:absolute;left:600px;top:300px;width:80px;height:40px;' +
    'transform-origin:0% 100%;animation:wiggle 0.4s ease-in-out infinite}' +
    '</style><button id="t" onclick="window.__clicked=true">Go</button>',
)

const SPIN_FIXTURE_URL = page(
  '<style>@keyframes spin{from{transform:rotate(0deg)}' +
    'to{transform:rotate(360deg)}}' +
    '#t{position:absolute;left:600px;top:300px;width:120px;height:30px;' +
    'animation:spin 0.6s linear infinite}</style>' +
    '<button id="t" onclick="window.__clicked=true">Go</button>',
)

/**
 * The target itself declares no animation at all — its *parent* does, and
 * moves it. `element.getAnimations()` on the target returns an empty list
 * here, so a period read from the target alone finds nothing.
 */
const ANCESTOR_ANIMATED_FIXTURE_URL = page(
  '<style>@keyframes drift{0%{transform:translateX(0)}' +
    '50%{transform:translateX(40px)}100%{transform:translateX(0)}}' +
    '#wrap{position:absolute;left:400px;top:300px;' +
    'animation:drift 0.5s linear infinite}</style>' +
    '<div id="wrap"><button id="t" style="width:80px;height:40px;" ' +
    'onclick="window.__clicked=true">Go</button></div>',
)

/**
 * An alternating ping-pong: its declared iteration duration is 400ms, but
 * one iteration only covers one direction, so the geometry's own period is
 * 800ms. Averaging over 400ms covers half a cycle and biases the result by
 * a process-dependent amount.
 */
const ALTERNATING_FIXTURE_URL = page(
  '<style>@keyframes pong{from{transform:translateX(0)}' +
    'to{transform:translateX(60px)}}' +
    '#t{position:absolute;left:400px;top:300px;width:80px;height:40px;' +
    'animation:pong 0.4s linear infinite alternate}</style>' +
    '<button id="t" onclick="window.__clicked=true">Go</button>',
)

/** Runs, then freezes mid-animation. The element is genuinely still
 * afterwards, at a geometry that is not its declared start or end. */
const PAUSED_MID_ANIMATION_FIXTURE_URL = page(
  '<style>@keyframes slide{from{transform:translateX(0)}' +
    'to{transform:translateX(300px)}}' +
    '#t{position:absolute;left:200px;top:300px;width:80px;height:40px;' +
    'animation:slide 4s linear infinite}</style>' +
    '<button id="t" onclick="window.__clicked=true">Go</button>' +
    '<script>setTimeout(function(){' +
    "document.getElementById('t').style.animationPlayState='paused'" +
    '},600)</script>',
)

/**
 * Widens by exactly 3px per second for 3s, then stops. 0.05px per
 * rendering frame is below any sub-pixel tolerance two consecutive reads
 * could be compared against, which is how this shape used to be clicked
 * mid-growth and logged at a width it only held in passing.
 */
const SLOW_DRIFT_FIXTURE_URL = page(
  '<button id="t" style="position:absolute;left:600px;top:300px;' +
    'width:100px;height:40px;" onclick="window.__clicked=true">T</button>' +
    '<script>var s=null;var el=document.getElementById("t");' +
    'function step(ts){if(s===null)s=ts;' +
    'var e=Math.min(ts-s,3000);el.style.width=(100+3*e/1000)+"px";' +
    'if(ts-s<3000)requestAnimationFrame(step)}' +
    'requestAnimationFrame(step);</script>',
)

async function clickBox(out: string): Promise<BoundingBox> {
  const events = (await readFile(join(out, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  return (
    events.find((event) => event.type === 'click') as { bbox: BoundingBox }
  ).bbox
}

/** Runs one click against `url` and reports whether the click fired, how
 * long the `demo.click` itself took, and the page's own live geometry
 * afterwards. */
async function clickRun(
  url: string,
  out: string,
  options: { settleTimeoutMs?: number; waitBeforeMs?: number } = {},
): Promise<{ clicked: unknown; elapsedMs: number; live: BoundingBox }> {
  await rm(out, { force: true, recursive: true })
  let clicked: unknown
  let elapsedMs = 0
  let live: BoundingBox = { x: 0, y: 0, width: 0, height: 0 }
  await record(
    {
      out,
      seed: 3,
      ...(options.settleTimeoutMs === undefined
        ? {}
        : { settleTimeoutMs: options.settleTimeoutMs }),
    },
    async (recordPage, demo) => {
      await recordPage.goto(url)
      if (options.waitBeforeMs !== undefined) {
        await recordPage.waitForTimeout(options.waitBeforeMs)
      }
      const started = Date.now()
      await demo.click('#t')
      elapsedMs = Date.now() - started
      clicked = await recordPage.evaluate(
        () => (window as unknown as { __clicked?: boolean }).__clicked,
      )
      live = await recordPage.evaluate(() => {
        const element = document.querySelector('#t')
        if (element === null) throw new Error('missing #t')
        const rect = element.getBoundingClientRect()
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      })
    },
  )
  return { clicked, elapsedMs, live }
}

describe('settle criterion against a real headless Chromium', () => {
  it('settles a finite 4s animation inside the default timeout, in about its own duration', async () => {
    // No settleTimeoutMs override anywhere here: the regression this pins
    // is that the branch's growing window needed ~3x the animation's
    // duration, so an ordinary 4s transition aborted against the 5000ms
    // default that was chosen for exactly this case.
    const control = await clickRun(
      STILL_FIXTURE_URL,
      join(ARTIFACTS_ROOT, 'run-still-control'),
    )
    const animated = await clickRun(
      FINITE_4S_FIXTURE_URL,
      join(ARTIFACTS_ROOT, 'run-finite-4s'),
    )

    expect(animated.clicked).toBe(true)
    // The resting box, not a mid-growth one.
    expect(await clickBox(join(ARTIFACTS_ROOT, 'run-finite-4s'))).toEqual(
      animated.live,
    )
    expect(animated.live.width).toBe(400)
    // Settle latency for an animation of duration D stays close to D: the
    // control run is the same interaction minus the animation.
    const settleMs = animated.elapsedMs - control.elapsedMs
    expect(settleMs).toBeGreaterThan(2500)
    expect(settleMs).toBeLessThan(5000)
  }, 60_000)

  it('logs the resting box of an asymmetric animation whatever phase the interaction starts in', async () => {
    const boxes: BoundingBox[] = []
    for (const waitBeforeMs of [0, 120, 250, 500, 750, 880]) {
      const out = join(ARTIFACTS_ROOT, `run-asymmetric-${String(waitBeforeMs)}`)
      const result = await clickRun(ASYMMETRIC_FIXTURE_URL, out, {
        waitBeforeMs,
      })
      expect(result.clicked).toBe(true)
      boxes.push(await clickBox(out))
    }

    // Resting geometry is exactly the declared 80x40 at (600, 300); the
    // time average over the cycle is a larger box the element is only ever
    // passing through.
    const resting = { x: 600, y: 300, width: 80, height: 40 }
    expect(boxes).toEqual(boxes.map(() => resting))
  }, 120_000)

  it.each([
    ['pulsing scale', PULSING_FIXTURE_URL],
    ['bounce', BOUNCE_FIXTURE_URL],
    ['off-centre wiggle', WIGGLE_FIXTURE_URL],
    ['spin', SPIN_FIXTURE_URL],
    ['paused mid-animation', PAUSED_MID_ANIMATION_FIXTURE_URL],
    ['ancestor-animated', ANCESTOR_ANIMATED_FIXTURE_URL],
    ['alternating ping-pong', ALTERNATING_FIXTURE_URL],
  ])(
    'settles and clicks a %s target',
    async (name, url) => {
      const out = join(ARTIFACTS_ROOT, `run-${name.replace(/\s+/g, '-')}`)
      const result = await clickRun(url, out)
      expect(result.clicked).toBe(true)
    },
    60_000,
  )

  it('waits out a 3px/s drift instead of clicking mid-growth', async () => {
    const out = join(ARTIFACTS_ROOT, 'run-slow-drift')
    const result = await clickRun(SLOW_DRIFT_FIXTURE_URL, out, {
      settleTimeoutMs: 15_000,
    })

    expect(result.clicked).toBe(true)
    // 100px + 3px/s for 3s = 109px, and nothing in between.
    expect(result.live.width).toBe(109)
    expect((await clickBox(out)).width).toBe(109)
  }, 60_000)
})
