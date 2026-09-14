import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  launchChromium,
  resolveBrowserRequest,
  writeBrowserProvenance,
} from './browser.js'
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
        deadlineAt: number,
        knownPeriodMs: number | null = null,
      ): Promise<{
        bbox: BoundingBox
        periodMs: number | null
        point: { x: number; y: number }
      }> => {
        const settled = await resolveSettledGeometry(
          locator,
          deadlineAt,
          settleTimeoutMs,
          knownPeriodMs,
        )
        // The settled centre is the resting box's own centre, already
        // pulled inside the region the target covered at every animation
        // phase — so it is the right thing to try first, and for an
        // unoccluded target it is the only hit test this costs. The
        // fallback search only runs when something is actually on top of
        // it, and it is given the resting box, not a live read.
        const viewport = page.viewportSize()
        const centreIsOnScreen =
          viewport === null ||
          (settled.center.x >= 0 &&
            settled.center.x < viewport.width &&
            settled.center.y >= 0 &&
            settled.center.y < viewport.height)
        if (centreIsOnScreen && (await hitsTarget(locator, settled.center))) {
          return {
            bbox: settled.bbox,
            periodMs: settled.periodMs,
            point: settled.center,
          }
        }
        const point = await findVerifiedInteractionPoint(
          locator,
          settled.bbox,
          viewport,
        )
        return { bbox: settled.bbox, periodMs: settled.periodMs, point }
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
        // `tick` is the scheduled 60Hz slot index: every generated sample —
        // including one that rounds to the same pixel as its predecessor
        // (the pointer briefly "held") — consumes and logs its own slot, so
        // tick stays a uniform timebase issue #9 can map onto the capture
        // clock 1:1.
        await paceOnTicks(page, points.length, (index) => {
          const next = points[index] as { x: number; y: number }
          pointer = next
          events.push({ type: 'pointer', tick, x: next.x, y: next.y })
          tick += 1
          return page.mouse.move(next.x, next.y, { steps: 1 })
        })
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
        // One budget for the whole interaction, not one per settle call.
        // A `moveTo` runs up to two settles (before travel, and again if
        // the target moved out from under the pointer during it); giving
        // each its own `settleTimeoutMs` meant a single interaction could
        // legitimately burn twice the budget the option advertises —
        // measured at 125s against a 60s setting.
        const deadlineAt = Date.now() + settleTimeoutMs
        const before = await resolveVerifiedTarget(locator, deadlineAt)
        const initialPoint = before.point
        await moveToPoint(
          initialPoint,
          deriveMotionSeed(seed, thisInteraction, PRIMARY_MOVE_ROLE),
        )

        // The travel above can take 0.4-4s (longer for distant targets).
        // Trusting geometry resolved *before* it is exactly how a click
        // gets logged for something that never happened: the target can
        // move, get re-rendered, grow around a stable centre, or end up
        // covered by something else while the cursor is still travelling.
        // So the geometry is resolved again, unconditionally, now that
        // we've arrived — and it is this second result that gets logged,
        // because a renderer will zoom exactly this box.
        //
        // Resolving again is safe in a way it was not before. Two settles
        // of a permanently animating target used to disagree by about a
        // pixel, because each averaged over whatever window it happened to
        // catch; that noise is why a 4px "the pointer is close enough
        // already" tolerance had to exist, to stop one process taking a
        // corrective hop the other didn't. Both settles now integrate over
        // the same whole number of the animation's own periods, so they
        // agree by construction rather than by tolerance.
        const arrived = await resolveVerifiedTarget(
          locator,
          deadlineAt,
          before.periodMs,
        )

        // Whether to spend a second visible pointer curve is decided by a
        // hit test, not by comparing two coordinates against a threshold.
        // "Would a click where the pointer physically is right now land on
        // the target" is a discrete question that a pixel of measurement
        // noise cannot flip, which is what makes the tolerance constant
        // unnecessary rather than merely smaller.
        let point = initialPoint
        if (!(await hitsTarget(locator, initialPoint))) {
          await moveToPoint(
            arrived.point,
            deriveMotionSeed(seed, thisInteraction, CORRECTIVE_MOVE_ROLE),
          )
          if (!(await hitsTarget(locator, arrived.point))) {
            throw new Error(
              'Target moved during pointer travel and could not be ' +
                'reliably hit even after re-resolving and correcting the ' +
                'approach. Never logging an unverified interaction.',
            )
          }
          point = arrived.point
        }

        // Never a live single read: for an animating target that returns
        // whatever phase this one round trip caught, which is both the
        // wrong box (not the resting geometry a zoom should frame) and a
        // different one in every process.
        return { bbox: arrived.bbox, ...point }
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
          // Dispatching the last wheel event is not the same as the page
          // having arrived: Chromium animates the scroll and keeps painting
          // after the input stops. Waiting for that tail here is what makes
          // the caller's motion window describe the motion instead of the
          // typing (#40).
          const restMs = await waitForScrollRest(page)
          // Same bookkeeping as hold(): the tick axis tracks wall clock, so
          // waited time has to advance it or every later event drifts.
          tick += positions.length + Math.ceil((restMs / 1000) * EVENT_LOG_FPS)
          // scroll() itself doesn't know which element will be interacted
          // with next (it takes no target), so it can't settle on the
          // geometry that actually matters. resolveTarget() — called by the
          // next point/click/tap/type — is what waits for stable geometry,
          // covering any scroll mechanism (window, inner container,
          // JS-driven transform), not just this dispatch.
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
    const { devices } = await import('playwright')
    const { browser, provenance } = await launchChromium(
      { headless: true },
      resolveBrowserRequest(process.env),
    )
    try {
      await mkdir(options.out, { recursive: true })
      await writeBrowserProvenance(options.out, provenance)
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

/**
 * Waits until the page has stopped scrolling, and answers how long that
 * took in milliseconds.
 *
 * Why this exists: a scroll's motion window used to end when the last wheel
 * event was acknowledged. Since the input holds its 60 Hz tick (#25) the
 * dispatch finishes before Chromium's scroll animation does, so the window
 * ended mid-motion — measured on the box, the horizontal scrolls travelled
 * 131-169 px of 172.5 px inside their own window while the finished video
 * showed the full 171.8 px just outside it (#40).
 *
 * Observed by listening, not by polling: a poll would have to read every
 * scrollable element's offset on every sample, which is main-thread work
 * during a capture, and the capture is the thing being measured. `scroll`
 * events fire per frame while anything on the page scrolls, in the capture
 * phase for every element, so their absence is the arrival signal.
 *
 * Both numbers below are inlined in page context on purpose: `evaluate`
 * takes no arguments here. 50 ms is three frames at 60 Hz — long enough
 * that a frame Chromium skipped under load does not read as arrival. The
 * 1000 ms cap bounds a page that scrolls forever (a marquee, an infinite
 * loader); reaching it is not an error, it is the point at which waiting
 * longer stops being about this scroll.
 */
async function waitForScrollRest(page: RecordPage): Promise<number> {
  return page.evaluate<number>(
    () =>
      new Promise<number>((resolve) => {
        const started = performance.now()
        const stop = new AbortController()
        let lastScrollAt = performance.now()
        document.addEventListener(
          'scroll',
          // Anonymous on purpose, here and below: `tsx` compiles with
          // esbuild's `keepNames`, which wraps every *named* function in
          // this payload in an `__name(...)` call that does not exist in
          // page context (`tests/tsx-pipeline.test.ts`, #42).
          function () {
            lastScrollAt = performance.now()
          },
          { capture: true, signal: stop.signal },
        )
        const timer = setInterval(function () {
          const now = performance.now()
          if (now - lastScrollAt >= 50 || now - started >= 1000) {
            clearInterval(timer)
            stop.abort()
            resolve(now - started)
          }
        }, 16)
      }),
  )
}

/** Splits a scroll into eased 60 Hz increments paced against absolute
 * deadlines, exactly like `moveToPoint`'s pointer pacing above. */
async function paceWheel(
  page: RecordPage,
  positions: { x: number; y: number }[],
): Promise<void> {
  let sentX = 0
  let sentY = 0
  await paceOnTicks(page, positions.length, (index) => {
    const target = positions[index] as { x: number; y: number }
    const delta = { x: target.x - sentX, y: target.y - sentY }
    sentX = target.x
    sentY = target.y
    return page.mouse.wheel(delta.x, delta.y)
  })
}

/**
 * Dispatches one input event per 60 Hz slot, on absolute deadlines
 * (start + (i+1)/fps), without letting a slot wait for the previous event's
 * acknowledgement.
 *
 * Why not simply `await` each dispatch: Chromium acknowledges an input event
 * only once it has been processed, which is tied to the next frame. Measured
 * on the patched build (#25): 16.5–17.8 ms per wheel step against a 16.67 ms
 * slot. With absolute deadlines a loop that awaits the acknowledgement can
 * never catch up, only fall further behind — input drifts against the frame
 * cadence, and the finished video shows held frames followed by a catch-up
 * step.
 *
 * Order is preserved: every dispatch is issued in slot order on the same CDP
 * session, which delivers messages in order. All acknowledgements are
 * awaited before this returns, so the motion has fully arrived. A failed
 * dispatch stops further dispatches at the next slot and is rethrown; it is
 * caught at once so it can never surface as an unhandled rejection while
 * later slots are still being paced.
 */
async function paceOnTicks(
  page: RecordPage,
  slotCount: number,
  dispatch: (index: number) => Promise<void>,
): Promise<void> {
  const start = Date.now()
  const acknowledgements: Promise<void>[] = []
  const state: { failure?: { error: unknown } } = {}
  for (let index = 0; index < slotCount; index += 1) {
    await sleepUntil(page, start + ((index + 1) / EVENT_LOG_FPS) * 1000)
    if (state.failure) break
    acknowledgements.push(
      dispatch(index).catch((error: unknown) => {
        state.failure ??= { error }
      }),
    )
  }
  await Promise.all(acknowledgements)
  if (state.failure) throw state.failure.error
}

/** Waits until an absolute deadline instead of sleeping a fixed duration. */
async function sleepUntil(page: RecordPage, deadline: number): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining > 0) await page.waitForTimeout(remaining)
}

