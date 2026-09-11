import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { generateMotionPoints, minimumJerk } from './motion.js'

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

export type ScrollOptions = {
  /**
   * Video-appropriate scroll speed in px/s along the straight-line distance
   * `hypot(deltaX, deltaY)`. Defaults to `DEFAULT_SCROLL_SPEED_PX_PER_SECOND`.
   * Override per call for a slower reveal or a faster "skip past this"
   * scroll; the eased 60Hz cadence and the per-step cap apply either way.
   */
  speedPxPerSecond?: number
}

export type Demo = {
  click: (target: Target) => Promise<void>
  hold: (milliseconds: number) => Promise<void>
  point: (target: Target) => Promise<void>
  scroll: (
    deltaX: number,
    deltaY: number,
    options?: ScrollOptions,
  ) => Promise<void>
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
        scroll: async (deltaX, deltaY, options) => {
          if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
            throw new Error('Scroll deltas must be finite numbers')
          }
          const speedPxPerSecond =
            options?.speedPxPerSecond ?? DEFAULT_SCROLL_SPEED_PX_PER_SECOND
          if (!Number.isFinite(speedPxPerSecond) || speedPxPerSecond <= 0) {
            throw new Error('Scroll speed must be a positive finite number')
          }
          const positions = computeScrollPositions(
            deltaX,
            deltaY,
            speedPxPerSecond,
            EVENT_LOG_FPS,
          )
          events.push({ type: 'scroll', tick, deltaX, deltaY })
          await paceWheel(page, positions)
          // scroll() itself doesn't know which element will be interacted
          // with next (it takes no target), so it can't settle on the
          // geometry that actually matters. resolveTarget() — called by the
          // next point/click/tap/type — is what waits for stable geometry,
          // covering any scroll mechanism (window, inner container,
          // JS-driven transform), not just this dispatch.
          tick += positions.length
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

/**
 * Default for `ScrollOptions.speedPxPerSecond`. Chosen as the midpoint of a
 * 500-900px/s video-appropriate range: fast enough that a full-viewport
 * scroll doesn't drag, slow enough that the eased motion below still reads
 * as a deliberate, watchable scroll rather than a blur between two frames.
 */
export const DEFAULT_SCROLL_SPEED_PX_PER_SECOND = 700
/**
 * Hard per-60Hz-step cap on scroll travel, mirroring `MAX_POINTER_STEP_PX`'s
 * "no big jumps between frames" guarantee for pointer motion. Issue #15's
 * defect was exactly this missing for scroll: 40px-capped wheel *packets*
 * turned a 525px scroll into 14 giant, evenly-spaced jumps (~37px each,
 * ~2250px/s) that a screen recorder simply cannot resolve as motion — most
 * of those jumps land between two captured frames. 30px comfortably covers
 * the eased peak step at the top of the advertised 500-900px/s range (a
 * minimum-jerk profile peaks at 1.875x its average step — see
 * `SCROLL_MIN_JERK_PEAK_RATIO` below — which is ~28px/step at 900px/s), so
 * the growth loop below almost never has to lengthen an in-range scroll's
 * duration to satisfy this cap.
 */
export const MAX_SCROLL_STEP_PX = 30
/**
 * A minimum-jerk ease profile's peak instantaneous "velocity" (in progress
 * units) is 1.875x its average — the same ratio `motion.ts` derives for
 * pointer travel. Used below as an analytic starting estimate for how many
 * 60Hz samples a scroll of a given distance needs to keep every step under
 * `MAX_SCROLL_STEP_PX`; the growth loop that follows corrects any shortfall
 * from rounding, so this only has to be a good guess, not exact.
 */
const SCROLL_MIN_JERK_PEAK_RATIO = 1.875
/** Safety valve for the scroll sample-count growth loop; see motion.ts's
 * identical `MAX_GROWTH_ITERATIONS` — never expected to be hit in practice. */
const MAX_SCROLL_GROWTH_ITERATIONS = 100
/** Deliberately gentle, matching motion.ts's `GROWTH_FACTOR` reasoning: a
 * coarse factor overshoots the true minimum sample count, which directly
 * inflates scroll duration for no benefit. */
const SCROLL_GROWTH_FACTOR = 1.08

/**
 * Analytic lower bound on sample count, derived the same way as
 * `minimumJerkBoundSamples` in motion.ts but without a settle-window
 * subtraction — a scroll eases in and out over its *entire* travel, it
 * doesn't spend a trailing fraction settling into an overshoot.
 */
function scrollMinimumJerkBoundSamples(distance: number): number {
  if (distance <= 0) return 1
  return Math.ceil((SCROLL_MIN_JERK_PEAK_RATIO * distance) / MAX_SCROLL_STEP_PX)
}

/**
 * Renders `samples` cumulative (from the scroll's own zero) wheel targets
 * along an eased minimum-jerk envelope. The final sample is always the
 * exact, unrounded `{ deltaX, deltaY }` — never a rounded approximation of
 * it — so the total scrolled distance is exact regardless of how many
 * intermediate steps got rounded to whole pixels.
 */
function renderScrollPositions(
  deltaX: number,
  deltaY: number,
  samples: number,
): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = []
  for (let index = 1; index <= samples; index += 1) {
    if (index === samples) {
      positions.push({ x: deltaX, y: deltaY })
      continue
    }
    const eased = minimumJerk(index / samples)
    positions.push({
      x: Math.round(deltaX * eased),
      y: Math.round(deltaY * eased),
    })
  }
  return positions
}

