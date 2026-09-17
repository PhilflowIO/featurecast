import { benchFixture, scrollArm, unpacedSideways } from './scroll-arm.js'

/**
 * The left-hand arm of the scroll comparison: this tool's own pre-issue-15
 * procedure, reconstructed — 40 px wheel packets with no per-frame deadline.
 *
 * ```
 * pnpm featurecast run demo/scroll-unpaced.ts --devices desktop
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
export default scrollArm(unpacedSideways)
