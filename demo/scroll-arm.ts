import { startFixtureServer } from '../src/fixture-server.js'
import { warmUpBenchApp } from '../src/m1-benchmark.js'
import {
  computeScrollPositions,
  DEFAULT_SCROLL_SPEED_PX_PER_SECOND,
  EVENT_LOG_FPS,
} from '../src/record.js'
import type { Demo, RecordPage } from '../src/record.js'

/**
 * The two ways to drive a sideways scroll, so they can be filmed next to
 * each other.
 *
 * ## Why both arms are ours
 *
 * Nothing in this repository has ever been measured against another tool, so
 * nothing here may be captioned as if it had. What *has* been measured is the
 * procedure this tool used to use: 40 px wheel packets pushed out as fast as
 * the loop can push them, with no per-frame deadline. `MAX_SCROLL_STEP_PX` in
 * `src/record.ts` still carries what that did — "40px-capped wheel *packets*
 * turned a 525px scroll into 14 giant, evenly-spaced jumps (~37px each,
 * ~2250px/s) that a screen recorder simply cannot resolve as motion" — and
 * `tests/scroll-motion.test.ts` pins both sides of the number.
 *
 * So the left arm is our own removed code path, reconstructed here, and the
 * right arm is `demo.scroll`. Two procedures, one tool, no competitor named
 * or implied.
 *
 * ## The one thing the reconstruction does not reproduce
 *
 * The removed path was both chunkier *and* faster, because nothing bounded
 * when the next packet went out. The reconstruction keeps the chunkiness and
 * drops the speed: `legacyPacketSchedule` lays the same packets over the
 * shipped arm's own travel time. Reproducing both at once made a picture
 * that argued the wrong thing — see that function for the measurement that
 * forced the change.
 *
 * ## Why the reconstruction lives in a demo script
 *
 * The obvious alternative is an option — `demo.scroll(x, y, { paced: false })`
 * — and it is the wrong shape. That would put a knob on the library whose
 * only setting is "produce the defect we removed", and somebody would
 * eventually find it. The packet loop below needs nothing that a recording
 * script does not already have: `RecordPage.mouse.wheel` is part of the
 * script surface, because a script that needs a raw wheel for its own reasons
 * has always been able to reach one.
 */

/** The scroll container the bench corpus keeps inside another scroller. */
export const GRID = '#gridscroller'

/** How far sideways. The same distance `demo/fixture-tour.ts` travels. */
export const SIDEWAYS_PX = 700

/**
 * The packet size the removed procedure capped at.
 *
 * Note what it is *not*: a per-frame budget. It bounded how much one wheel
 * event carried and said nothing about how far the picture was allowed to
 * move between two captured frames, which is the whole defect — every packet
 * lands whole, so eighteen jumps of 38.9 px is what a camera sees no matter
 * how they are spaced.
 */
export const LEGACY_WHEEL_PACKET_PX = 40

/**
 * The removed procedure's packet list: as few packets as the cap allows.
 *
 * Deliberately reconstructed as a pure function so a test can state what it
 * produces without a browser, and so the claim "these two arms really are
 * different" is checkable rather than asserted in a caption.
 */
export function legacyWheelPackets(
  distancePx: number,
  packetPx: number = LEGACY_WHEEL_PACKET_PX,
): number[] {
  if (packetPx <= 0) {
    throw new Error(
      `A wheel packet has to carry something, got ${String(packetPx)}`,
    )
  }
  const count = Math.ceil(Math.abs(distancePx) / packetPx)
  const step = distancePx / count
  return Array.from({ length: count }, () => step)
}

/** How one arm delivers the sideways travel. The only difference between them. */
export type SidewaysScroll = (page: RecordPage, demo: Demo) => Promise<void>

/**
 * The arm this tool ships: eased travel against absolute 60 Hz deadlines,
 * capped at `MAX_SCROLL_STEP_PX` per slot.
 */
export const pacedSideways: SidewaysScroll = async (_page, demo) => {
  await demo.scroll(SIDEWAYS_PX, 0)
}

/**
 * How many 60 Hz slots the shipped arm spends carrying a distance.
 *
 * Read out of the shipped planner itself rather than restated here, so the
 * two arms cannot drift apart when the planner's speed or its per-step cap
 * changes. One slot is one 60 Hz frame.
 */
export function pacedTravelSlots(distancePx: number = SIDEWAYS_PX): number {
  return computeScrollPositions(
    distancePx,
    0,
    DEFAULT_SCROLL_SPEED_PX_PER_SECOND,
    EVENT_LOG_FPS,
  ).length
}

/** The planner's own travel time, in milliseconds. One slot is one frame. */
export function pacedTravelMs(distancePx: number = SIDEWAYS_PX): number {
  return (pacedTravelSlots(distancePx) / EVENT_LOG_FPS) * 1000
}