/** Max step across the whole cumulative sequence, including the seam from
 * the scroll's own zero to its first generated sample — see
 * `maxConsecutiveStep` in motion.ts for why that seam counts too. */
function maxConsecutiveScrollStep(
  positions: { x: number; y: number }[],
): number {
  let max = 0
  let previous = { x: 0, y: 0 }
  for (const current of positions) {
    const step = Math.hypot(current.x - previous.x, current.y - previous.y)
    if (step > max) max = step
    previous = current
  }
  return max
}

/**
 * Turns a scroll into a distance-over-time motion, like pointer travel,
 * instead of dividing a fixed distance into as few large wheel packets as
 * possible (issue #15). The sample count starts from a video-appropriate
 * speed and is then deterministically grown — same inputs, same result —
 * until the actually rendered, rounded envelope satisfies the hard
 * `MAX_SCROLL_STEP_PX` per-step cap, mirroring `generateMotionPoints`'s
 * guarantee loop in motion.ts exactly.
 */
export function computeScrollPositions(
  deltaX: number,
  deltaY: number,
  speedPxPerSecond: number,
  fps: number,
): { x: number; y: number }[] {
  const distance = Math.hypot(deltaX, deltaY)
  if (distance < 0.5) return [{ x: deltaX, y: deltaY }]

  const naturalSamples = Math.ceil((distance / speedPxPerSecond) * fps)
  let samples = Math.max(
    1,
    naturalSamples,
    scrollMinimumJerkBoundSamples(distance),
  )
  let positions = renderScrollPositions(deltaX, deltaY, samples)

  let guard = 0
  while (
    maxConsecutiveScrollStep(positions) > MAX_SCROLL_STEP_PX &&
    guard < MAX_SCROLL_GROWTH_ITERATIONS
  ) {
    samples = Math.ceil(samples * SCROLL_GROWTH_FACTOR) + 1
    positions = renderScrollPositions(deltaX, deltaY, samples)
    guard += 1
  }
  if (maxConsecutiveScrollStep(positions) > MAX_SCROLL_STEP_PX) {
    throw new Error(
      `Unable to keep scroll motion under ${String(MAX_SCROLL_STEP_PX)}px ` +
        `per 60Hz step after ${String(guard)} growth iterations (distance ` +
        `${String(distance)}px, speed ${String(speedPxPerSecond)}px/s)`,
    )
  }
  return positions
}

/** Splits a scroll into eased 60 Hz increments paced against absolute
 * deadlines, exactly like `moveToPoint`'s pointer pacing above. */
async function paceWheel(
  page: RecordPage,
  positions: { x: number; y: number }[],
): Promise<void> {
  const start = Date.now()
  let sentX = 0
  let sentY = 0
  for (const [index, target] of positions.entries()) {
    await sleepUntil(page, start + ((index + 1) / EVENT_LOG_FPS) * 1000)
    await page.mouse.wheel(target.x - sentX, target.y - sentY)
    sentX = target.x
    sentY = target.y
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

/** How far, in px, a grid probe sits inside the visible intersection. */
const EDGE_PROBE_INSET_PX = 4
/**
 * Spacing between deterministic grid probe points, in px — a real, fixed
 * upper bound on the gap between two probes, not an average that degrades
 * as the target grows. Fine enough to guarantee finding a contiguous free
 * region as small as this many px wherever it sits (issue #13): with
 * probes spaced <= a region's own width apart, at least one probe must
 * land inside it, by the pigeonhole principle over the region's span.
 * The previous search was nine fixed points (center, edge midpoints,
 * corners); any free area away from all nine — a band pinched between two
 * overlays at 78% height, say — was reported as full occlusion. A grid
 * whose *step* grew with the target (an average spacing) would only move
 * that failure to bigger targets; the sample count is what scales with
 * target size here, not this step.
 */
const GRID_STEP_PX = 6
/**
 * Safety valve, not a normal-mode limiter: prevents a pathological bbox
 * (e.g. a bug producing an absurd width) from generating an unbounded probe
 * count. A real full-screen hero at typical recording resolutions needs a
 * small fraction of this per axis — see the cost note in README.md.
 */
const GRID_MAX_SAMPLES_PER_AXIS = 500
/** Even a sliver target still gets more than one probe row/column — a free
 * region can be pinched from only one side. */
const GRID_MIN_SAMPLES_PER_AXIS = 3

type IntersectionRect = {
  bottom: number
  left: number
  right: number
  top: number
}

/**
 * Visible intersection of `bbox` with `viewport`. Throws if there is none —
 * a target entirely off-screen needs `demo.scroll`, not a wider point
 * search.
 */
function intersectionRect(
  bbox: BoundingBox,
  viewport: ViewportSize,
): IntersectionRect {
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
  return { left, right, top, bottom }
}

function clampToViewport(
  x: number,
  y: number,
  viewport: ViewportSize,
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(Math.round(x), 0), viewport.width - 1),
    y: Math.min(Math.max(Math.round(y), 0), viewport.height - 1),
  }
}

