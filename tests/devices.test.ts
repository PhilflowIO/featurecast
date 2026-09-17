import { devices as playwrightDevices } from 'playwright'
import { assert, describe, expect, it } from 'vitest'

import {
  aspectOf,
  listDeviceNames,
  listPresetNames,
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
    output: { height: 2160, width: 3840 },
    playwrightName: 'Desktop Chrome HiDPI',
    pointer: 'arrow',
    preset: 'desktop-4k',
    reserve: 'exact',

    touch: false,
    viewport: { height: 720, width: 1280 },
  },
  {
    density: 2,
    engine: 'chromium',
    output: { height: 1080, width: 1920 },
    playwrightName: 'Desktop Chrome HiDPI',
    pointer: 'arrow',
    preset: 'desktop',
    reserve: 'over-sized',

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
    reserve: 'over-sized',

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
    reserve: 'over-sized',

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
    reserve: 'exact',

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
    reserve: 'exact',

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
    reserve: 'exact',

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
    reserve: 'exact',

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
    reserve: 'exact',

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
    reserve: 'exact',

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
    reserve: 'exact',

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
    reserve: 'exact',

    touch: true,
    viewport: { height: 1024, width: 768 },
  },
] as const

describe('curated presets', () => {
  it('offers exactly the twelve names from docs/DEVICES.md', () => {
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

  it('records each preset with the reserve its row declares', () => {
    // Two rules, and the second one is new. Most desktop presets record more
    // than they output: that margin is what M4 cuts its second and third
    // format out of, and what the zoom spring pans inside. `desktop-4k` and
    // every touch preset record exactly what they deliver, and therefore have
    // no margin at all — the render stage clamps their push-in to 1.00x and
    // says so. Which class a preset is in is a documented property, so it is
    // declared in the table rather than inferred here.
    for (const row of CURATED_TABLE) {
      const resolved = resolveDevice(row.preset)
      if (row.reserve === 'over-sized') {
        expect(resolved.capture).toEqual({
          fps: 60,
          height: 1600,
          quality: 90,
          status: 'decided',
          strategy: 'screencast',
          width: 2560,
        })
        expect(resolved.capture.width).toBeGreaterThan(resolved.output.width)
        expect(resolved.capture.height).toBeGreaterThan(resolved.output.height)
        continue
      }
      expect(resolved.capture.width).toBe(resolved.output.width)
      expect(resolved.capture.height).toBe(resolved.output.height)
      expect(resolved.capture).toMatchObject({
        strategy: row.touch ? 'framed-scale' : 'screencast',
      })
    }
  })
})

describe('Playwright registry', () => {
  it('is read at runtime rather than transcribed', () => {
    // The descriptor handed out carries the registry's own values, so a
    // Playwright update changes it without any edit here.
    expect(resolveDevice('iphone').device).toEqual(registry['iPhone 15 Pro'])
    expect(listDeviceNames().length).toBeGreaterThan(
      listPresetNames().length * 2,
    )
  })

  it('hands out a copy, so a caller cannot poison the registry', () => {
    // The resolved device is made to be passed to browser.newContext, which
    // invites editing it first. That edit must not reach Playwright's
    // process-wide registry, nested fields included.
    const entry = registry['iPhone 15 Pro']
    assert(
      entry !== undefined,
      'the installed registry must have iPhone 15 Pro',
    )
    const untouched = {
      userAgent: entry.userAgent,
      viewport: { ...entry.viewport },
    }

    const resolved = resolveDevice('iphone')
    expect(resolved.device).not.toBe(entry)
    expect(resolved.device.viewport).not.toBe(entry.viewport)

    resolved.device.userAgent = 'poisoned'
    resolved.device.viewport.width = 1
    resolved.device.viewport.height = 1

    expect(entry.userAgent).toBe(untouched.userAgent)
    expect(entry.viewport).toEqual(untouched.viewport)
    // And the next resolution is unaffected by the first caller's edit.
    expect(resolveDevice('iphone').device.viewport).toEqual(untouched.viewport)
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
    expect(resolved.device).toEqual(registry['Desktop Chrome HiDPI'])
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

describe('capture per device class (M3)', () => {
  it('hands out desktop capture settings unchanged', () => {
    expect(resolveDevice('desktop').capture.width).toBe(2560)
  })

  it('records every touch preset at its own output size, framed', () => {
    for (const name of listPresetNames()) {
      const resolved = resolveDevice(name)
      if (!resolved.device.hasTouch) continue
      expect({ preset: name, ...resolved.capture }).toEqual({
        fps: 60,
        height: resolved.output.height,
        preset: name,
        quality: 90,
        status: 'decided',
        strategy: 'framed-scale',
        width: resolved.output.width,
      })
    }
  })

  it('gives a bare touch device the same treatment as a curated one', () => {
    const resolved = resolveDevice('Galaxy S9+')
    expect(resolved.preset).toBeNull()
    expect(resolved.capture.strategy).toBe('framed-scale')
    expect(resolved.capture.width).toBe(1080)
    expect(resolved.capture.height).toBe(1920)
  })

  it('accepts a partial capture override on a touch preset', () => {
    const resolved = resolveDevice({
      capture: { width: 1440 },
      extends: 'iphone',
    })
    expect(resolved.capture).toEqual({
      fps: 60,
      height: 1920,
      quality: 90,
      status: 'decided',
      strategy: 'framed-scale',
      width: 1440,
    })
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

    // The point of the close list is that it is *narrower* than the registry.
    // Asserting the heading alone would still pass if the code offered every
    // name. No hard-wired count: the split is derived from the same word rule
    // the message promises, against whatever registry is installed.
    const all = listDeviceNames()
    const matching = all.filter((name) => name.toLowerCase().includes('iphone'))
    const unrelated = all.filter(
      (name) => !name.toLowerCase().includes('iphone'),
    )
    expect(matching.length).toBeGreaterThan(0)
    expect(unrelated.length).toBeGreaterThan(0)
    for (const name of matching) {
      expect(message).toContain(name)
    }
    for (const name of unrelated) {
      expect(message).not.toContain(name)
    }
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