/**
 * The legacy packets laid out over the shipped arm's own slots: what goes out
 * in each 60 Hz slot, zero included.
 *
 * ## Why the packets are spread at all
 *
 * The removed procedure pushed its packets out as fast as the loop could
 * push them, and the first filmed comparison of the two arms showed exactly
 * that: the left side carried the 700 px in 0.64 s and the right in 2.02 s
 * (measured off the recordings, 2026-09-17). Side by side that reads as "the
 * left one is faster", which is a different claim from the one being made,
 * and a viewer is entitled to take it as an argument against the shipped arm.
 *
 * Two variables were moving at once — how *big* each step is and how *long*
 * the travel takes — and only the first is what `MAX_SCROLL_STEP_PX` exists
 * to bound. This holds the second still, so what is left in the picture is
 * the claim itself.
 *
 * ## Why the travel time is an input and not a constant
 *
 * The obvious way to hold the duration still is to spread the packets over
 * the shipped arm's *planned* travel time. That does not survive contact with
 * a real machine. What sets the shipped arm's duration is not its 60 Hz
 * deadlines but the cost of one compositor commit per step, and that cost is
 * a property of the box: on the measuring box a planned 1.00 s takes 2.05 s,
 * because sixty scrolls cannot be committed faster than about thirty a
 * second. Eighteen packets pay that cost eighteen times, so no arrangement of
 * *events* can make the two arms take the same time — the step count is the
 * thing being compared, and the step count is what the clock is bound to.
 *
 * Filling the empty slots with zero-delta wheel events was tried and
 * measured: it does not work either, because a wheel that scrolls nothing
 * commits nothing and costs nothing. The packet arm still finished in 1.25 s
 * against the shipped arm's 2.05 s.
 *
 * So the travel time is measured off the shipped arm on the machine that will
 * film them, and handed to this one. `pacedTravelMs()` is the floor — what
 * the planner asks for — and a box that cannot keep up needs more.
 *
 * ## What is still the removed procedure
 *
 * The packet size is untouched, and that is where the defect lives: every
 * lump is 38.9 px, which is more than the shipped path will put between two
 * frames under any circumstances. A camera sees a jump of that size as a
 * jump no matter how it was scheduled.
 */
export function legacySlotDeltas(
  distancePx: number = SIDEWAYS_PX,
  packetPx: number = LEGACY_WHEEL_PACKET_PX,
): number[] {
  const packets = legacyWheelPackets(distancePx, packetPx)
  const slots = pacedTravelSlots(distancePx)
  if (packets.length > slots) {
    throw new Error(
      `${String(packets.length)} wheel packets do not fit in the ` +
        `${String(slots)} slots the shipped arm takes for ${String(distancePx)}px. ` +
        'Spreading them would make the legacy arm the slower of the two, ' +
        'which is the opposite of the confound this exists to remove.',
    )
  }
  const deltas = new Array<number>(slots).fill(0)
  packets.forEach((packet, index) => {
    // The last slot of the share this packet owns, so the eighteenth lump
    // lands in the same slot as the shipped arm's sixtieth step: both arms
    // arrive at the same instant, not merely within the same window.
    const slot = Math.ceil(((index + 1) * slots) / packets.length) - 1
    deltas[slot] = (deltas[slot] ?? 0) + packet
  })
  return deltas
}

/**
 * The arm this tool removed, reconstructed: whole 38.9 px wheel packets, laid
 * over a travel time taken from the shipped arm, so that the two halves of
 * the picture differ in step size and in nothing else.
 *
 * `travelMs` is measured on the machine that films the pair — see
 * `legacySlotDeltas` for why it cannot be a constant.
 */
export function packetSidewaysOver(
  travelMs: number = pacedTravelMs(),
): SidewaysScroll {
  if (!Number.isFinite(travelMs) || travelMs <= 0) {
    throw new Error(
      `The packet arm needs a positive travel time, got ${String(travelMs)}ms.`,
    )
  }
  const deltas = legacySlotDeltas()
  return async function packets(page) {
    const started = Date.now()
    for (const [index, delta] of deltas.entries()) {
      if (delta === 0) continue
      // Against an absolute deadline rather than a sleep per lump: a sleep
      // adds the dispatch cost to every wait, and eighteen of those would
      // drift this arm past the other one.
      const due = started + (travelMs * (index + 1)) / deltas.length
      const wait = due - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      await page.mouse.wheel(delta, 0)
    }
  }
}

/** The packet arm over the planner's own travel time: the floor, not a box. */
export const packetSideways: SidewaysScroll = packetSidewaysOver()

/**
 * The journey both arms take. Short on purpose: the sideways scroll is what
 * is being shown, so it happens in the first second and a half rather than
 * after a tour of the application. A comparison whose point arrives late is
 * not watched to the end.
 *
 * The pointer is parked on the grid first because Chromium binds a wheel to
 * the element under the pointer and hands nothing to an ancestor — without
 * it, the unpaced arm would scroll nothing and the comparison would flatter
 * us for the wrong reason.
 */
export function scrollArm(
  sideways: SidewaysScroll,
): (page: RecordPage, demo: Demo) => Promise<void> {
  return async function arm(page: RecordPage, demo: Demo): Promise<void> {
    await demo.hold(400)
    await demo.point(GRID)
    await sideways(page, demo)
    await demo.hold(1400)
  }
}

/** The corpus, served from this repository, on a port the run is given. */
export async function benchFixture(): Promise<{
  origin: string
  prepare: (app: Parameters<typeof warmUpBenchApp>[0]) => Promise<void>
}> {
  const fixture = await startFixtureServer()
  return {
    origin: fixture.origin,
    prepare: async (app) => {
      await warmUpBenchApp(app, fixture.origin)
    },
  }
}