function gridAxisSamples(lengthPx: number): number {
  const estimated = Math.ceil(lengthPx / GRID_STEP_PX) + 1
  return Math.min(
    Math.max(estimated, GRID_MIN_SAMPLES_PER_AXIS),
    GRID_MAX_SAMPLES_PER_AXIS,
  )
}

function linspace(start: number, end: number, count: number): number[] {
  if (count <= 1) return [(start + end) / 2]
  const step = (end - start) / (count - 1)
  return Array.from({ length: count }, (_unused, index) => start + step * index)
}

type GridPoint = { col: number; row: number; x: number; y: number }

/**
 * A deterministic grid of probe points spanning the visible intersection
 * (inset a few px so a probe doesn't land exactly on a boundary between an
 * overlay and the free area next to it). Row/col indices are what the flood
 * fill in `largestFreeRegionPoint` walks to find a contiguous free region
 * wherever it actually is, instead of assuming it's at an edge or corner.
 */
function candidateGrid(
  rect: IntersectionRect,
  viewport: ViewportSize,
): GridPoint[] {
  const inset = Math.min(
    EDGE_PROBE_INSET_PX,
    (rect.right - rect.left) / 2,
    (rect.bottom - rect.top) / 2,
  )
  const left = rect.left + inset
  const right = rect.right - inset
  const top = rect.top + inset
  const bottom = rect.bottom - inset
  const xs = linspace(left, right, gridAxisSamples(right - left))
  const ys = linspace(top, bottom, gridAxisSamples(bottom - top))

  const points: GridPoint[] = []
  ys.forEach((y, row) => {
    xs.forEach((x, col) => {
      const clamped = clampToViewport(x, y, viewport)
      points.push({ row, col, x: clamped.x, y: clamped.y })
    })
  })
  return points
}

/**
 * Hit-tests an entire probe grid against the live DOM in a single round
 * trip, not one `evaluate()` per point — every probe reads the same DOM
 * snapshot instead of racing a page that could change mid-search (e.g. an
 * overlay finishing its own entrance animation between two sequential
 * probes). No named function in the payload: tsx compiles with esbuild's
 * `keepNames: true`, which would otherwise wrap a named function in an
 * injected `__name(...)` call that doesn't exist once this source text is
 * serialized into the page (see tests/tsx-pipeline.test.ts).
 */
async function hitTestPoints(
  locator: LocatorLike,
  points: { x: number; y: number }[],
): Promise<boolean[]> {
  const result = await locator.evaluate(
    (element, arg) =>
      arg.points.map((point) => {
        const hit = document.elementFromPoint(point.x, point.y)
        return hit !== null && (hit === element || element.contains(hit))
      }),
    { points },
  )
  return result as boolean[]
}

/**
 * Hit-tests a single candidate point against the live DOM: does the element
 * that actually paints at these coordinates right now equal the target or
 * one of its descendants? This — not the geometry alone — is the ground
 * truth for "would a real click here land on the target", and it catches
 * occlusion (something else on top) the same way it catches the target
 * having moved.
 */
async function hitsTarget(
  locator: LocatorLike,
  point: { x: number; y: number },
): Promise<boolean> {
  const [hit] = await hitTestPoints(locator, [point])
  return hit === true
}

/**
 * Finds the largest contiguous (4-connected) region of hit-testable grid
 * cells and returns the point inside it closest to that region's centroid.
 * This is what finds a clickable free area wherever it actually is — a band
 * pinched between two overlays at, say, 70% height, not just a sliver at an
 * edge or corner. The centroid, not the first hit found, is what keeps the
 * chosen point away from the region's own boundary, where an overlay's
 * anti-aliased edge or a one-frame-later reflow is most likely to take it
 * back. Deterministic: for the same grid and the same hit results, the same
 * region and the same point win every time — region size ties keep the
 * first-scanned (row-major) region, and the nearest-to-centroid search runs
 * over that region in a fixed order, so nothing here depends on
 * iteration/timing happenstance.
 */
