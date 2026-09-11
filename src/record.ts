import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { generateMotionPoints } from './motion.js'

const EVENTS_FILE_NAME = 'events.jsonl'
export const EVENT_LOG_FPS = 60
/** Where the pointer rests before the script's first interaction. */
const DEFAULT_VIEWPORT = { width: 1280, height: 720 }
/** Deterministic per-keystroke delay range, in milliseconds. */
const KEY_DELAY_MIN_MS = 40
const KEY_DELAY_JITTER_MS = 70

export type BoundingBox = {
  height: number
  width: number
  x: number
  y: number
}

export type LocatorLike = {
  boundingBox: () => Promise<BoundingBox | null>
}

export type ViewportSize = { height: number; width: number }

export type RecordPage = {
  goto: (url: string) => Promise<void>
  /** Set by the runtime from the resolved device descriptor; false without one. */
  hasTouch: boolean
  keyboard: { type: (text: string) => Promise<void> }
  locator: (selector: string) => LocatorLike
  mouse: {
    click: (x: number, y: number) => Promise<void>
    move: (x: number, y: number, options: { steps: number }) => Promise<void>
    wheel: (deltaX: number, deltaY: number) => Promise<void>
  }
  touchscreen: { tap: (x: number, y: number) => Promise<void> }
  /** Mirrors Playwright's synchronous `page.viewportSize()`. */
  viewportSize: () => ViewportSize | null
  waitForTimeout: (milliseconds: number) => Promise<void>
}

export type Target = LocatorLike | string

/**
 * Public recording options. `device` already resolves a Playwright device
 * descriptor (viewport, touch capability, engine) at the runtime boundary; the
 * curated preset layer plus its own capture/output overrides land in M5.
 */
export type RecordOptions = {
  /** A name from Playwright's device registry, resolved at runtime start. */
  device?: string
  /** Directory that receives the versioned event artifact. */
  out: string
  /** Stable seed used for reproducible pointer motion. */
  seed?: number
}

export type Demo = {
  click: (target: Target) => Promise<void>
  hold: (milliseconds: number) => Promise<void>
  point: (target: Target) => Promise<void>
  scroll: (deltaX: number, deltaY: number) => Promise<void>
  tap: (target: Target) => Promise<void>
  type: (target: Target, text: string) => Promise<void>
}

export type EventHeader = {
  fps: typeof EVENT_LOG_FPS
  seed: number
  type: 'header'
  version: 1
}

export type PointerEvent = {
  tick: number
  type: 'pointer'
  x: number
  y: number
}

export type ClickEvent = {
  bbox: BoundingBox
  tick: number
  type: 'click'
  x: number
  y: number
}

export type TapEvent = {
  bbox: BoundingBox
  tick: number
  type: 'tap'
  x: number
  y: number
}

export type HoldEvent = { milliseconds: number; tick: number; type: 'hold' }

export type ScrollEvent = {
  deltaX: number
  deltaY: number
  tick: number
  type: 'scroll'
}

export type TypeEvent = {
  bbox: BoundingBox
  text: string
  tick: number
  type: 'type'
}

/** The complete v1 JSONL record vocabulary. `tick` is a 60 fps renderer timebase. */
export type RecordEvent =
  | EventHeader
  | PointerEvent
  | ClickEvent
  | TapEvent
  | HoldEvent
  | ScrollEvent
  | TypeEvent

/**
 * Advanced runtime seam. It is used by tests and will be replaced by the M1/M5
 * capture lifecycle; public callers use `record` and never supply a page.
 */
export type RecordRuntime = {
  run: (
    options: RecordOptions,
    script: (page: RecordPage) => Promise<void>,
  ) => Promise<void>
}

type Script = (page: RecordPage, demo: Demo) => Promise<void>

/**
 * Starts a recording with a Playwright page supplied by the default runtime.
 */
export async function record(
  options: RecordOptions,
  script: Script,
): Promise<void> {
  return createRecorder(defaultRuntime)(options, script)
}