/**
 * One observation chunk. Deliberately short and *fixed*: the settle loop
 * waits for an animation to end by taking chunk after chunk, so a finite
 * animation of duration D costs about D plus one chunk — not a multiple of
 * D, which is what a window that grows toward the remaining budget costs.
 */
const STABLE_WINDOW_MS = 80
/**
 * Below this, two derived edge values count as "the same". Used only where
 * a real tolerance is unavoidable (period verification, drift detection);
 * the "is this target still?" test itself needs no epsilon at all — see
 * `isExactlyStill`.
 */
const STABLE_EPSILON_PX = 0.5
/** Every observation returns at least this many frames, however loaded the
 * machine is, so a chunk starved down to one frame can never be mistaken
 * for a still target. */
const MIN_FRAMES_PER_OBSERVATION = 3
/**
 * How long the dwell measurement integrates over, before being rounded up
 * to a whole number of the animation's own periods. A pure constant on
 * purpose: the measurement window must be a function of the *animation*
 * (its period) and nothing else. Anything derived from elapsed time, the
 * remaining budget, or how many chunks happened to pass first makes the
 * logged geometry a function of machine load, which is exactly the defect
 * this criterion exists to remove. ~480ms is 29 frames at 60Hz — enough
 * resolution for the dwell histogram below to separate a plateau from a
 * sweep.
 */
