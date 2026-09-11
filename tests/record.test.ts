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

function fakePage(viewport = { height: 720, width: 1280 }) {
  const boundingBox = vi
    .fn()
    .mockResolvedValue({ height: 20, width: 60, x: 100, y: 50 })
  const locatorValue = { boundingBox }
  const locator = vi.fn().mockReturnValue(locatorValue)
  return {
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

    expect(pointerEvents.length).toBeGreaterThan(1)
    expect(pointerEvents.map((event) => event.tick)).toEqual(
      pointerEvents.map((_event, index) => index),
    )
    expect(click.tick).toBe(pointerEvents.length)
    expect(tap.tick).toBe(click.tick)
    expect(typed.tick).toBe(tap.tick)
    expect(hold).toMatchObject({ milliseconds: 100, tick: typed.tick })
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
    expect(page.mouse.wheel).toHaveBeenCalledWith(10, 20)
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
    page.locator.mockImplementation((selector: string) => ({
      boundingBox: vi
        .fn()
        .mockResolvedValue(boxes[selector as keyof typeof boxes]),
    }))

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
    page.locator.mockReturnValue({
      boundingBox: vi.fn().mockResolvedValue(null),
    })

    await expect(
      createRecorder(runtimeFor(page))({ out: output }, async (_page, demo) =>
        demo.click('#missing'),
      ),
    ).rejects.toThrow('Target must resolve to a visible bounding box')
  })

  it('rejects a target whose bounding box lies outside the viewport', async () => {
    const output = await temporaryDirectory()
    const page = fakePage({ height: 720, width: 1280 })
    page.locator.mockReturnValue({
      boundingBox: vi
        .fn()
        .mockResolvedValue({ height: 20, width: 20, x: -1210, y: 640 }),
    })

    await expect(
      createRecorder(runtimeFor(page))({ out: output }, async (_page, demo) =>
        demo.click('#offscreen'),
      ),
    ).rejects.toThrow(/lies outside the .* viewport.*demo\.scroll/)
  })
})