/** Creates a recorder around an injected page runtime for integration boundaries. */
export function createRecorder(
  runtime: RecordRuntime,
): (options: RecordOptions, script: Script) => Promise<void> {
  return async (options, script) => {
    const seed = options.seed ?? 1
    assertSeed(seed)
    const random = createRandom(seed)
    const events: RecordEvent[] = []
    let tick = 0

    await runtime.run(options, async (page) => {
      // The real browser's own cursor starts at the origin; we track that same
      // assumption here so the first generated curve (below) is a real motion
      // from a real position, not a teleport.
      let pointer = { x: 0, y: 0 }

      const resolveTarget = async (
        target: Target,
      ): Promise<{ bbox: BoundingBox; locator: LocatorLike }> => {
        const locator =
          typeof target === 'string' ? page.locator(target) : target
        const bbox = await locator.boundingBox()
        if (bbox === null || bbox.width <= 0 || bbox.height <= 0) {
          throw new Error('Target must resolve to a visible bounding box')
        }
        const normalized = normalizedBoundingBox(bbox)
        const viewport = page.viewportSize()
        if (viewport !== null && !intersectsViewport(normalized, viewport)) {
          throw new Error(
            `Target bounding box (${normalized.x}, ${normalized.y}, ` +
              `${normalized.width}x${normalized.height}) lies outside the ` +
              `${viewport.width}x${viewport.height} viewport. Use demo.scroll ` +
              'to bring it into view before interacting.',
          )
        }
        return { bbox: normalized, locator }
      }

      const moveToPoint = async (destination: {
        x: number
        y: number
      }): Promise<void> => {
        const motionSeed = Math.floor(random() * 0x1_0000_0000)
        const points = generateMotionPoints(
          pointer,
          destination,
          motionSeed,
          EVENT_LOG_FPS,
        )
        const start = Date.now()
        for (const [index, next] of points.entries()) {
          // Real samples land on absolute deadlines (start + i/fps), not
          // accumulated sleeps, so pacing error never compounds across a move.
          // A held pixel still consumes its deadline even when it is not
          // re-emitted as a log event just below.
          await sleepUntil(page, start + ((index + 1) / EVENT_LOG_FPS) * 1000)
          if (next.x !== pointer.x || next.y !== pointer.y) {
            await page.mouse.move(next.x, next.y, { steps: 1 })
            pointer = next
            events.push({ type: 'pointer', tick, x: next.x, y: next.y })
            tick += 1
          }
        }
      }

      const moveTo = async (
        target: Target,
      ): Promise<{ bbox: BoundingBox; x: number; y: number }> => {
        const { bbox } = await resolveTarget(target)
        const destination = {
          x: Math.round(bbox.x + bbox.width / 2),
          y: Math.round(bbox.y + bbox.height / 2),
        }
        await moveToPoint(destination)
        return { bbox, ...destination }
      }

      // Give the log and the app the same deterministic rest position before
      // the script's first interaction, and actually drive the real cursor
      // there through the same paced, capped curve as any other move.
      const startViewport = page.viewportSize() ?? DEFAULT_VIEWPORT
      await moveToPoint({
        x: Math.round(startViewport.width / 2),
        y: Math.round(startViewport.height / 2),
      })

      const demo: Demo = {
        point: async (target) => {
          await moveTo(target)
        },
        click: async (target) => {
          const hit = await moveTo(target)
          await page.mouse.click(hit.x, hit.y)
          events.push({
            type: 'click',
            tick,
            x: hit.x,
            y: hit.y,
            bbox: hit.bbox,
          })
        },
        tap: async (target) => {
          const hit = await moveTo(target)
          await page.touchscreen.tap(hit.x, hit.y)
          events.push({ type: 'tap', tick, x: hit.x, y: hit.y, bbox: hit.bbox })
        },
        type: async (target, text) => {
          const hit = await moveTo(target)
          if (page.hasTouch) {
            await page.touchscreen.tap(hit.x, hit.y)
          } else {
            await page.mouse.click(hit.x, hit.y)
          }
          for (const [index, character] of [...text].entries()) {
            await page.keyboard.type(character)
            if (index < text.length - 1) {
              const delay =
                KEY_DELAY_MIN_MS + Math.round(random() * KEY_DELAY_JITTER_MS)
              await page.waitForTimeout(delay)
            }
          }
          events.push({ type: 'type', tick, text, bbox: hit.bbox })
        },
        hold: async (milliseconds) => {
          if (!Number.isFinite(milliseconds) || milliseconds < 0) {
            throw new Error(
              'Hold duration must be a non-negative finite number',
            )
          }
          const roundedMilliseconds = Math.round(milliseconds)
          events.push({ type: 'hold', tick, milliseconds: roundedMilliseconds })
          tick += Math.ceil((roundedMilliseconds / 1000) * EVENT_LOG_FPS)
          await page.waitForTimeout(roundedMilliseconds)
        },
        scroll: async (deltaX, deltaY) => {
          if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
            throw new Error('Scroll deltas must be finite numbers')
          }
          await paceWheel(page, deltaX, deltaY)
          events.push({ type: 'scroll', tick, deltaX, deltaY })
        },
      }

      await script(page, demo)
    })

    await mkdir(options.out, { recursive: true })
    const header: EventHeader = {
      type: 'header',
      version: 1,
      fps: EVENT_LOG_FPS,
      seed,
    }
    await writeFile(
      join(options.out, EVENTS_FILE_NAME),
      `${[header, ...events].map(serializeEvent).join('\n')}\n`,
    )
  }
}

/** Serializes one validated v1 event with canonical, stable field ordering. */
export function serializeEvent(event: RecordEvent): string {
  validateEvent(event)
  switch (event.type) {
    case 'header':
      return JSON.stringify({
        type: event.type,
        version: event.version,
        fps: event.fps,
        seed: event.seed,
      })
    case 'pointer':
      return JSON.stringify({
        type: event.type,
        tick: event.tick,
        x: event.x,
        y: event.y,
      })
    case 'click':
    case 'tap':
      return JSON.stringify({
        type: event.type,
        tick: event.tick,
        x: event.x,
        y: event.y,
        bbox: orderedBoundingBox(event.bbox),
      })
    case 'hold':
      return JSON.stringify({
        type: event.type,
        tick: event.tick,
        milliseconds: event.milliseconds,
      })
    case 'scroll':
      return JSON.stringify({
        type: event.type,
        tick: event.tick,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      })
    case 'type':
      return JSON.stringify({
        type: event.type,
        tick: event.tick,
        text: event.text,
        bbox: orderedBoundingBox(event.bbox),
      })
  }
}