const MIN_MEASUREMENT_MS = 480
/** Periods longer than this are not worth integrating over: two of them
 * already exceed any sane `settleTimeoutMs`, and an "animation" that slow
 * is a page state change, not a loop. */
const MAX_PERIOD_MS = 4000
/** Shortest period worth considering — below one rendering frame there is
 * nothing to sample. */
const MIN_PERIOD_MS = 32
/** How often the settle loop re-attempts period resolution while it waits.
 * Failing to find a period is cheap; finding one ends the wait. */
const PERIOD_RETRY_INTERVAL_MS = 1000
/** Window used to estimate a period geometrically when the Web Animations
 * API has no usable answer. Long enough to contain two full cycles of
 * anything up to `MAX_PERIOD_MS / 2`. */
const PERIOD_ESTIMATE_WINDOW_MS = 2 * MAX_PERIOD_MS
/**
 * The dwell histogram picks a single "most-dwelt" box only when that box
 * is dwelt on clearly longer than any other. 1.5 is not a tuned tolerance,
 * it separates two structurally different shapes: an animation with a rest
 * phase (a plateau visited for a large fraction of every cycle — ratios of
 * 5-30 in practice) from one that sweeps continuously (every box visited
 * about equally, ratio ~1; a symmetric ease-in-out's turning points reach
 * exactly 2, since the resting end is passed twice per cycle and the far
 * end once). Below the threshold there is no resting box to report and the
 * period-aligned time average is the honest answer.
 */
const DWELL_DOMINANCE_RATIO = 1.5
/**
 * Derived edge values are snapped to this grid before being rounded to the
 * integers the log uses. Without it, an animation whose true time-average
 * sits exactly on a half pixel — which symmetric animations routinely do,
 * e.g. a 15px bounce around y=300 averaging to 307.5 — would round up in
 * one process and down in another on a residual of hundredths of a pixel.
 * Snapping first makes the value handed to `Math.round` an exact multiple
 * of the grid, so the rounding is decided by arithmetic rather than by
 * which frames a process happened to catch. 0.5px absorbs ~0.25px of
 * residual, against a measured residual an order of magnitude smaller.
 */
const EDGE_SNAP_PX = 0.5

/** One sampled rendering frame: the target's four edges at a page-clock
 * timestamp, relative to the start of its observation. */
type Frame = {
  bottom: number
  left: number
  right: number
  t: number
  top: number
}

type SettledGeometry = {
  /** The target's resting geometry: the box it dwells in, if it has one,
   * else its period-aligned time average. */
  bbox: BoundingBox
  /**
   * Where to interact. The resting box's own centre, pulled inside the
   * region that was covered by the target at *every* sampled phase, so a
   * click landing at any moment of the animation still hits.
   */
  center: { x: number; y: number }
  /**
   * The verified period the geometry was integrated over, or `null` for a
   * target that was simply still. Handed back to the caller so the second
   * settle of the same interaction does not have to re-verify a period it
   * already established — re-probing two full periods of the same
   * animation on the same element is pure waste, and for a long period it
   * is waste the interaction's budget cannot afford.
   */
  periodMs: number | null
}

