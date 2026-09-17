import { startFixtureServer } from '../src/fixture-server.js'
import { warmUpBenchApp } from '../src/m1-benchmark.js'
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
 * event carried and said nothing about when the next one was allowed to go
 * out, which is the whole defect — eighteen packets can all be dispatched
 * inside a quarter of a second, and then eighteen jumps land across four or
 * five captured frames.
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
 * The arm this tool removed: every packet out as soon as the last one
 * returned, no deadline, no easing.
 */
export const unpacedSideways: SidewaysScroll = async (page) => {
  for (const packet of legacyWheelPackets(SIDEWAYS_PX)) {
    await page.mouse.wheel(packet, 0)
  }
}

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
