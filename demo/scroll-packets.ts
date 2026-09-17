import {
  benchFixture,
  packetSidewaysOver,
  pacedTravelMs,
  scrollArm,
} from './scroll-arm.js'

/**
 * How long this arm takes to carry the travel, in milliseconds.
 *
 * The number belongs to the machine, not to the repository: it is the
 * shipped arm's *measured* travel time on the box that films the pair, so
 * that the two halves of the comparison differ in step size and not in speed.
 * `legacySlotDeltas` in `./scroll-arm.js` carries the measurement that made
 * this an input instead of a constant.
 *
 * Unset, it falls back to what the planner asks for. That is the right floor
 * and the wrong answer on any box that cannot commit sixty scrolls a second
 * — there the arms come out unequal and the picture argues about speed.
 */
const travelMs = Number(process.env.FEATURECAST_ARM_TRAVEL_MS ?? '')

/**
 * The left-hand arm of the scroll comparison: this tool's own pre-issue-15
 * procedure, reconstructed — 38.9 px wheel packets, laid over the shipped
 * arm's own slots so both arms take the same time. `legacySlotDeltas` in
 * `demo/scroll-arm.ts` says why the speed is held still and the step size is
 * not.
 *
 * ```
 * pnpm featurecast run demo/scroll-packets.ts --devices desktop
 * ```
 *
 * It exists to be filmed, not to be used. Nothing in the library offers this
 * behaviour any more, and nothing should: `MAX_SCROLL_STEP_PX` in
 * `src/record.ts` is the decision that removed it, and carries the
 * measurement that justified removing it.
 *
 * One consequence worth knowing before rendering this arm: a raw wheel writes
 * no scroll event, so the event log says the recording stood still while the
 * grid moved. Idle trimming believes the log. Render both arms with trimming
 * off or the comparison compares a trim against a scroll.
 */
const fixture = await benchFixture()
export const url = fixture.origin
export const prepare = fixture.prepare
export default scrollArm(
  packetSidewaysOver(travelMs > 0 ? travelMs : pacedTravelMs()),
)