/**
 * Samples the target's geometry inside the page, one `requestAnimationFrame`
 * tick at a time, for `windowMs` — in a single round trip.
 *
 * Sampling has to happen in the page and it has to be driven by rAF. A
 * Node-side poll of `boundingBox()` samples at whatever cadence the event
 * loop and the CDP connection allow, which varies per process and per
 * machine load. A tight synchronous loop over `getBoundingClientRect()`
 * inside one script execution is worse than imprecise, it is wrong: a
 * browser recomputes a CSS animation's current value once per
 * rendering-lifecycle tick, not per layout query, so every read in one
 * execution returns the same frozen value. Only an rAF callback
 * corresponds to a genuinely new rendering tick.
 *
 * No named function in the payload: tsx compiles with esbuild's
 * `keepNames: true`, which wraps a named function in an injected
 * `__name(...)` call that does not exist once this source text is
 * serialized into the page (see tests/tsx-pipeline.test.ts). Assigning to
 * a property of an already-created object is the one form the
 * named-function-expression inference rule does not cover.
 */
async function observeFrames(
  locator: LocatorLike,
  windowMs: number,
): Promise<Frame[]> {
  const frames = await locator.evaluate(
    (element, arg: { minFrames: number; windowMs: number }) =>
      new Promise((resolve, reject) => {
        const collected: {
          bottom: number
          left: number
          right: number
          t: number
          top: number
        }[] = []
        const start = performance.now()
        const loop = {} as { tick: () => void }
        loop.tick = () => {
          const rect = element.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) {
            reject(new Error('Target must resolve to a visible bounding box'))
            return
          }
          const elapsed = performance.now() - start
          collected.push({
            t: elapsed,
            left: rect.left,
            top: rect.top,
            right: rect.left + rect.width,
            bottom: rect.top + rect.height,
          })
          if (elapsed < arg.windowMs || collected.length < arg.minFrames) {
            requestAnimationFrame(loop.tick)
          } else {
            resolve(collected)
          }
        }
        requestAnimationFrame(loop.tick)
      }),
    {
      windowMs: Math.max(windowMs, 1),
      minFrames: MIN_FRAMES_PER_OBSERVATION,
    },
  )
  return frames as Frame[]
}

const EDGES = ['left', 'top', 'right', 'bottom'] as const

/**
 * Whether every sampled frame reported *bitwise identical* edges. No
 * epsilon, deliberately: `getBoundingClientRect()` returns sub-pixel
 * floats, so a target still moving at any rate the browser can represent
 * reports different numbers frame to frame, while a target whose layout is
 * finished reports the same number forever. An epsilon here is what let
 * "however slow the drift" quietly become false — a 0.05px-per-frame
 * widening stayed inside any sub-pixel tolerance and was declared settled
 * mid-growth. Exact equality has no such floor: the limit becomes the
 * browser's own sub-pixel quantisation (Chromium: 1/64px) over the
 * observation window, i.e. about 0.2px/s for an 80ms window, rather than a
 * tolerance chosen by hand.
 */
function isExactlyStill(frames: Frame[]): boolean {
  if (frames.length < MIN_FRAMES_PER_OBSERVATION) return false
  const first = frames[0]!
  return frames.every((frame) =>
    EDGES.every((edge) => frame[edge] === first[edge]),
  )
}

/**
 * How far the second half of an observation sits from the first half, per
 * edge. Scale-free by construction: a linear drift of any rate shows up
 * here as rate x span / 2, so a longer observation exposes a slower drift,
 * rather than a fixed tolerance deciding which rates are invisible. Used
 * to tell a *bounded* animation (halves agree — it comes back to where it
 * was) from one that is also travelling somewhere (halves diverge), which
 * must never be reported as settled just because it repeats.
 */
function halvesDriftPx(frames: Frame[]): number {
  if (frames.length < 4) return Infinity
  const middle = Math.floor(frames.length / 2)
  const first = frames.slice(0, middle)
  const second = frames.slice(middle)
  const meanOf = (subset: Frame[], edge: (typeof EDGES)[number]): number =>
    subset.reduce((sum, frame) => sum + frame[edge], 0) / subset.length
  return Math.max(
    ...EDGES.map((edge) =>
      Math.abs(meanOf(second, edge) - meanOf(first, edge)),
    ),
  )
}

/**
 * Time average of each edge over exactly `spanMs` starting at `startT`.
 * Every frame is weighted by the time until the next one, and the last one
 * only by the time left inside the span — so this is a genuine integral
 * over the span, not an average over however many frames the machine
 * managed to render inside it. Under load, where rAF drops from 60Hz to a
 * handful of frames, that is the difference between an answer that stays
 * put and one that follows the load. `null` when the observation does not
 * cover the span.
 */