function largestFreeRegionPoint(
  points: GridPoint[],
  hits: boolean[],
): GridPoint | null {
  const key = (row: number, col: number): string =>
    `${String(row)}:${String(col)}`
  const hitAt = new Map<string, GridPoint>()
  points.forEach((point, index) => {
    if (hits[index] === true) hitAt.set(key(point.row, point.col), point)
  })

  const visited = new Set<string>()
  let bestRegion: GridPoint[] = []
  for (const start of points) {
    const startKey = key(start.row, start.col)
    if (!hitAt.has(startKey) || visited.has(startKey)) continue

    const region: GridPoint[] = []
    const queue: GridPoint[] = [start]
    visited.add(startKey)
    while (queue.length > 0) {
      const current = queue.shift()!
      region.push(current)
      const neighbors: [number, number][] = [
        [current.row - 1, current.col],
        [current.row + 1, current.col],
        [current.row, current.col - 1],
        [current.row, current.col + 1],
      ]
      for (const [row, col] of neighbors) {
        const neighborKey = key(row, col)
        const neighbor = hitAt.get(neighborKey)
        if (neighbor && !visited.has(neighborKey)) {
          visited.add(neighborKey)
          queue.push(neighbor)
        }
      }
    }
    if (region.length > bestRegion.length) bestRegion = region
  }
  if (bestRegion.length === 0) return null

  const centroid = {
    x: bestRegion.reduce((sum, point) => sum + point.x, 0) / bestRegion.length,
    y: bestRegion.reduce((sum, point) => sum + point.y, 0) / bestRegion.length,
  }
  let closest = bestRegion[0]!
  let closestDistance = Infinity
  for (const candidate of bestRegion) {
    const distance = Math.hypot(
      candidate.x - centroid.x,
      candidate.y - centroid.y,
    )
    if (distance < closestDistance) {
      closestDistance = distance
      closest = candidate
    }
  }
  return closest
}

/**
 * `stepPx` set means the grid search actually ran and found nothing — in
 * which case "occluded" is honest only about *every probed point*, not
 * about the whole target: a free region narrower than the probe step would
 * look identical. The old message claimed full occlusion in both cases,
 * which sent a script author looking for an overlay that wasn't there.
 * `stepPx` unset means occlusion at the center with no viewport available
 * to search further.
 */
function occlusionError(bbox: BoundingBox, stepPx?: number): Error {
  const detail =
    stepPx === undefined
      ? 'is occluded at its center and no viewport is available to search further'
      : `is occluded at every probe point spaced ${String(stepPx)}px apart — ` +
        'either every point on it is covered by something else (an ' +
        'overlay, a sticky header), or the only free area left is ' +
        `narrower than the ${String(stepPx)}px probe step`
  return new Error(
    `Target bounding box (${String(bbox.x)}, ${String(bbox.y)}, ` +
      `${String(bbox.width)}x${String(bbox.height)}) ${detail}. Never ` +
      'logging an unverified interaction.',
  )
}

/**
 * Resolves a verified, hit-testable interaction point for `bbox`. Tries the
 * center of the visible intersection first — the common, unoccluded case,
 * and cheap (one hit test). Only when that's covered does it fall back to a
 * deterministic grid search for the largest contiguous free region,
 * wherever it is (issue #13). Throws if the target is occluded at every
 * probe — a script author needs to know their interaction was never sent,
 * not get a silent miss.
 */
async function findVerifiedInteractionPoint(
  locator: LocatorLike,
  bbox: BoundingBox,
  viewport: ViewportSize | null,
): Promise<{ x: number; y: number }> {
  if (viewport === null) {
    const center = {
      x: Math.round(bbox.x + bbox.width / 2),
      y: Math.round(bbox.y + bbox.height / 2),
    }
    if (await hitsTarget(locator, center)) return center
    throw occlusionError(bbox)
  }

  const rect = intersectionRect(bbox, viewport)
  const center = clampToViewport(
    (rect.left + rect.right) / 2,
    (rect.top + rect.bottom) / 2,
    viewport,
  )
  if (await hitsTarget(locator, center)) return center

  const grid = candidateGrid(rect, viewport)
  const hits = await hitTestPoints(locator, grid)
  const point = largestFreeRegionPoint(grid, hits)
  if (point === null) throw occlusionError(bbox, GRID_STEP_PX)
  return { x: point.x, y: point.y }
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
