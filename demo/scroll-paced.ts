import { benchFixture, pacedSideways, scrollArm } from './scroll-arm.js'

/**
 * The right-hand arm of the scroll comparison: `demo.scroll`, as shipped.
 *
 * ```
 * pnpm featurecast run demo/scroll-paced.ts --devices desktop
 * ```
 *
 * Same corpus, same choreography and same seed as `demo/scroll-unpaced.ts`.
 * The only difference between the two files is which function delivers the
 * sideways travel — see `demo/scroll-arm.ts` for why both arms are ours.
 */
const fixture = await benchFixture()
export const url = fixture.origin
export const prepare = fixture.prepare
export default scrollArm(pacedSideways)