function weightedEdgeMeans(
  frames: Frame[],
  startT: number,
  spanMs: number,
): Record<string, number> | null {
  const endT = startT + spanMs
  if (frames.length === 0 || frames[frames.length - 1]!.t < endT) {
    // The frame that would close the span is the one excluded from the
    // integral, so the observation must reach at least that far.
    if (frames.length === 0 || frames[frames.length - 1]!.t < startT)
      return null
  }
  const inSpan = frames.filter((frame) => frame.t >= startT && frame.t < endT)
  if (inSpan.length === 0) return null
  const totals: Record<string, number> = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  }
  let totalWeight = 0
  inSpan.forEach((frame, index) => {
    const next = index + 1 < inSpan.length ? inSpan[index + 1]!.t : endT
    const weight = Math.max(next - frame.t, 0)
    totalWeight += weight
    for (const edge of EDGES) totals[edge]! += frame[edge] * weight
  })
  if (totalWeight <= 0) return null
  for (const edge of EDGES) totals[edge]! /= totalWeight
  return totals
}

/**
 * How far the time average of one period sits from the next one's. Zero
 * for a genuinely looping animation however violent its motion; non-zero,
 * and growing with the period, for one that is also travelling somewhere.
 */
function consecutivePeriodDriftPx(frames: Frame[], periodMs: number): number {
  const start = frames[0]!.t
  const first = weightedEdgeMeans(frames, start, periodMs)
  const second = weightedEdgeMeans(frames, start + periodMs, periodMs)
  if (first === null || second === null) return Infinity
  return Math.max(
    ...EDGES.map((edge) => Math.abs(second[edge]! - first[edge]!)),
  )
}

/** Snaps to `EDGE_SNAP_PX` and then to the integers the log uses. */
function snappedRound(value: number): number {
  return Math.round(Math.round(value / EDGE_SNAP_PX) * EDGE_SNAP_PX)
}

function boxFromEdges(
  left: number,
  top: number,
  right: number,
  bottom: number,
): BoundingBox {
  const x = snappedRound(left)
  const y = snappedRound(top)
  return {
    x,
    y,
    width: snappedRound(right) - x,
    height: snappedRound(bottom) - y,
  }
}

/**
 * Integrates an observation over exactly `spanMs` starting at its first
 * frame, and returns the target's resting geometry.
 *
 * Every frame is weighted by the time until the next one, and the last
 * included frame only by the time left inside the span — so the result is
 * a genuine time average over the span, not an average over however many
 * frames the machine managed to render. Under load, where rAF drops from
 * 60Hz to a handful of frames, that is the difference between a stable
 * answer and one that follows the load. The span is a whole number of the
 * animation's periods, so no partial cycle biases the average, and the
 * trailing frame that would reach past it is excluded rather than counted
 * whole.
 *
 * The reported box is the *most-dwelt* quantised box when one dominates —
 * "resting geometry" for an animation with a rest phase means the box it
 * actually sits in, not the average of where it sits and where it briefly
 * jumps to. A 70%-dwell/30%-peak animation whose mean is reported logs a
 * box the element never occupies, and M4 would frame that. When no box
 * dominates (a continuous sweep with no rest), the period-aligned time
 * average is the answer instead.
 */
function restingGeometryOver(
  frames: Frame[],
  spanMs: number,
  periodMs: number,
): SettledGeometry {
  const start = frames[0]!.t
  const inSpan = frames.filter((frame) => frame.t - start < spanMs)
  const weights = inSpan.map((frame, index) => {
    const next =
      index + 1 < inSpan.length ? inSpan[index + 1]!.t : start + spanMs
    return Math.max(next - frame.t, 0)
  })
  const means = weightedEdgeMeans(frames, start, spanMs)!
  const meanBox = boxFromEdges(
    means.left!,
    means.top!,
    means.right!,
    means.bottom!,
  )

  const dwell = new Map<string, { box: BoundingBox; ms: number }>()
  inSpan.forEach((frame, index) => {
    const box = boxFromEdges(frame.left, frame.top, frame.right, frame.bottom)
    const id = `${String(box.x)},${String(box.y)},${String(box.width)},${String(box.height)}`
    const entry = dwell.get(id)
    if (entry === undefined) dwell.set(id, { box, ms: weights[index]! })
    else entry.ms += weights[index]!
  })
  const ranked = [...dwell.values()].sort((a, b) => b.ms - a.ms)
  const best = ranked[0]
  const runnerUp = ranked[1]
  const bbox =
    best !== undefined &&
    (runnerUp === undefined || best.ms > runnerUp.ms * DWELL_DOMINANCE_RATIO)
      ? best.box
      : meanBox

  // The region covered by the target at every sampled phase. Its edges are
  // the animation's own extremes, each of which a process can only ever
  // observe to within one rendering frame — so the intersection's *centre*
  // is not something two processes can agree on to the pixel, and using it
  // directly is what left a 1px cross-process difference in the click
  // point. The resting box's centre is a time average and does agree; it
  // is clamped into the always-covered region for the rare target that
  // travels further than its own size, where the resting centre could sit
  // outside.
  const extremes = {
    left: Math.max(...inSpan.map((frame) => frame.left)),
    top: Math.max(...inSpan.map((frame) => frame.top)),
    right: Math.min(...inSpan.map((frame) => frame.right)),
    bottom: Math.min(...inSpan.map((frame) => frame.bottom)),
  }
  const restingCenter = {
    x: bbox.x + bbox.width / 2,
    y: bbox.y + bbox.height / 2,
  }
  const center =
    extremes.right > extremes.left && extremes.bottom > extremes.top
      ? {
          x: Math.round(
            Math.min(Math.max(restingCenter.x, extremes.left), extremes.right),
          ),
          y: Math.round(
            Math.min(Math.max(restingCenter.y, extremes.top), extremes.bottom),
          ),
        }
      : { x: Math.round(restingCenter.x), y: Math.round(restingCenter.y) }

  return { bbox, center, periodMs }
}

