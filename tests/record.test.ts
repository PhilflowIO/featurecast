import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createRecorder,
  serializeEvent,
  type Demo,
  type RecordPage,
  type RecordRuntime,
} from '../src/record.js'
import { generateMotionPoints } from '../src/motion.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-record-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

type FakeBoundingBox = { height: number; width: number; x: number; y: number }

/** Stand-in for one rendering tick in the simulated sampling loop below. */
const SIMULATED_FRAME_INTERVAL_MS = 16

/**
 * Simulates `observeFrames`' in-page `requestAnimationFrame` loop
 * (src/record.ts) on top of a plain `boundingBox` mock: reads it roughly
 * once per simulated rendering tick for a real `windowMs`, and returns the
 * same timestamped frame list the real payload returns. Keeps every
 * existing assertion about how often `boundingBox` was called meaningful,
 * since sampling still drives that same mock — just from inside the
 * simulated `evaluate()` payload, matching where the real implementation
 * does it (a Node-side poll samples at a cadence that varies with machine
 * load, which is what made the settled geometry load-dependent).
 */
async function simulateObservedFrames(
  boundingBox: () => Promise<FakeBoundingBox | null>,
  windowMs: number,
  minFrames: number,
) {
  const frames: {
    bottom: number
    left: number
    right: number
    t: number
    top: number
  }[] = []
  let virtualMs = 0
  for (;;) {
    const raw = await boundingBox()
    if (raw === null || raw.width <= 0 || raw.height <= 0) {
      throw new Error('Target must resolve to a visible bounding box')
    }
    frames.push({
      t: virtualMs,
      left: raw.x,
      top: raw.y,
      right: raw.x + raw.width,
      bottom: raw.y + raw.height,
    })
    if (virtualMs >= windowMs && frames.length >= minFrames) return frames
    virtualMs += SIMULATED_FRAME_INTERVAL_MS
    // Real time still has to pass, because the settle loop's own budget is
    // a wall clock — but the frame timestamps above are virtual, so the
    // sampled series is the same on a loaded machine as on an idle one.
    // A unit test asserting on the settled box should fail because the
    // criterion is wrong, never because the machine was busy.
    await new Promise((resolve) =>
      setTimeout(resolve, SIMULATED_FRAME_INTERVAL_MS),
    )
  }
}

/**
 * A locator double that always hit-tests as landing on the target.
 * `evaluate()` is called with one of three shapes: `{ points }` (a hit
 * test — see `hitTestPoints`/`hitsTarget` in src/record.ts, which batches a
 * whole probe grid into one round trip), answered with one boolean per
 * point, in order; `{ windowMs, minFrames }` (see `observeFrames`),
 * answered with a simulated frame list; or `undefined` (see
 * `candidatePeriodsMs`), answered with an empty list — a fake has no real
 * `getAnimations()`, and an empty list is exactly what a plain,
 * non-animated element returns for real, correctly sending callers to the
 * geometric fallback.
 */
function hittableLocator(boundingBox: ReturnType<typeof vi.fn>) {
  return {
    boundingBox,
    evaluate: vi
      .fn()
      .mockImplementation(
        (
          _pageFunction: unknown,
          arg:
            | { minFrames: number; windowMs: number }
            | { points: unknown[] }
            | undefined,
        ) => {
          if (arg === undefined) return Promise.resolve([])
          if ('windowMs' in arg) {
            return simulateObservedFrames(
              boundingBox as () => Promise<FakeBoundingBox | null>,
              arg.windowMs,
              arg.minFrames,
            )
          }
          return Promise.resolve(arg.points.map(() => true))
        },
      ),
  }
}

function fakePage(viewport = { height: 720, width: 1280 }) {
  const boundingBox = vi
    .fn()
    .mockResolvedValue({ height: 20, width: 60, x: 100, y: 50 })
  const locatorValue = hittableLocator(boundingBox)
  const locator = vi.fn().mockReturnValue(locatorValue)
  return {
    evaluate: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    hasTouch: false,
    keyboard: { type: vi.fn().mockResolvedValue(undefined) },
    locator,
    locatorValue,
    mouse: {
      click: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue(undefined),
      wheel: vi.fn().mockResolvedValue(undefined),
    },
    touchscreen: { tap: vi.fn().mockResolvedValue(undefined) },
    viewportSize: vi.fn().mockReturnValue(viewport),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  }
}

function runtimeFor(page: ReturnType<typeof fakePage>): RecordRuntime {
  return { run: async (_options, script) => script(page) }
}

