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
/** Default for `RecordOptions.settleTimeoutMs`. */
const DEFAULT_SETTLE_TIMEOUT_MS = 2000

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
  /** Runs a page-context function and awaits its (possibly async) result. */
  evaluate: <T>(pageFunction: () => T | Promise<T>) => Promise<T>
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
  /**
   * How long, in milliseconds, target-geometry resolution waits for a
   * page's own scrolling/animation to settle before giving up. A page that
   * animates forever (a marquee behind the target, say) would otherwise hang
   * a recording indefinitely. Default 2000.
   */
  settleTimeoutMs?: number
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
    const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
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
        const bbox = await waitForStableBoundingBox(
          page,
          locator,
          settleTimeoutMs,
        )
        return { bbox, locator }
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
          // `tick` is the scheduled 60Hz slot index: every generated sample —
          // including one that rounds to the same pixel as its predecessor
          // (the pointer briefly "held") — consumes and logs its own slot, so
          // tick stays a uniform timebase issue #9 can map onto the capture
          // clock 1:1.
          await sleepUntil(page, start + ((index + 1) / EVENT_LOG_FPS) * 1000)
          await page.mouse.move(next.x, next.y, { steps: 1 })
          pointer = next
          events.push({ type: 'pointer', tick, x: next.x, y: next.y })
          tick += 1
        }
      }

      const moveTo = async (
        target: Target,
      ): Promise<{ bbox: BoundingBox; x: number; y: number }> => {
        const { bbox } = await resolveTarget(target)
        // Clamp to the visible intersection rather than rejecting outright:
        // a hero or overlay bigger than the viewport is normal, and its
        // on-screen portion is still perfectly clickable. The full bbox is
        // still what gets logged, below.
        const destination = clampInteractionPoint(bbox, page.viewportSize())
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
          // Iterate code points, not UTF-16 code units, so a surrogate-pair
          // character (e.g. an emoji) counts as one key and doesn't pick up
          // a spurious trailing delay.
          const characters = [...text]
          const startTick = tick
          let consumedSlots = 0
          for (const [index, character] of characters.entries()) {
            await page.keyboard.type(character)
            if (index < characters.length - 1) {
              const delayMs =
                KEY_DELAY_MIN_MS + Math.round(random() * KEY_DELAY_JITTER_MS)
              // Deterministic from the seed, not measured wall time, so the
              // log stays reproducible even though the real wait varies.
              consumedSlots += Math.round((delayMs / 1000) * EVENT_LOG_FPS)
              await page.waitForTimeout(delayMs)
            }
          }
          events.push({ type: 'type', tick: startTick, text, bbox: hit.bbox })
          tick += consumedSlots
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
          const steps = computeScrollSteps(deltaX, deltaY)
          events.push({ type: 'scroll', tick, deltaX, deltaY })
          await paceWheel(page, deltaX, deltaY, steps)
          // scroll() itself doesn't know which element will be interacted
          // with next (it takes no target), so it can't settle on the
          // geometry that actually matters. resolveTarget() — called by the
          // next point/click/tap/type — is what waits for stable geometry,
          // covering any scroll mechanism (window, inner container,
          // JS-driven transform), not just this dispatch.
          tick += steps
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

const MAX_WHEEL_STEP_PX = 40

/** Number of 60Hz increments a scroll of this size is split into. Pure and
 * deterministic so the tick timebase never depends on measured wall time. */
function computeScrollSteps(deltaX: number, deltaY: number): number {
  const magnitude = Math.hypot(deltaX, deltaY)
  return Math.max(1, Math.ceil(magnitude / MAX_WHEEL_STEP_PX))
}

/** Splits a scroll into 60 Hz increments paced against absolute deadlines. */
async function paceWheel(
  page: RecordPage,
  deltaX: number,
  deltaY: number,
  steps: number,
): Promise<void> {
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

const STABLE_READS_REQUIRED = 3
const STABLE_POLL_INTERVAL_MS = 16

/**
 * Resolves a target's bounding box only once it has stopped moving —
 * `STABLE_READS_REQUIRED` consecutive (rounded) reads must agree — so a
 * caller never acts on geometry that's still mid-scroll or mid-animation.
 * This is a plain Node-side polling loop over `locator.boundingBox()`, not a
 * `page.evaluate()` watcher keyed on `window.scrollX/Y`: that would miss any
 * scroll that isn't the window itself (an `overflow:auto` container, or a
 * JS-driven transform like Lenis-style inertial scrolling), and the actual
 * geometry of the element we're about to interact with is what matters,
 * regardless of which mechanism moved it. Throws, naming the option that
 * controls the budget, if it never stabilizes in time.
 */
async function waitForStableBoundingBox(
  page: RecordPage,
  locator: LocatorLike,
  timeoutMs: number,
): Promise<BoundingBox> {
  const start = Date.now()
  let previous: BoundingBox | null = null
  let stableReads = 0
  for (;;) {
    const raw = await locator.boundingBox()
    if (raw === null || raw.width <= 0 || raw.height <= 0) {
      throw new Error('Target must resolve to a visible bounding box')
    }
    const current = normalizedBoundingBox(raw)
    stableReads =
      previous !== null && sameBoundingBox(current, previous)
        ? stableReads + 1
        : 1
    previous = current
    if (stableReads >= STABLE_READS_REQUIRED) {
      return current
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Target geometry did not settle within settleTimeoutMs (${String(timeoutMs)}ms). ` +
          'Increase RecordOptions.settleTimeoutMs if the page keeps animating intentionally.',
      )
    }
    await page.waitForTimeout(STABLE_POLL_INTERVAL_MS)
  }
}

function sameBoundingBox(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  )
}

/**
 * Clamps the interaction point to the visible intersection of the bbox and
 * the viewport, instead of rejecting a target that's merely bigger than the
 * viewport (a full-height hero, an overlay) — that's normal, and the visible
 * portion is still clickable. Throws only when there's no visible overlap at
 * all. The returned point is strictly inside `[0, width) x [0, height)`: the
 * intersection midpoint can still round onto the boundary pixel for a target
 * flush against an edge, which is not a valid, clickable coordinate.
 */
function clampInteractionPoint(
  bbox: BoundingBox,
  viewport: ViewportSize | null,
): { x: number; y: number } {
  const naturalCenter = {
    x: Math.round(bbox.x + bbox.width / 2),
    y: Math.round(bbox.y + bbox.height / 2),
  }
  if (viewport === null) return naturalCenter

  const left = Math.max(bbox.x, 0)
  const right = Math.min(bbox.x + bbox.width, viewport.width)
  const top = Math.max(bbox.y, 0)
  const bottom = Math.min(bbox.y + bbox.height, viewport.height)
  if (right <= left || bottom <= top) {
    throw new Error(
      `Target bounding box (${String(bbox.x)}, ${String(bbox.y)}, ` +
        `${String(bbox.width)}x${String(bbox.height)}) has no visible ` +
        `intersection with the ${String(viewport.width)}x` +
        `${String(viewport.height)} viewport. Use demo.scroll to bring it ` +
        'into view before interacting.',
    )
  }
  return {
    x: Math.min(
      Math.max(Math.round((left + right) / 2), 0),
      viewport.width - 1,
    ),
    y: Math.min(
      Math.max(Math.round((top + bottom) / 2), 0),
      viewport.height - 1,
    ),
  }
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