/** The degenerate case of `restingGeometryOver`: a target that did not
 * move at all during its observation has one box and is its own average. */
function stillGeometry(frames: Frame[]): SettledGeometry {
  const frame = frames[0]!
  const bbox = boxFromEdges(frame.left, frame.top, frame.right, frame.bottom)
  return {
    bbox,
    center: {
      x: Math.round(bbox.x + bbox.width / 2),
      y: Math.round(bbox.y + bbox.height / 2),
    },
    periodMs: null,
  }
}

/**
 * Every candidate period the Web Animations API can offer for this target,
 * read and never set — pure introspection, not "disabling the animation".
 *
 * Three things the previous version missed, each measured: an animation on
 * an *ancestor* moves the target without appearing in the target's own
 * `getAnimations()`, so the whole parent chain is walked; an alternating
 * animation's geometric period is twice its iteration duration, because
 * the iteration only covers one direction of the ping-pong; and two
 * animations of different durations have a common period (their least
 * common multiple), not "no answer". Every candidate returned here is
 * still *verified* against the sampled geometry before being used — the
 * API says what the page declared, the samples say what the box actually
 * does, and only the second is what the logged geometry may depend on.
 */
async function candidatePeriodsMs(locator: LocatorLike): Promise<number[]> {
  const declared = (await locator.evaluate((element) => {
    const nodes: Element[] = []
    let current: Element | null = element
    while (current !== null) {
      nodes.push(current)
      current = current.parentElement
    }
    const durations: number[] = []
    for (const node of nodes) {
      const animations =
        node === element
          ? node.getAnimations({ subtree: true })
          : node.getAnimations()
      for (const animation of animations) {
        const effect = animation.effect
        if (effect === null) continue
        const duration = effect.getComputedTiming().duration
        if (typeof duration !== 'number' || duration <= 0) continue
        const direction = effect.getTiming().direction
        const alternating =
          direction === 'alternate' || direction === 'alternate-reverse'
        durations.push(alternating ? duration * 2 : duration)
      }
    }
    return durations
  }, undefined)) as number[]

  const rounded = declared
    .map((duration) => Math.round(duration))
    .filter((duration) => duration >= MIN_PERIOD_MS)
  const candidates = new Set<number>(rounded)
  // A composite of several animations repeats on their least common
  // multiple, which is the only window that covers all of them a whole
  // number of times.
  for (const a of rounded) {
    for (const b of rounded) {
      const common = leastCommonMultiple(a, b)
      if (common !== null) candidates.add(common)
    }
  }
  return [...candidates]
    .filter((period) => period >= MIN_PERIOD_MS && period <= MAX_PERIOD_MS)
    .sort((a, b) => a - b)
}

function leastCommonMultiple(a: number, b: number): number | null {
  let x = a
  let y = b
  while (y !== 0) {
    const remainder = x % y
    x = y
    y = remainder
  }
  if (x === 0) return null
  const multiple = (a / x) * b
  return Number.isFinite(multiple) ? multiple : null
}

/** Peak-to-peak travel of the widest-moving edge across an observation. */
function amplitudePx(frames: Frame[]): number {
  return Math.max(
    ...EDGES.map(
      (edge) =>
        Math.max(...frames.map((frame) => frame[edge])) -
        Math.min(...frames.map((frame) => frame[edge])),
    ),
  )
}

/**
 * The target's edges at an arbitrary instant, linearly interpolated
 * between the two frames that bracket it. Rendering frames one period
 * apart are essentially never *aligned* — a 240ms period at a 60Hz refresh
 * is 14.4 frames — so comparing a frame against the nearest frame one
 * period later compares two different phases, and for a fast animation
 * those differ by pixels. Interpolating removes that misalignment, leaving
 * only the curvature error over one frame interval.
 */
