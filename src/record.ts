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
/**
 * Default for `RecordOptions.settleTimeoutMs`. Marketing pages routinely run
 * multi-second CSS transitions on the exact content this tool records; 2000ms
 * aborted an ordinary 4s transition outright. 5000ms covers that with room to
 * spare while still failing a genuinely never-settling page in finite time.
 */
const DEFAULT_SETTLE_TIMEOUT_MS = 5000

export type BoundingBox = {
  height: number
  width: number
  x: number
  y: number
}

export type LocatorLike = {
  boundingBox: () => Promise<BoundingBox | null>
  /** Mirrors Playwright's `Locator.evaluate`; used to hit-test the live DOM. */
  evaluate: <Arg>(
    pageFunction: (element: Element, arg: Arg) => unknown,
    arg: Arg,
  ) => Promise<unknown>
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
   * a recording indefinitely. Default 5000 — long enough for an ordinary
   * multi-second CSS transition, short enough to fail fast otherwise.
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

      const resolveLocator = (target: Target): LocatorLike =>
        typeof target === 'string' ? page.locator(target) : target

      /**
       * Resolves a settled bbox and a verified, hit-testable interaction
       * point for it in one step — the two always travel together, since a
       * point is only meaningful relative to the geometry it was derived
       * from.
       */
      const resolveVerifiedTarget = async (
        locator: LocatorLike,
      ): Promise<{ bbox: BoundingBox; point: { x: number; y: number } }> => {
        const bbox = await waitForStableBoundingBox(
          page,
          locator,
          settleTimeoutMs,
        )
        const point = await findVerifiedInteractionPoint(
          locator,
          bbox,
          page.viewportSize(),
        )
        return { bbox, point }
      }

      const moveToPoint = async (
        destination: { x: number; y: number },
        motionSeed: number,
      ): Promise<void> => {
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

      // A logical interaction's motion seed(s) are derived deterministically
      // from (recorder seed, interaction index, move role) — never drawn
      // from the shared `random()` stream. The corrective stretch below only
      // runs when arrival-time verification fails, which is a timing race
      // against the page; if that draw came from the shared stream, an
      // extra (even zero-length) correction would shift the seed of every
      // later move and tick, putting bit-identical reproducibility at risk
      // on any page with a chance of triggering it. A pure hash keyed on the
      // interaction's own index cannot be perturbed by what happened before.
      let interactionIndex = -1
      const INITIAL_MOVE_INDEX = -1
      const PRIMARY_MOVE_ROLE = 0
      const CORRECTIVE_MOVE_ROLE = 1

      const moveTo = async (
        target: Target,
      ): Promise<{ bbox: BoundingBox; x: number; y: number }> => {
        interactionIndex += 1
        const thisInteraction = interactionIndex
        const locator = resolveLocator(target)
        const { point: initialPoint } = await resolveVerifiedTarget(locator)
        await moveToPoint(
          initialPoint,
          deriveMotionSeed(seed, thisInteraction, PRIMARY_MOVE_ROLE),
        )

        // The travel above can take 0.4-4s (longer for distant targets).
        // Trusting geometry resolved *before* it — as the previous version
        // did — is exactly how a click gets logged for something that never
        // happened: the target can move, get re-rendered, or end up covered
        // by something else while the cursor is still travelling. Re-verify
        // the same point actually still hits the target now that we've
        // arrived; only if that fails does the more expensive full
        // re-resolution below run.
        let point = initialPoint
        if (!(await hitsTarget(locator, point))) {
          const corrected = await resolveVerifiedTarget(locator)
          await moveToPoint(
            corrected.point,
            deriveMotionSeed(seed, thisInteraction, CORRECTIVE_MOVE_ROLE),
          )
          if (!(await hitsTarget(locator, corrected.point))) {
            throw new Error(
              'Target moved during pointer travel and could not be ' +
                'reliably hit even after re-resolving and correcting the ' +
                'approach. Never logging an unverified interaction.',
            )
          }
          point = corrected.point
        }

        // Refreshed unconditionally, right before the caller logs it — not
        // just inside the corrective branch above. A target can grow or
        // shift around a stable center during the 0.4-4s travel and still
        // hit-test correctly at the same point without ever entering that
        // branch, yet be a visually different rect than what was resolved
        // before moving; a later renderer zooms exactly this bbox.
        const freshRaw = await locator.boundingBox()
        if (freshRaw === null || freshRaw.width <= 0 || freshRaw.height <= 0) {
          throw new Error('Target must resolve to a visible bounding box')
        }
        return { bbox: normalizedBoundingBox(freshRaw), ...point }
      }

      // Give the log and the app the same deterministic rest position before
      // the script's first interaction, and actually drive the real cursor
      // there through the same paced, capped curve as any other move.
      const startViewport = page.viewportSize() ?? DEFAULT_VIEWPORT
      await moveToPoint(
        {
          x: Math.round(startViewport.width / 2),
          y: Math.round(startViewport.height / 2),
        },
        deriveMotionSeed(seed, INITIAL_MOVE_INDEX, PRIMARY_MOVE_ROLE),
      )

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

const STABLE_WINDOW_MS = 80
const STABLE_POLL_INTERVAL_MS = 16
/**
 * Below this, two reads count as "the same" geometry. Deliberately a real
 * sub-pixel epsilon, not integer rounding: rounding first made two reads of
 * a 0.25px/16ms drift compare equal on every single poll, so a target that
 * never actually stopped moving was declared settled anyway.
 */
const STABLE_EPSILON_PX = 0.5

/**
 * Resolves a target's bounding box only once it has stayed within
 * `STABLE_EPSILON_PX` of a reference reading for a full `STABLE_WINDOW_MS`
 * window — a time budget, not a fixed read count, so a crawl slower than the
 * poll interval (e.g. 1px/100ms) can't rack up "unchanged" reads by luck
 * before the window has actually elapsed. This is a plain Node-side polling
 * loop over `locator.boundingBox()`, not a `page.evaluate()` watcher keyed on
 * `window.scrollX/Y`: that would miss any scroll that isn't the window
 * itself (an `overflow:auto` container, or a JS-driven transform like
 * Lenis-style inertial scrolling), and the actual geometry of the element
 * we're about to interact with is what matters, regardless of which
 * mechanism moved it. Throws, naming the option that controls the budget, if
 * it never stabilizes in time. Rounds only the final, settled value — never
 * the intermediate comparisons — so the caller gets the same clean integers
 * the rest of the log already uses.
 */
async function waitForStableBoundingBox(
  page: RecordPage,
  locator: LocatorLike,
  timeoutMs: number,
): Promise<BoundingBox> {
  const overallStart = Date.now()
  let reference: BoundingBox | null = null
  let windowStart = Date.now()
  for (;;) {
    const raw = await locator.boundingBox()
    if (raw === null || raw.width <= 0 || raw.height <= 0) {
      throw new Error('Target must resolve to a visible bounding box')
    }
    const now = Date.now()
    if (reference === null || !closeEnough(raw, reference)) {
      reference = raw
      windowStart = now
    }
    if (now - windowStart >= STABLE_WINDOW_MS) {
      return normalizedBoundingBox(raw)
    }
    if (now - overallStart > timeoutMs) {
      throw new Error(
        `Target geometry did not settle within settleTimeoutMs (${String(timeoutMs)}ms). ` +
          'Increase RecordOptions.settleTimeoutMs if the page keeps animating intentionally.',
      )
    }
    await page.waitForTimeout(STABLE_POLL_INTERVAL_MS)
  }
}

function closeEnough(a: BoundingBox, b: BoundingBox): boolean {
  return (
    Math.abs(a.x - b.x) < STABLE_EPSILON_PX &&
    Math.abs(a.y - b.y) < STABLE_EPSILON_PX &&
    Math.abs(a.width - b.width) < STABLE_EPSILON_PX &&
    Math.abs(a.height - b.height) < STABLE_EPSILON_PX
  )
}

/** How far, in px, an edge/corner probe sits inside the visible intersection. */
const EDGE_PROBE_INSET_PX = 4

/**
 * A small, deterministic set of candidate interaction points inside the
 * visible bbox/viewport intersection: center first (the common case), then
 * a point near the middle of each edge, then each corner — inset a few
 * pixels so a probe doesn't land exactly on a boundary. This is what finds a
 * clickable sliver when most of the element is covered by something else
 * (e.g. only the bottom 20px of a 200px-tall element is below a fixed
 * header): the center alone would land on the header every time. Throws if
 * the bbox has no visible overlap with the viewport at all.
 */
function candidateInteractionPoints(
  bbox: BoundingBox,
  viewport: ViewportSize | null,
): { x: number; y: number }[] {
  if (viewport === null) {
    return [
      {
        x: Math.round(bbox.x + bbox.width / 2),
        y: Math.round(bbox.y + bbox.height / 2),
      },
    ]
  }

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

  const inset = Math.min(
    EDGE_PROBE_INSET_PX,
    (right - left) / 2,
    (bottom - top) / 2,
  )
  const xs = {
    left: left + inset,
    mid: (left + right) / 2,
    right: right - inset,
  }
  const ys = {
    top: top + inset,
    mid: (top + bottom) / 2,
    bottom: bottom - inset,
  }
  const raw: [number, number][] = [
    [xs.mid, ys.mid],
    [xs.mid, ys.top],
    [xs.mid, ys.bottom],
    [xs.left, ys.mid],
    [xs.right, ys.mid],
    [xs.left, ys.top],
    [xs.right, ys.top],
    [xs.left, ys.bottom],
    [xs.right, ys.bottom],
  ]
  const clampToViewport = (x: number, y: number): { x: number; y: number } => ({
    x: Math.min(Math.max(Math.round(x), 0), viewport.width - 1),
    y: Math.min(Math.max(Math.round(y), 0), viewport.height - 1),
  })
  const points = raw.map(([x, y]) => clampToViewport(x, y))
  return points.filter(
    (point, index) =>
      points.findIndex(
        (other) => other.x === point.x && other.y === point.y,
      ) === index,
  )
}

/**
 * Hit-tests a candidate point against the live DOM: does the element that
 * actually paints at these coordinates right now equal the target or one of
 * its descendants? This — not the geometry alone — is the ground truth for
 * "would a real click here land on the target", and it catches occlusion
 * (something else on top) the same way it catches the target having moved.
 * The callback contains no named nested function: tsx compiles with
 * esbuild's `keepNames: true`, which would otherwise wrap it in a
 * `__name(...)` call that doesn't exist once this source text is serialized
 * into the page (see tests/tsx-pipeline.test.ts).
 */
async function hitsTarget(
  locator: LocatorLike,
  point: { x: number; y: number },
): Promise<boolean> {
  const result = await locator.evaluate((element, arg) => {
    const hit = document.elementFromPoint(arg.x, arg.y)
    return hit !== null && (hit === element || element.contains(hit))
  }, point)
  return result === true
}

/**
 * Finds the first candidate interaction point that actually hit-tests to the
 * target, trying center first and falling back through edges and corners.
 * Throws if the target is occluded at every candidate — a script author
 * needs to know their interaction was never sent, not get a silent miss.
 */
async function findVerifiedInteractionPoint(
  locator: LocatorLike,
  bbox: BoundingBox,
  viewport: ViewportSize | null,
): Promise<{ x: number; y: number }> {
  const candidates = candidateInteractionPoints(bbox, viewport)
  for (const candidate of candidates) {
    if (await hitsTarget(locator, candidate)) return candidate
  }
  throw new Error(
    `Target bounding box (${String(bbox.x)}, ${String(bbox.y)}, ` +
      `${String(bbox.width)}x${String(bbox.height)}) is occluded at every ` +
      'candidate point inside it — something else (an overlay, a sticky ' +
      'header) is on top. Never logging an unverified interaction.',
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
/**
 * Derives a motion seed as a pure function of (recorder seed, interaction
 * index, move role) — never by drawing from a shared sequential stream. This
 * is what makes a corrective move (see moveTo) safe for determinism: however
 * many logical interactions ran before it, and whether or not any of them
 * needed a correction, this interaction's seed(s) are always the same.
 */
function deriveMotionSeed(
  baseSeed: number,
  interactionIndex: number,
  role: number,
): number {
  const mixed =
    (baseSeed ^
      Math.imul(interactionIndex, 0x9e3779b1) ^
      Math.imul(role, 0x85ebca6b)) >>>
    0
  return Math.floor(createRandom(mixed)() * 0x1_0000_0000)
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
