import { devices as playwrightDevices } from 'playwright'
import { describe, expect, it } from 'vitest'

import {
  aspectOf,
  listDeviceNames,
  listPresetNames,
  requireCaptureSettings,
  resolveDevice,
} from '../src/devices.js'
import type { DeviceRegistry } from '../src/devices.js'

const registry = playwrightDevices as unknown as DeviceRegistry

/**
 * docs/DEVICES.md's curated table, transcribed once — here, in the test,
 * where a mismatch with the installed Playwright registry is a failure rather
 * than a silent drift in shipped code. The module itself transcribes nothing.
 */
const CURATED_TABLE = [
  {
    density: 2,
    engine: 'chromium',
    output: { height: 1080, width: 1920 },
    playwrightName: 'Desktop Chrome HiDPI',
    pointer: 'arrow',
    preset: 'desktop',
    touch: false,
    viewport: { height: 720, width: 1280 },
  },
  {
    density: 1,
    engine: 'chromium',
    output: { height: 1200, width: 1920 },
    playwrightName: 'Desktop Chrome',
    pointer: 'arrow',
    preset: 'desktop-wide',
    touch: false,
    viewport: { height: 720, width: 1280 },
  },
  {
    density: 2,
    engine: 'webkit',
    output: { height: 1080, width: 1920 },
    playwrightName: 'Desktop Safari',
    pointer: 'arrow',
    preset: 'safari',
    touch: false,
    viewport: { height: 720, width: 1280 },
  },
  {
    density: 3,
    engine: 'webkit',
    output: { height: 1920, width: 1080 },
    playwrightName: 'iPhone 15 Pro',
    pointer: 'touch',
    preset: 'iphone',
    touch: true,
    viewport: { height: 659, width: 393 },
  },
  {
    density: 3,
    engine: 'webkit',
    output: { height: 1920, width: 1080 },
    playwrightName: 'iPhone 15 Pro Max',
    pointer: 'touch',
    preset: 'iphone-max',
    touch: true,
    viewport: { height: 739, width: 430 },
  },
  {
    density: 2,
    engine: 'webkit',
    output: { height: 1920, width: 1080 },
    playwrightName: 'iPhone SE',
    pointer: 'touch',
    preset: 'iphone-small',
    touch: true,
    viewport: { height: 568, width: 320 },
  },
  {
    density: 3,
    engine: 'webkit',
    output: { height: 1080, width: 1920 },
    playwrightName: 'iPhone 15 Pro landscape',
    pointer: 'touch',
    preset: 'iphone-quer',
    touch: true,
    viewport: { height: 343, width: 734 },
  },
  {
    density: 2.625,
    engine: 'chromium',
    output: { height: 1920, width: 1080 },
    playwrightName: 'Pixel 7',
    pointer: 'touch',
    preset: 'android',
    touch: true,
    viewport: { height: 839, width: 412 },
  },
  {
    density: 3,
    engine: 'chromium',
    output: { height: 1920, width: 1080 },
    playwrightName: 'Galaxy S24',
    pointer: 'touch',
    preset: 'android-small',
    touch: true,
    viewport: { height: 780, width: 360 },
  },
  {
    density: 2,
    engine: 'webkit',
    output: { height: 1600, width: 1200 },
    playwrightName: 'iPad Pro 11',
    pointer: 'touch',
    preset: 'tablet',
    touch: true,
    viewport: { height: 1194, width: 834 },
  },
  {
    density: 2,
    engine: 'webkit',
    output: { height: 1600, width: 1200 },
    playwrightName: 'iPad Mini',
    pointer: 'touch',
    preset: 'tablet-small',
    touch: true,
    viewport: { height: 1024, width: 768 },
  },
] as const