function edgesAt(frames: Frame[], t: number): Record<string, number> | null {
  if (t < frames[0]!.t || t > frames[frames.length - 1]!.t) return null
  let index = 0
  while (index + 1 < frames.length && frames[index + 1]!.t < t) index += 1
  const before = frames[index]!
  const after = frames[Math.min(index + 1, frames.length - 1)]!
  const span = after.t - before.t
  const ratio = span > 0 ? (t - before.t) / span : 0
  const interpolated: Record<string, number> = {}
  for (const edge of EDGES) {
    interpolated[edge] = before[edge] + (after[edge] - before[edge]) * ratio
  }
  return interpolated
}

/**
 * Whether the sampled geometry actually repeats with period `periodMs`:
 * every frame must match the (interpolated) geometry one period later.
 * This is what makes a *declared* period safe to use, and what makes a
 * wrong one — an ancestor's unrelated animation, an iteration duration
 * that is half the geometric period of an alternating one — fail here
 * instead of silently biasing the average. Needs the observation to span
 * at least two periods.
 *
 * The tolerance is relative to the motion's own amplitude, not a flat
 * sub-pixel epsilon, because linear interpolation across one rendering
 * interval carries a curvature error that scales with amplitude: a 40px
 * swing over 240ms is off by ~0.9px between two 16ms frames however
 * correct the period is. A *wrong* period mismatches by a large fraction
 * of the amplitude, so 5% of it separates the two cleanly while a flat
 * 0.5px would reject every fast animation.
 */
const PERIOD_MATCH_AMPLITUDE_FRACTION = 0.05

function periodHolds(frames: Frame[], periodMs: number): boolean {
  const span = frames[frames.length - 1]!.t - frames[0]!.t
  if (span < periodMs * 2) return false
  const tolerance = Math.max(
    STABLE_EPSILON_PX,
    amplitudePx(frames) * PERIOD_MATCH_AMPLITUDE_FRACTION,
  )
  let compared = 0
  for (const frame of frames) {
    const later = edgesAt(frames, frame.t + periodMs)
    if (later === null) break
    compared += 1
    for (const edge of EDGES) {
      if (Math.abs(later[edge]! - frame[edge]) > tolerance) return false
    }
  }
  return compared >= MIN_FRAMES_PER_OBSERVATION
}

/**
 * Estimates a period straight from the sampled geometry, for the case the
 * Web Animations API cannot answer: a JS-driven `requestAnimationFrame`
 * loop, a `<canvas>`-backed layout, a transition whose declared timing
 * does not match what the box does. Scans lags at one-frame resolution and
 * returns the shortest that holds; `null` when none does.
 */
function estimatePeriodMs(frames: Frame[]): number | null {
  const span = frames[frames.length - 1]!.t - frames[0]!.t
  const longest = Math.min(MAX_PERIOD_MS, span / 2)
  for (let lag = MIN_PERIOD_MS; lag <= longest; lag += 8) {
    if (periodHolds(frames, lag)) return lag
  }
  return null
}

/**
 * The number of whole periods the dwell measurement covers. A pure
 * function of the period — never of elapsed time, the remaining budget or
 * how long the settle loop waited first. That is the whole point: the
 * logged geometry must be a property of the animation, not of the machine
 * that recorded it.
 */
function measurementPeriods(periodMs: number): number {
  return Math.max(1, Math.ceil(MIN_MEASUREMENT_MS / periodMs))
}

function settleTimeoutError(timeoutMs: number, detail: string): Error {
  return new Error(
    `Target geometry did not settle within settleTimeoutMs (${String(timeoutMs)}ms): ` +
      `${detail}. Increase RecordOptions.settleTimeoutMs if the page keeps ` +
      'animating intentionally.',
  )
}

/**
 * Resolves a target's resting geometry and a safe interaction point for it.
 *
 * Three cases, in the order they are cheapest to recognise:
 *
 * 1. **Still.** One 80ms observation in which every frame reports the same
 *    edges, to the last sub-pixel. Returns immediately — the common case
 *    costs one round trip, the same as a single `boundingBox()` read plus
 *    a stability window.
 * 2. **Finite animation.** Keeps taking 80ms observations until one is
 *    still. An animation of duration D therefore settles in about D, not a
 *    multiple of D, and the box logged afterwards is the element's actual
 *    resting layout — nothing is averaged, because nothing is moving any
 *    more.
 * 3. **Permanent bounded animation.** A pulsing CTA, a bounce, a spin: it
 *    never stops, so waiting for stillness would time out (which is the
 *    bug this replaces). Instead its period is resolved and verified
 *    against the samples, and its geometry is integrated over a whole
 *    number of those periods. Both the period and the number of periods
 *    are properties of the animation alone, so two processes integrate
 *    over identical windows however differently they were scheduled.
 *
 * Anything that keeps moving without repeating — a layout shift, a panel
 * sliding in, a button widening 0.05px per frame — matches none of the
 * three and is correctly waited for until it stops or the budget runs out.
 */
