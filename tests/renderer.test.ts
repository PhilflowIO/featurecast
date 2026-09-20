import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assertHardwareRenderer,
  detectRenderer,
  HARDWARE_GL_LAUNCH_ARGS,
} from '../src/renderer.js'

function fakePage(renderer: string) {
  return { evaluate: vi.fn().mockResolvedValue(renderer) }
}

describe('detectRenderer', () => {
  it('flags a SwiftShader renderer as software rendering', async () => {
    const page = fakePage(
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    )

    const info = await detectRenderer(page as never)

    expect(info.softwareRendering).toBe(true)
    expect(info.launchArgs).toEqual(HARDWARE_GL_LAUNCH_ARGS)
  })

  it('does not flag a real GPU renderer', async () => {
    const page = fakePage(
      'ANGLE (AMD, AMD Radeon 860M Graphics (radeonsi krackan1 ACO), OpenGL ES 3.2)',
    )

    const info = await detectRenderer(page as never)

    expect(info.softwareRendering).toBe(false)
  })
})

/**
 * What the guard does is a property of the function, not of the machine the
 * suite happens to run on: on a GPU-less runner the whole run sets
 * FEATURECAST_ALLOW_SOFTWARE_RENDERER=1, and every case below that expects a
 * throw would then silently stop testing anything. So the switch is owned
 * here — cleared before each case, set by the one case whose subject it is,
 * and the ambient value restored afterwards.
 */
describe('assertHardwareRenderer', () => {
  const originalEnvironmentValue =
    process.env['FEATURECAST_ALLOW_SOFTWARE_RENDERER']

  beforeEach(() => {
    delete process.env['FEATURECAST_ALLOW_SOFTWARE_RENDERER']
  })

  afterAll(() => {
    if (originalEnvironmentValue === undefined) {
      delete process.env['FEATURECAST_ALLOW_SOFTWARE_RENDERER']
    } else {
      process.env['FEATURECAST_ALLOW_SOFTWARE_RENDERER'] =
        originalEnvironmentValue
    }
  })

  it('throws on software rendering by default', () => {
    expect(() =>
      assertHardwareRenderer({
        launchArgs: HARDWARE_GL_LAUNCH_ARGS,
        renderer: 'SwiftShader driver',
        softwareRendering: true,
      }),
    ).toThrow('software GL renderer')
  })

  it('allows software rendering when explicitly opted in', () => {
    process.env['FEATURECAST_ALLOW_SOFTWARE_RENDERER'] = '1'
    expect(() =>
      assertHardwareRenderer({
        launchArgs: HARDWARE_GL_LAUNCH_ARGS,
        renderer: 'SwiftShader driver',
        softwareRendering: true,
      }),
    ).not.toThrow()
  })

  it('never throws for hardware rendering', () => {
    expect(() =>
      assertHardwareRenderer({
        launchArgs: HARDWARE_GL_LAUNCH_ARGS,
        renderer: 'ANGLE (AMD, AMD Radeon 860M Graphics)',
        softwareRendering: false,
      }),
    ).not.toThrow()
  })

  it('advises the hardware-GL flags when none were passed', () => {
    expect(() =>
      assertHardwareRenderer({
        launchArgs: [],
        renderer: 'SwiftShader driver',
        softwareRendering: true,
      }),
    ).toThrow(
      `Launch Chromium with hardware GL (${HARDWARE_GL_LAUNCH_ARGS.join(' ')})`,
    )
  })

  it('points at the environment instead of repeating already-used flags', () => {
    expect(() =>
      assertHardwareRenderer({
        launchArgs: HARDWARE_GL_LAUNCH_ARGS,
        renderer: 'SwiftShader driver',
        softwareRendering: true,
      }),
    ).toThrow('already launched with hardware-GL flags')
  })
})