describe('record', () => {
  it('keeps the public options free of an injected page and passes its page to the script', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()
    const record = createRecorder(runtimeFor(page))

    await record(
      { device: 'iPhone 15 Pro', out: output, seed: 42 },
      async (receivedPage, demo) => {
        expect(receivedPage).toBe(page)
        await demo.point('#save')
      },
    )

    expect(page.locator).toHaveBeenCalledWith('#save')
  })

  it('writes deterministic canonical JSONL with a final newline', async () => {
    const firstOutput = await temporaryDirectory()
    const secondOutput = await temporaryDirectory()
    const otherSeedOutput = await temporaryDirectory()
    const script = async (_page: RecordPage, demo: Demo) => {
      await demo.point('#save')
      await demo.click('#save')
      await demo.tap('#save')
      await demo.type('#title', 'Featurecast')
      await demo.hold(100)
      await demo.scroll(0, 240)
    }

    await createRecorder(runtimeFor(fakePage()))(
      { out: firstOutput, seed: 42 },
      script,
    )
    await createRecorder(runtimeFor(fakePage()))(
      { out: secondOutput, seed: 42 },
      script,
    )
    await createRecorder(runtimeFor(fakePage()))(
      { out: otherSeedOutput, seed: 7 },
      script,
    )

    const firstLog = await readFile(join(firstOutput, 'events.jsonl'), 'utf8')
    expect(await readFile(join(secondOutput, 'events.jsonl'), 'utf8')).toBe(
      firstLog,
    )
    expect(
      await readFile(join(otherSeedOutput, 'events.jsonl'), 'utf8'),
    ).not.toBe(firstLog)
    expect(firstLog.endsWith('\n')).toBe(true)
    expect(firstLog).toContain(
      '{"type":"header","version":1,"fps":60,"seed":42}',
    )
    expect(firstLog).toContain('{"type":"pointer","tick":0,"x":')
    expect(firstLog).toContain('{"type":"click","tick":')
    expect(firstLog).toContain('{"type":"tap","tick":')
    expect(firstLog).toContain('{"type":"type","tick":')
    expect(firstLog).toContain('{"type":"hold","tick":')
    expect(firstLog).toContain('{"type":"scroll","tick":')
  })

  it('uses 60 fps renderer ticks for pointer samples and interaction timing', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.point('#save')
        await demo.click('#save')
        await demo.tap('#save')
        await demo.type('#title', 'Featurecast')
        await demo.hold(100)
        await demo.scroll(10, 20)
      },
    )

    const events = (await readFile(join(output, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const pointerEvents = events.filter((event) => event.type === 'pointer')
    const click = events.find((event) => event.type === 'click')!
    const tap = events.find((event) => event.type === 'tap')!
    const typed = events.find((event) => event.type === 'type')!
    const hold = events.find((event) => event.type === 'hold')!
    const scroll = events.find((event) => event.type === 'scroll')!

    // Independent, distance-derived lower bound (pigeonhole: you cannot cross
    // ~591.7px in fewer than ceil(591.7 / 20) hops of <=20px each) — not
    // computed from tick's own bookkeeping, so a broken sample count would
    // actually fail this, unlike comparing tick fields against each other.
    const viewportCenterToSaveDistance = Math.hypot(640 - 130, 360 - 60)
    expect(pointerEvents.length).toBeGreaterThanOrEqual(
      Math.ceil(viewportCenterToSaveDistance / 20),
    )
    expect(pointerEvents.map((event) => event.tick)).toEqual(
      pointerEvents.map((_event, index) => index),
    )
    expect(click.tick).toBe(pointerEvents.length)
    expect(tap.tick).toBe(click.tick)
    expect(typed.tick).toBe(tap.tick)
    // tick is the scheduled 60Hz slot index: typing's seeded per-key delays
    // (40-110ms, 10 gaps for 'Featurecast') consume real time and must
    // advance it by a deterministic, bounded amount before hold's own tick.
    const typeSlots = Number(hold.tick) - Number(typed.tick)
    expect(typeSlots).toBeGreaterThanOrEqual(2 * ('Featurecast'.length - 1))
    expect(typeSlots).toBeLessThanOrEqual(7 * ('Featurecast'.length - 1))
    expect(hold.milliseconds).toBe(100)
    expect(scroll.tick).toBe(Number(hold.tick) + 6)
    expect(click).toMatchObject({
      bbox: { height: 20, width: 60, x: 100, y: 50 },
      x: 130,
      y: 60,
    })
    expect(tap).toMatchObject({
      bbox: { height: 20, width: 60, x: 100, y: 50 },
      x: 130,
      y: 60,
    })
    expect(page.mouse.click).toHaveBeenCalledWith(130, 60)
    expect(page.touchscreen.tap).toHaveBeenCalledWith(130, 60)
    // The eased, distance-over-time scroll (issue #15) may now split a
    // small scroll across more than one 60Hz wheel increment — asserting
    // on the summed deltas rather than a single call keeps this test
    // agnostic to that internal step count while still proving the wrapper
    // dispatches exactly the requested total scroll distance.
    const wheelCalls = vi.mocked(page.mouse.wheel).mock.calls
    const totalWheelX = wheelCalls.reduce((sum, [dx]) => sum + dx, 0)
    const totalWheelY = wheelCalls.reduce((sum, [, dy]) => sum + dy, 0)
    expect(totalWheelX).toBeCloseTo(10, 9)
    expect(totalWheelY).toBeCloseTo(20, 9)
  })

  it('moves the pointer to the viewport center before the first interaction', async () => {
    const output = await temporaryDirectory()
    const page = fakePage({ height: 800, width: 1600 })

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.point('#save')
      },
    )

    const events = (await readFile(join(output, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === 'pointer')

    expect(events[0]).toMatchObject({ tick: 0 })
    // The pointer settles near the viewport center before curving on toward
    // '#save'; it should pass close to (800, 400) early in the log.
    expect(
      events.some(
        (event) =>
          Math.hypot(Number(event.x) - 800, Number(event.y) - 400) < 25,
      ),
    ).toBe(true)
  })

  it('types real keystrokes after focusing the field with the pointer', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.type('#title', 'Featurecast')
      },
    )

    expect(page.mouse.click).toHaveBeenCalledWith(130, 60)
    expect(page.keyboard.type).toHaveBeenCalledTimes('Featurecast'.length)
    expect(page.keyboard.type).toHaveBeenNthCalledWith(1, 'F')
    expect(page.keyboard.type).toHaveBeenNthCalledWith(2, 'e')

    const events = (await readFile(join(output, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const typed = events.find((event) => event.type === 'type')
    expect(typed).toMatchObject({
      text: 'Featurecast',
      bbox: { height: 20, width: 60, x: 100, y: 50 },
    })
  })

  it('taps instead of clicking to focus a field on a touch device', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()
    page.hasTouch = true

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.type('#title', 'hi')
      },
    )

    expect(page.touchscreen.tap).toHaveBeenCalledWith(130, 60)
    expect(page.mouse.click).not.toHaveBeenCalled()
  })

  it('really waits during hold instead of only advancing the log tick', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.hold(500)
      },
    )

    expect(page.waitForTimeout).toHaveBeenCalledWith(500)
  })

  it('keeps every adjacent emitted pointer sample within 20px across a large viewport', async () => {
    const viewport = { height: 1600, width: 2560 }
    const output = await temporaryDirectory()
    const page = fakePage(viewport)
    const boxes = {
      '#far-left': { height: 20, width: 20, x: 10, y: 1560 },
      '#far-right': { height: 20, width: 20, x: 2520, y: 10 },
      '#nearby': { height: 20, width: 20, x: 120, y: 60 },
    }
    page.locator.mockImplementation((selector: string) =>
      hittableLocator(
        vi.fn().mockResolvedValue(boxes[selector as keyof typeof boxes]),
      ),
    )

    for (const seed of [0, 1, 42, 0xffffffff]) {
      await createRecorder(runtimeFor(page))(
        { out: output, seed },
        async (_page, demo) => {
          await demo.point('#far-right')
          await demo.point('#far-left')
          await demo.point('#nearby')
        },
      )
      const events = (await readFile(join(output, 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.type === 'pointer')

      for (let index = 1; index < events.length; index += 1) {
        const previous = events[index - 1]!
        const current = events[index]!
        expect(
          Math.hypot(
            Number(current.x) - Number(previous.x),
            Number(current.y) - Number(previous.y),
          ),
        ).toBeLessThanOrEqual(20)
      }
    }
  })

  it('uses seeded minimum-jerk motion with overshoot and tremor', () => {
    const points = generateMotionPoints(
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      42,
      60,
    )

    expect(points.at(-1)).toEqual({ x: 400, y: 0 })
    expect(points.some((point) => point.x > 400)).toBe(true)
    expect(points).toEqual(
      generateMotionPoints({ x: 0, y: 0 }, { x: 400, y: 0 }, 42, 60),
    )
    expect(points).not.toEqual(
      generateMotionPoints({ x: 0, y: 0 }, { x: 400, y: 0 }, 7, 60),
    )
  })

  it('serializes only valid v1 events in fixed field order', () => {
    expect(
      serializeEvent({
        type: 'click',
        tick: 4,
        x: 130,
        y: 60,
        bbox: { x: 100, y: 50, width: 60, height: 20 },
      }),
    ).toBe(
      '{"type":"click","tick":4,"x":130,"y":60,"bbox":{"x":100,"y":50,"width":60,"height":20}}',
    )
    expect(() =>
      serializeEvent({ type: 'pointer', tick: -1, x: 1, y: 1 }),
    ).toThrow('tick')
    expect(() =>
      serializeEvent({ type: 'hold', tick: 1, milliseconds: -1 }),
    ).toThrow('milliseconds')
  })

  it('rejects targets that do not resolve to a visible bounding box', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()
    page.locator.mockReturnValue(
      hittableLocator(vi.fn().mockResolvedValue(null)),
    )

    await expect(
      createRecorder(runtimeFor(page))({ out: output }, async (_page, demo) =>
        demo.click('#missing'),
      ),
    ).rejects.toThrow('Target must resolve to a visible bounding box')
  })

  it('rejects a target whose bounding box has no visible intersection with the viewport', async () => {
    const output = await temporaryDirectory()
    const page = fakePage({ height: 720, width: 1280 })
    page.locator.mockReturnValue(
      hittableLocator(
        vi.fn().mockResolvedValue({ height: 20, width: 20, x: -1210, y: 640 }),
      ),
    )

    await expect(
      createRecorder(runtimeFor(page))({ out: output }, async (_page, demo) =>
        demo.click('#offscreen'),
      ),
    ).rejects.toThrow(/no visible intersection.*demo\.scroll/)
  })

  it('clamps the interaction point to the visible intersection instead of rejecting a partially off-screen target', async () => {
    const output = await temporaryDirectory()
    const page = fakePage({ height: 720, width: 1280 })
    // A full-height hero or overlay bigger than the viewport is normal; only
    // 20 of its 100px width is actually on screen (x: -80 to x: 20).
    page.locator.mockReturnValue(
      hittableLocator(
        vi.fn().mockResolvedValue({ height: 40, width: 100, x: -80, y: 100 }),
      ),
    )

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.click('#partially-offscreen')
      },
    )

    // Clamped to the midpoint of the visible slice: x in [0, 20), y in [100, 140).
    expect(page.mouse.click).toHaveBeenCalledWith(10, 120)
    const events = (await readFile(join(output, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const click = events.find((event) => event.type === 'click')
    // The full bbox is still logged, even though only part of it is visible.
    expect(click).toMatchObject({
      bbox: { height: 40, width: 100, x: -80, y: 100 },
    })
  })

  it('clamps a sliver flush against the viewport edge strictly inside it (off-by-one guard)', async () => {
    const output = await temporaryDirectory()
    const page = fakePage({ height: 720, width: 1280 })
    // Center of the unclamped bbox would be exactly x=1280 — outside a
    // 1280-wide viewport (valid columns are 0..1279).
    page.locator.mockReturnValue(
      hittableLocator(
        vi.fn().mockResolvedValue({ height: 20, width: 20, x: 1270, y: 100 }),
      ),
    )

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.click('#edge')
      },
    )

    const [x, y] = page.mouse.click.mock.calls.at(-1)!
    expect(x).toBeLessThan(1280)
    expect(y).toBeLessThan(720)
  })

  it('resolves once the bounding box stabilizes instead of trusting the first read', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()
    const moving = { height: 20, width: 60, x: 40, y: 653 }
    const settled = { height: 20, width: 60, x: 40, y: 300 }
    const boundingBox = vi
      .fn()
      .mockResolvedValueOnce(moving)
      .mockResolvedValueOnce(moving)
      .mockResolvedValue(settled)
    page.locator.mockReturnValue(hittableLocator(boundingBox))

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.click('#below')
      },
    )

    // Proves the wrapper polled past the still-moving reads: it must have
    // called boundingBox() more than once to ever see the settled value.
    expect(boundingBox.mock.calls.length).toBeGreaterThan(1)
    const events = (await readFile(join(output, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const click = events.find((event) => event.type === 'click')
    expect(click).toMatchObject({ bbox: settled })
  })

  it('gives up with a settleTimeoutMs-naming error if geometry never stabilizes', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()
    let call = 0
    page.locator.mockReturnValue(
      hittableLocator(
        vi.fn().mockImplementation(() => {
          call += 1
          // Never repeats the same value twice in a row: never settles.
          return Promise.resolve({
            height: 20,
            width: 60,
            x: 40,
            y: 100 + call,
          })
        }),
      ),
    )

    await expect(
      createRecorder(runtimeFor(page))(
        { out: output, settleTimeoutMs: 50 },
        async (_page, demo) => demo.click('#never-settles'),
      ),
    ).rejects.toThrow(/settleTimeoutMs.*50ms/)
  })

  it('types every code point exactly once, even across a surrogate pair', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()
    const text = 'a\u{1F600}b' // 'a', an emoji surrogate pair, 'b' — 3 code points

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.type('#title', text)
      },
    )

    const codePointCount = [...text].length
    expect(page.keyboard.type).toHaveBeenCalledTimes(codePointCount)
    // The very last thing the typing loop does must be typing the final code
    // point, not a trailing inter-key wait — the P3 bug compared the delay
    // index against the UTF-16 code-unit length instead of the code-point
    // count, so a surrogate pair picked up a spurious wait after the last char.
    const lastTypeCallOrder =
      page.keyboard.type.mock.invocationCallOrder.at(-1)!
    const lastWaitCallOrder =
      page.waitForTimeout.mock.invocationCallOrder.at(-1)!
    expect(lastWaitCallOrder).toBeLessThan(lastTypeCallOrder)

    const events = (await readFile(join(output, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const typed = events.find((event) => event.type === 'type')
    expect(typed).toMatchObject({ text })
  })

  /**
   * A locator double for a permanently animated target: `boundingBox`
   * answers from a phase clock, and `evaluate(undefined)` answers the
   * Web Animations API probe with a declared iteration duration, exactly
   * as a CSS-animated element does.
   */
  function animatedLocator(
    boxAtPhase: (phase: number) => FakeBoundingBox,
    periodMs: number,
    declaredPeriodsMs: number[] = [periodMs],
  ) {
    // The phase advances one simulated rendering interval per read, not
    // with the wall clock: the animation a unit test observes is then a
    // pure function of how many samples were taken, which is what makes
    // these assertions independent of machine load.
    let tick = 0
    const boundingBox = vi.fn().mockImplementation(() => {
      const phase = ((tick * SIMULATED_FRAME_INTERVAL_MS) % periodMs) / periodMs
      tick += 1
      return Promise.resolve(boxAtPhase(phase))
    })
    const base = hittableLocator(boundingBox)
    return {
      boundingBox,
      evaluate: vi
        .fn()
        .mockImplementation(
          (
            pageFunction: unknown,
            arg: { minFrames: number; windowMs: number } | undefined,
          ) =>
            arg === undefined
              ? Promise.resolve(declaredPeriodsMs)
              : base.evaluate(pageFunction, arg),
        ),
    }
  }

  const readClick = async (output: string) => {
    const events = (await readFile(join(output, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    return events.find((event) => event.type === 'click') as {
      bbox: FakeBoundingBox
      x: number
      y: number
    }
  }

  it('settles a permanently animated target instead of waiting for it to stop', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()
    // Pulses forever around a fixed centre: no read is ever equal to the
    // one before it, so waiting for "the same box twice" never returns.
    page.locator.mockReturnValue(
      animatedLocator((phase) => {
        const scale = 1 + 0.5 * Math.sin(phase * 2 * Math.PI)
        const width = 80 * scale
        const height = 40 * scale
        return {
          x: 600 + (80 - width) / 2,
          y: 300 + (40 - height) / 2,
          width,
          height,
        }
      }, 240),
    )

    await createRecorder(runtimeFor(page))(
      { out: output, settleTimeoutMs: 8000 },
      async (_page, demo) => {
        await demo.click('#pulsing')
      },
    )

    const click = await readClick(output)
    // The pulse is symmetric around scale 1, so its time average is the
    // resting 80x40 box and its centre is the element's own centre.
    expect(click.bbox).toEqual({ x: 600, y: 300, width: 80, height: 40 })
    expect([click.x, click.y]).toEqual([640, 320])
  }, 20_000)

  /**
   * The load-bearing case for "resting geometry": an animation that sits
   * at its resting size most of the cycle and briefly peaks. The time
   * average is a box the element never occupies — logging it would have
   * M4 frame geometry that was never on screen. The most-dwelt box is the
   * resting one.
   */
  it('logs the most-dwelt box for an asymmetric animation, not its mean', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()
    const resting = { x: 600, y: 300, width: 80, height: 40 }
    const peak = { x: 596, y: 298, width: 88, height: 44 }
    page.locator.mockReturnValue(
      animatedLocator((phase) => (phase < 0.7 ? resting : peak), 240),
    )

    await createRecorder(runtimeFor(page))(
      { out: output, settleTimeoutMs: 8000 },
      async (_page, demo) => {
        await demo.click('#asymmetric')
      },
    )

    const click = await readClick(output)
    expect(click.bbox).toEqual(resting)
  }, 20_000)

  /**
   * The same asymmetric animation, interacted with at six different
   * offsets into its cycle. The logged box must not depend on which phase
   * the recorder happened to start in — that dependence is precisely what
   * made two processes disagree.
   */
  it('logs the same box for an asymmetric animation whatever phase the interaction starts in', async () => {
    const resting = { x: 600, y: 300, width: 80, height: 40 }
    const peak = { x: 596, y: 298, width: 88, height: 44 }
    const boxes: FakeBoundingBox[] = []

    for (const offsetMs of [0, 40, 90, 150, 200, 230]) {
      const output = await temporaryDirectory()
      const page = fakePage()
      page.locator.mockReturnValue(
        animatedLocator(
          (phase) => ((phase + offsetMs / 240) % 1 < 0.7 ? resting : peak),
          240,
        ),
      )
      await createRecorder(runtimeFor(page))(
        { out: output, settleTimeoutMs: 8000 },
        async (_page, demo) => {
          await demo.click('#asymmetric')
        },
      )
      boxes.push((await readClick(output)).bbox)
    }

    expect(boxes).toEqual(boxes.map(() => resting))
  }, 60_000)

  /**
   * The measurement window is `ceil(MIN_MEASUREMENT_MS / period)` whole
   * periods and nothing else. Before this, the window's length was a
   * multiple of however wide the growth loop's window had grown by the
   * time convergence happened — so a run that needed one more growth round
   * averaged over a differently phased window and logged a different box.
   * Here one run spends 400ms watching a target relocate before the
   * animation settles into its loop and the other does not; both must log
   * the same box.
   */
  it('logs the same box however long the settle loop waited first', async () => {
    const resting = { x: 600, y: 300, width: 80, height: 40 }
    const peak = { x: 596, y: 298, width: 88, height: 44 }
    const boxes: FakeBoundingBox[] = []

    for (const preambleMs of [0, 400]) {
      const output = await temporaryDirectory()
      const page = fakePage()
      let reads = 0
      page.locator.mockReturnValue(
        animatedLocator((phase) => {
          reads += 1
          const elapsed = reads * SIMULATED_FRAME_INTERVAL_MS
          if (elapsed < preambleMs) {
            // Still travelling to its final position: neither still nor
            // periodic, so the settle loop keeps waiting.
            return {
              x: 600,
              y: 300 + (preambleMs - elapsed),
              width: 80,
              height: 40,
            }
          }
          return phase < 0.7 ? resting : peak
        }, 240),
      )
      await createRecorder(runtimeFor(page))(
        { out: output, settleTimeoutMs: 8000 },
        async (_page, demo) => {
          await demo.click('#asymmetric')
        },
      )
      boxes.push((await readClick(output)).bbox)
    }

    expect(boxes[1]).toEqual(boxes[0])
    expect(boxes[0]).toEqual(resting)
  }, 30_000)

  /**
   * A drift far below any sub-pixel tolerance: 0.05px per rendering frame.
   * The old criterion compared two reads against a 0.5px epsilon, which
   * such a drift never exceeds, so the target was declared settled while
   * it was still growing and the logged box was a width the element only
   * held in passing. The criterion is exact equality now, which has no
   * tolerance to hide under.
   */
  it('keeps waiting out a target drifting far below any sub-pixel tolerance', async () => {
    const output = await temporaryDirectory()
    const page = fakePage()
    const growForFrames = 44
    const finalWidth = 100 + growForFrames * 0.05
    let reads = 0
    page.locator.mockReturnValue(
      hittableLocator(
        vi.fn().mockImplementation(() => {
          const frame = Math.min(reads, growForFrames)
          reads += 1
          return Promise.resolve({
            x: 600,
            y: 300,
            width: 100 + frame * 0.05,
            height: 40,
          })
        }),
      ),
    )

    await createRecorder(runtimeFor(page))(
      { out: output, settleTimeoutMs: 8000 },
      async (_page, demo) => {
        await demo.click('#slow-drift')
      },
    )

    const click = await readClick(output)
    expect(click.bbox.width).toBe(Math.round(finalWidth))
  }, 20_000)

  /**
   * A locator double whose `evaluate()` hit-tests each probe point against
   * a caller-supplied "is this pixel free" predicate, simulating an overlay
   * occluding part of the target. Mirrors the real contract exercised by
   * `hittableLocator` — the settle observation (`{ windowMs, minFrames }`)
   * and the Web-Animations probe (`undefined`) answer exactly as there;
   * a `{ points }` hit test answers one boolean per point, in order, from
   * the predicate.
   */
  function occludedLocator(
    boundingBox: ReturnType<typeof vi.fn>,
    isFree: (point: { x: number; y: number }) => boolean,
  ) {
    return {
      boundingBox,
      evaluate: vi
        .fn()
        .mockImplementation(
          (
            _pageFunction: unknown,
            arg:
              | { minFrames: number; windowMs: number }
              | { points: { x: number; y: number }[] }
              | undefined,
          ) => {
            if (arg === undefined) return Promise.resolve([])
            if ('windowMs' in arg) {
              return simulateObservedFrames(
                boundingBox as () => Promise<FakeBoundingBox | null>,
                arg.windowMs,
                arg.minFrames,
              )
            }
            return Promise.resolve(arg.points.map((point) => isFree(point)))
          },
        ),
    }
  }

  it('finds the free area below an overlay covering the top of the target', async () => {
    const output = await temporaryDirectory()
    const page = fakePage({ height: 720, width: 1280 })
    // Target spans y 0..300; an overlay covers everything above y=250,
    // leaving only a 50px strip at the very bottom free.
    page.locator.mockReturnValue(
      occludedLocator(
        vi.fn().mockResolvedValue({ height: 300, width: 80, x: 600, y: 0 }),
        (point) => point.y >= 250,
      ),
    )

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.click('#covered-from-top')
      },
    )

    const [, clickY] = page.mouse.click.mock.calls[0]!
    expect(clickY).toBeGreaterThanOrEqual(250)
  })

  /**
   * The discriminating test for issue #13's point search. It picks the free
   * band's position mathematically so that a probe grid with the *average*
   * spacing the previous attempt used on this target (`ceil(length/8)+1`
   * samples per axis, capped at 33 — 9.125px apart on a 300px target, with
   * points at y = 4 + k*9.125) provably never lands inside [244, 250): its
   * nearest points are 241.25 and 250.375, both outside. The fixed 6px
   * `GRID_STEP_PX` (5.9592px actual spacing here) always does, and so would
   * no fixed nine-point edge/corner search. A test using a wide free area
   * near an edge would pass on all three and prove nothing.
   */
  it('finds a free band too narrow for an average-spaced grid, at the exact spacing such a grid steps over', async () => {
    const output = await temporaryDirectory()
    const page = fakePage({ height: 720, width: 1280 })
    page.locator.mockReturnValue(
      occludedLocator(
        vi.fn().mockResolvedValue({ height: 300, width: 80, x: 600, y: 0 }),
        (point) => point.y >= 244 && point.y < 250,
      ),
    )

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.click('#narrow-band')
      },
    )

    const [, clickY] = page.mouse.click.mock.calls[0]!
    expect(clickY).toBeGreaterThanOrEqual(244)
    expect(clickY).toBeLessThan(250)
  })

  it('finds a free band pinched between two overlays, away from the target center and every fixed edge/corner probe', async () => {
    const output = await temporaryDirectory()
    const page = fakePage({ height: 720, width: 1280 })
    // Target spans y 0..300 (center at y=150, the old fixed probes sat at
    // y in {4, 150, 296}); overlays cover y<230 and y>=260, leaving only a
    // 230..260 band free — none of the old nine fixed points fall inside it.
    page.locator.mockReturnValue(
      occludedLocator(
        vi.fn().mockResolvedValue({ height: 300, width: 80, x: 600, y: 0 }),
        (point) => point.y >= 230 && point.y < 260,
      ),
    )

    await createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.click('#pinched-band')
      },
    )

    const [, clickY] = page.mouse.click.mock.calls[0]!
    expect(clickY).toBeGreaterThanOrEqual(230)
    expect(clickY).toBeLessThan(260)
  })

  it('picks the same point on two separate runs against an identical occlusion (determinism)', async () => {
    const isFree = (point: { x: number; y: number }): boolean =>
      point.y >= 230 && point.y < 260
    const clicks: [number, number][] = []

    for (let run = 0; run < 2; run += 1) {
      const output = await temporaryDirectory()
      const page = fakePage({ height: 720, width: 1280 })
      page.locator.mockReturnValue(
        occludedLocator(
          vi.fn().mockResolvedValue({ height: 300, width: 80, x: 600, y: 0 }),
          isFree,
        ),
      )
      await createRecorder(runtimeFor(page))(
        { out: output },
        async (_page, demo) => {
          await demo.click('#pinched-band')
        },
      )
      clicks.push(page.mouse.click.mock.calls[0] as [number, number])
    }

    expect(clicks[1]).toEqual(clicks[0])
  })

  it('rejects a target that is occluded at every probe point instead of guessing, naming the probe step honestly', async () => {
    const output = await temporaryDirectory()
    const page = fakePage({ height: 720, width: 1280 })
    page.locator.mockReturnValue(
      occludedLocator(
        vi.fn().mockResolvedValue({ height: 300, width: 80, x: 600, y: 0 }),
        () => false,
      ),
    )

    // The message must name the probe step: the old wording claimed certain
    // full occlusion even when the real cause could be a free area narrower
    // than the grid's own spacing, which is a different thing to go fix.
    await expect(
      createRecorder(runtimeFor(page))({ out: output }, async (_page, demo) =>
        demo.click('#fully-covered'),
      ),
    ).rejects.toThrow(
      /occluded at every probe point spaced 6px apart.*narrower than the 6px probe step/,
    )
  })
})