const defaultRuntime: RecordRuntime = {
  async run(options, script) {
    const { chromium, devices } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    try {
      const descriptor = options.device
        ? resolveDeviceDescriptor(
            options.device,
            devices as Record<string, Record<string, unknown>>,
          )
        : {}
      const context = await browser.newContext(descriptor)
      try {
        const page = await context.newPage()
        // Attach the resolved touch capability so the wrapper can choose
        // between a mouse click and a tap without re-reading the descriptor.
        const recordPage = page as unknown as RecordPage
        recordPage.hasTouch = Boolean(
          (descriptor as { hasTouch?: boolean }).hasTouch,
        )
        await script(recordPage)
      } finally {
        await context.close()
      }
    } finally {
      await browser.close()
    }
  },
}

/**
 * Resolves a Playwright device name against its runtime registry. Throws with
 * a short, actionable name list instead of Playwright's raw `hasTouch` crash
 * when a context is built from an unknown or missing descriptor.
 */
function resolveDeviceDescriptor(
  name: string,
  devices: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const descriptor = devices[name]
  if (descriptor) return descriptor
  const lowerName = name.toLowerCase()
  const registryNames = Object.keys(devices)
  const close = registryNames.filter((candidate) =>
    candidate.toLowerCase().includes(lowerName),
  )
  const suggestions = (close.length > 0 ? close : registryNames)
    .slice(0, 5)
    .join(', ')
  throw new Error(`Unknown device "${name}". Close names: ${suggestions}`)
}

/** Splits a scroll into 60 Hz increments paced against absolute deadlines. */
async function paceWheel(
  page: RecordPage,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  const magnitude = Math.hypot(deltaX, deltaY)
  const maxWheelStep = 40
  const steps = Math.max(1, Math.ceil(magnitude / maxWheelStep))
  const start = Date.now()
  let sentX = 0
  let sentY = 0
  for (let index = 1; index <= steps; index += 1) {
    await sleepUntil(page, start + (index / EVENT_LOG_FPS) * 1000)
    const targetX = Math.round((deltaX * index) / steps)
    const targetY = Math.round((deltaY * index) / steps)
    await page.mouse.wheel(targetX - sentX, targetY - sentY)
    sentX = targetX
    sentY = targetY
  }
}

/** Waits until an absolute deadline instead of sleeping a fixed duration. */
async function sleepUntil(page: RecordPage, deadline: number): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining > 0) await page.waitForTimeout(remaining)
}

function intersectsViewport(
  bbox: BoundingBox,
  viewport: ViewportSize,
): boolean {
  return (
    bbox.x < viewport.width &&
    bbox.x + bbox.width > 0 &&
    bbox.y < viewport.height &&
    bbox.y + bbox.height > 0
  )
}

function validateEvent(event: RecordEvent): void {
  if (event.type === 'header') {
    if (event.version !== 1 || event.fps !== EVENT_LOG_FPS)
      throw new Error('header version and fps must be v1 constants')
    assertSeed(event.seed)
    return
  }
  assertTick(event.tick)
  if ('x' in event) {
    assertFinite(event.x, 'x')
    assertFinite(event.y, 'y')
  }
  if ('bbox' in event) assertBoundingBox(event.bbox)
  if (
    event.type === 'hold' &&
    (!Number.isInteger(event.milliseconds) || event.milliseconds < 0)
  )
    throw new Error('milliseconds must be a non-negative integer')
  if (event.type === 'scroll') {
    assertFinite(event.deltaX, 'deltaX')
    assertFinite(event.deltaY, 'deltaY')
  }
  if (event.type === 'type' && typeof event.text !== 'string')
    throw new Error('text must be a string')
}

function assertTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < 0)
    throw new Error('tick must be a non-negative integer')
}
function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
}
function assertBoundingBox(bbox: BoundingBox): void {
  assertFinite(bbox.x, 'bbox.x')
  assertFinite(bbox.y, 'bbox.y')
  assertFinite(bbox.width, 'bbox.width')
  assertFinite(bbox.height, 'bbox.height')
  if (bbox.width <= 0 || bbox.height <= 0)
    throw new Error('bbox width and height must be positive')
}
function orderedBoundingBox(bbox: BoundingBox): BoundingBox {
  return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height }
}
function assertSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('Seed must be an unsigned 32-bit integer')
}
function normalizedBoundingBox(bbox: BoundingBox): BoundingBox {
  return {
    x: Math.round(bbox.x),
    y: Math.round(bbox.y),
    width: Math.round(bbox.width),
    height: Math.round(bbox.height),
  }
}
function createRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000
  }
}