describe('curated presets', () => {
  it('offers exactly the eleven names from docs/DEVICES.md', () => {
    expect(listPresetNames()).toEqual(
      [...CURATED_TABLE].map((row) => row.preset).sort(),
    )
  })

  it.each(CURATED_TABLE)(
    'resolves $preset to the documented device, output and pointer',
    (row) => {
      const resolved = resolveDevice(row.preset)
      expect(resolved.playwrightName).toBe(row.playwrightName)
      expect(resolved.preset).toBe(row.preset)
      expect(resolved.device.viewport).toEqual(row.viewport)
      expect(resolved.device.deviceScaleFactor).toBe(row.density)
      expect(resolved.device.hasTouch).toBe(row.touch)
      expect(resolved.device.defaultBrowserType).toBe(row.engine)
      expect(resolved.output.width).toBe(row.output.width)
      expect(resolved.output.height).toBe(row.output.height)
      expect(resolved.pointer.style).toBe(row.pointer)
    },
  )

  it('records desktop over-sized and leaves mobile capture open', () => {
    expect(resolveDevice('desktop').capture).toEqual({
      fps: 60,
      height: 1440,
      quality: 90,
      status: 'decided',
      strategy: 'screencast',
      width: 2560,
    })
    expect(resolveDevice('desktop-wide').capture).toMatchObject({
      height: 1600,
      width: 2560,
    })
    for (const row of CURATED_TABLE.filter((candidate) => candidate.touch)) {
      expect(resolveDevice(row.preset).capture).toMatchObject({
        milestone: 'M3',
        status: 'pending',
      })
    }
  })
})

describe('Playwright registry', () => {
  it('is read at runtime rather than transcribed', () => {
    // The descriptor handed out is the registry's own object, so a Playwright
    // update changes it without any edit here.
    expect(resolveDevice('iphone').device).toBe(registry['iPhone 15 Pro'])
    expect(listDeviceNames().length).toBeGreaterThan(
      listPresetNames().length * 2,
    )
  })

  it('takes device values from the injected registry, not from a table', () => {
    const fake: DeviceRegistry = {
      'Desktop Chrome HiDPI': {
        defaultBrowserType: 'firefox',
        deviceScaleFactor: 7,
        hasTouch: true,
        isMobile: true,
        userAgent: 'fake-agent',
        viewport: { height: 101, width: 100 },
      },
    }
    const resolved = resolveDevice('desktop', fake)
    expect(resolved.device.deviceScaleFactor).toBe(7)
    expect(resolved.device.viewport).toEqual({ height: 101, width: 100 })
    // Pointer style follows the descriptor's touch capability, not the preset.
    expect(resolved.pointer.style).toBe('touch')
  })

  it('resolves every Playwright name without a preset', () => {
    const names = listDeviceNames()
    const failures = names.filter((name) => {
      try {
        const resolved = resolveDevice(name)
        return resolved.preset !== null || resolved.playwrightName !== name
      } catch {
        return true
      }
    })
    expect(failures).toEqual([])
    expect(names).toContain('Galaxy Tab S4')
  })
})