describe('input pacing on the 60 Hz tick (#25)', () => {
  // Chromium acknowledges an input event only after processing it, tied to
  // the next frame: measured 16.5–17.8 ms per step on the patched build. The
  // fake page reproduces exactly that, on a fake clock, so the test is a
  // statement about the pacing logic and not about this machine's timing.
  const ACK_MS = 17.5
  const SLOT_MS = 1000 / 60

  function slowAcknowledgingPage() {
    const page = fakePage()
    // Kept apart per input kind: a scroll is preceded by the pointer's move
    // to the viewport center, and each is paced on its own grid.
    const dispatchedAt = { move: [] as number[], wheel: [] as number[] }
    const acknowledgedAt: number[] = []
    const slow = (kind: keyof typeof dispatchedAt) => (): Promise<void> => {
      dispatchedAt[kind].push(Date.now())
      return new Promise((resolve) =>
        setTimeout(() => {
          acknowledgedAt.push(Date.now())
          resolve()
        }, ACK_MS),
      )
    }
    page.mouse.wheel = vi.fn(slow('wheel'))
    page.mouse.move = vi.fn(slow('move'))
    page.waitForTimeout = vi.fn(
      (milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    )
    return { acknowledgedAt, dispatchedAt, page }
  }

  /**
   * The defect accumulates: one step late by (ACK_MS - SLOT_MS) is under a
   * millisecond and invisible per gap, n steps late are not. So the check is
   * the drift of every sample against the first one's slot grid.
   */
  function expectOnSlotGrid(samples: number[]): void {
    const first = samples[0] as number
    samples.forEach((time, index) => {
      expect(Math.abs(time - (first + index * SLOT_MS))).toBeLessThan(1)
    })
    // Reachability: awaited one by one, the last sample would be this far
    // behind -- far outside the tolerance above.
    expect((ACK_MS - SLOT_MS) * (samples.length - 1)).toBeGreaterThan(5)
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Advances the fake clock one millisecond at a time until `run` settles. */
  async function settle(run: Promise<unknown>): Promise<void> {
    let settled = false
    void run.then(
      () => (settled = true),
      () => (settled = true),
    )
    for (let step = 0; step < 60_000 && !settled; step += 1) {
      await vi.advanceTimersByTimeAsync(1)
    }
  }

  it('dispatches every wheel step on its own slot although each acknowledgement takes longer than a slot', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const output = await temporaryDirectory()
    const { acknowledgedAt, dispatchedAt, page } = slowAcknowledgingPage()
    let finishedAt = 0
    const run = createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.scroll(0, 600)
        finishedAt = Date.now()
      },
    )
    await settle(run)
    await run

    expect(dispatchedAt.wheel.length).toBeGreaterThan(10)
    // Within a millisecond of its slot (the fake clock truncates timer
    // delays to whole milliseconds).
    expectOnSlotGrid(dispatchedAt.wheel)
    // The scroll has fully arrived before demo.scroll returns.
    expect(acknowledgedAt).toHaveLength(
      dispatchedAt.wheel.length + dispatchedAt.move.length,
    )
    expect(finishedAt).toBeGreaterThanOrEqual(Math.max(...acknowledgedAt))
  })

  it('keeps pointer samples on their slots the same way', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const output = await temporaryDirectory()
    const { dispatchedAt, page } = slowAcknowledgingPage()
    const run = createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.point('#button')
      },
    )
    await settle(run)
    await run

    expect(dispatchedAt.move.length).toBeGreaterThan(10)
    // Each move is paced from its own start; within one move every sample
    // must sit on its slot. A move starts where the gap to the previous
    // dispatch exceeds a slot by more than the acknowledgement time.
    const moves: number[][] = []
    for (const time of dispatchedAt.move) {
      const current = moves.at(-1)
      if (!current || time - (current.at(-1) as number) > SLOT_MS + ACK_MS) {
        moves.push([time])
      } else {
        current.push(time)
      }
    }
    const longest = moves.reduce((a, b) => (b.length > a.length ? b : a))
    expect(longest.length).toBeGreaterThan(10)
    expectOnSlotGrid(longest)
  })

  it('surfaces a failed dispatch instead of losing it, and stops dispatching', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const output = await temporaryDirectory()
    const page = fakePage()
    let calls = 0
    page.mouse.wheel = vi.fn(() => {
      calls += 1
      return calls === 3
        ? Promise.reject(new Error('Target closed'))
        : Promise.resolve()
    })
    page.waitForTimeout = vi.fn(
      (milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    )
    const run = createRecorder(runtimeFor(page))(
      { out: output },
      async (_page, demo) => {
        await demo.scroll(0, 600)
      },
    )
    const outcome = expect(run).rejects.toThrow('Target closed')
    await settle(run)
    await outcome
    expect(calls).toBe(3)
  })
})