async function resolveSettledGeometry(
  locator: LocatorLike,
  deadlineAt: number,
  timeoutMs: number,
  knownPeriodMs: number | null = null,
): Promise<SettledGeometry> {
  // A visibility check before any observation, so an absent or collapsed
  // target fails with the same message it always has.
  await readValidatedBoundingBox(locator)

  let lastObservation: Frame[] = []
  let nextPeriodAttemptAt = 0
  for (;;) {
    const frames = await observeFrames(locator, STABLE_WINDOW_MS)
    lastObservation = frames
    if (isExactlyStill(frames)) return stillGeometry(frames)

    if (Date.now() >= nextPeriodAttemptAt) {
      nextPeriodAttemptAt = Date.now() + PERIOD_RETRY_INTERVAL_MS
      const settled = await tryPeriodicMeasurement(
        locator,
        deadlineAt,
        knownPeriodMs,
      )
      if (settled !== null) return settled
    }

    if (Date.now() >= deadlineAt) {
      throw settleTimeoutError(
        timeoutMs,
        halvesDriftPx(lastObservation) < STABLE_EPSILON_PX
          ? 'the target keeps moving within a bounded range but no repeating ' +
              'period could be measured, so there is no window whose average ' +
              'would be reproducible'
          : 'the target is still moving to a new position',
      )
    }
  }
}

/**
 * Resolves and verifies a period for the target, then measures over a
 * whole number of them. `null` when no period holds, or when a verified
 * one would not fit in the remaining budget — in which case the caller
 * goes back to waiting for the animation to end, which is the right
 * behaviour for a finite one (a 3s pop-in declares a 3s duration; two of
 * those do not fit an ordinary budget, and it does not need them — it ends).
 */
async function tryPeriodicMeasurement(
  locator: LocatorLike,
  deadlineAt: number,
  knownPeriodMs: number | null,
): Promise<SettledGeometry | null> {
  const fits = (windowMs: number): boolean =>
    Date.now() + windowMs <= deadlineAt

  const candidates = await candidatePeriodsMs(locator)

  // A period established earlier in this same interaction, still declared
  // by the page, needs no second two-period verification pass: the check
  // that matters — does the geometry actually repeat on it — was already
  // made against this element, and the page still says the same thing.
  if (knownPeriodMs !== null && candidates.includes(knownPeriodMs)) {
    if (
      fits(knownPeriodMs * measurementPeriods(knownPeriodMs) + STABLE_WINDOW_MS)
    ) {
      return measureOverPeriods(locator, knownPeriodMs)
    }
  }

  for (const periodMs of candidates) {
    // Two whole periods *plus a margin*: an observation asked for exactly
    // 2P ends on the first frame at or past 2P, so its first-to-last span
    // is 2P minus one frame interval — just short of what `periodHolds`
    // needs, which made period verification fail or succeed depending on
    // where the first frame happened to land.
    const probeMs = periodMs * 2 + STABLE_WINDOW_MS
    if (
      !fits(
        probeMs + periodMs * measurementPeriods(periodMs) + STABLE_WINDOW_MS,
      )
    ) {
      continue
    }
    const probe = await observeFrames(locator, probeMs)
    if (isExactlyStill(probe)) return stillGeometry(probe)
    if (!periodHolds(probe, periodMs)) continue
    // Repeating is not the same as staying put: a carousel that also
    // creeps down the page repeats perfectly while relocating. Comparing
    // the time average of the first period against the second exposes
    // that, at any rate, because the two averages are a whole period apart.
    if (consecutivePeriodDriftPx(probe, periodMs) >= STABLE_EPSILON_PX) continue
    return measureOverPeriods(locator, periodMs)
  }

  // Nothing declared, or nothing declared that held. Estimate from the
  // geometry itself rather than silently averaging over a window of
  // arbitrary length.
  if (!fits(PERIOD_ESTIMATE_WINDOW_MS + MIN_MEASUREMENT_MS)) return null
  const probe = await observeFrames(locator, PERIOD_ESTIMATE_WINDOW_MS)
  if (isExactlyStill(probe)) return stillGeometry(probe)
  if (halvesDriftPx(probe) >= STABLE_EPSILON_PX) return null
  const estimated = estimatePeriodMs(probe)
  if (estimated === null) return null
  if (!fits(estimated * measurementPeriods(estimated) + STABLE_WINDOW_MS)) {
    return null
  }
  return measureOverPeriods(locator, estimated)
}

async function measureOverPeriods(
  locator: LocatorLike,
  periodMs: number,
): Promise<SettledGeometry> {
  const spanMs = periodMs * measurementPeriods(periodMs)
  // One extra frame's worth of observation so the span is fully covered
  // even though the frame that would close it is excluded from the
  // integral.
  const frames = await observeFrames(locator, spanMs + STABLE_WINDOW_MS)
  return restingGeometryOver(frames, spanMs, periodMs)
}

async function readValidatedBoundingBox(
  locator: LocatorLike,
): Promise<BoundingBox> {
  const raw = await locator.boundingBox()
  if (raw === null || raw.width <= 0 || raw.height <= 0) {
    throw new Error('Target must resolve to a visible bounding box')
  }
  return raw
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