describe('overrides', () => {
  it('extends a preset and replaces single capture fields', () => {
    const resolved = resolveDevice({
      capture: { height: 2000, width: 3200 },
      extends: 'Desktop Chrome HiDPI',
    })
    expect(resolved.capture).toEqual({
      fps: 60,
      height: 2000,
      quality: 90,
      status: 'decided',
      strategy: 'screencast',
      width: 3200,
    })
    expect(resolved.preset).toBeNull()
    expect(resolved.device).toBe(registry['Desktop Chrome HiDPI'])
  })

  it('derives the output size from an aspect shorthand', () => {
    expect(
      resolveDevice({ aspect: '9:16', extends: 'desktop' }).output,
    ).toEqual({
      height: 1920,
      quality: { crf: 23, encoder: 'x264' },
      width: 1080,
    })
    expect(resolveDevice({ aspect: '1:1', extends: 'iphone' }).output).toEqual({
      height: 1080,
      quality: { crf: 23, encoder: 'x264' },
      width: 1080,
    })
  })

  it('lets an explicit output size win over the aspect shorthand', () => {
    const resolved = resolveDevice({
      aspect: '9:16',
      extends: 'desktop',
      output: { height: 1350, width: 1080 },
    })
    expect(resolved.output.width).toBe(1080)
    expect(resolved.output.height).toBe(1350)
    expect(aspectOf(resolved.output)).toBeNull()
  })

  it('replaces pointer fields', () => {
    const resolved = resolveDevice({
      extends: 'iphone',
      pointer: { rippleColor: '#ff0000', sizePx: 64, style: 'none' },
    })
    expect(resolved.pointer).toEqual({
      rippleColor: '#ff0000',
      sizePx: 64,
      style: 'none',
    })
  })

  it('rejects impossible override values', () => {
    expect(() =>
      resolveDevice({ extends: 'desktop', output: { width: 0 } }),
    ).toThrow(/output\.width must be a positive integer/)
    expect(() =>
      resolveDevice({ capture: { quality: 140 }, extends: 'desktop' }),
    ).toThrow(/capture\.quality must be an integer in 1\.\.100/)
    expect(() =>
      resolveDevice({
        extends: 'desktop',
        output: { quality: { crf: 99, encoder: 'x264' } },
      }),
    ).toThrow(/output\.quality\.crf must be an integer in 0\.\.51/)
  })
})

describe('undecided capture (M3)', () => {
  it('hands out desktop capture settings unchanged', () => {
    expect(requireCaptureSettings(resolveDevice('desktop')).width).toBe(2560)
  })

  it('fails on use with a message that names M3 and a way forward', () => {
    let message = ''
    try {
      requireCaptureSettings(resolveDevice('iphone'))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('M3')
    expect(message).toContain('iphone')
    expect(message).toContain('iPhone 15 Pro')
    expect(message).toContain('not decided yet')
    expect(message).toContain('capture')
  })

  it('refuses a partial completion and names what is missing', () => {
    expect(() =>
      resolveDevice({ capture: { width: 1080 }, extends: 'iphone' }),
    ).toThrow(/still open \(M3\); an override must supply height, strategy/)
  })

  it('accepts a complete capture override', () => {
    const resolved = resolveDevice({
      capture: { height: 1920, strategy: 'framed-scale', width: 1080 },
      extends: 'iphone',
    })
    expect(resolved.capture).toEqual({
      fps: 60,
      height: 1920,
      quality: 90,
      status: 'decided',
      strategy: 'framed-scale',
      width: 1080,
    })
    expect(requireCaptureSettings(resolved).strategy).toBe('framed-scale')
  })
})

describe('unknown device names', () => {
  it('names the presets and the close registry entries', () => {
    let message = ''
    try {
      resolveDevice('iPhone 99')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Unknown device "iPhone 99"')
    for (const name of listPresetNames()) {
      expect(message).toContain(name)
    }
    expect(message).toContain('Close Playwright device names')
  })

  it('falls back to the full registry when nothing looks close', () => {
    let message = ''
    try {
      resolveDevice('Fairphone 5')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    const names = listDeviceNames()
    expect(message).toContain(
      `Playwright device names (${String(names.length)})`,
    )
    for (const name of names) {
      expect(message).toContain(name)
    }
  })
})

describe('aspectOf', () => {
  it('labels the three canonical formats and nothing else', () => {
    expect(aspectOf({ height: 1080, width: 1920 })).toBe('16:9')
    expect(aspectOf({ height: 2160, width: 3840 })).toBe('16:9')
    expect(aspectOf({ height: 1920, width: 1080 })).toBe('9:16')
    expect(aspectOf({ height: 1080, width: 1080 })).toBe('1:1')
    // The two curated sizes that deliberately sit outside the three.
    expect(aspectOf({ height: 1200, width: 1920 })).toBeNull()
    expect(aspectOf({ height: 1600, width: 1200 })).toBeNull()
  })
})
