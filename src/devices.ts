import { devices as playwrightDevices } from 'playwright'

import { CAPTURE_QUALITY } from './capture.js'
import { FRAME_RATE } from './assemble.js'
import {
  DEFAULT_OUTPUT_QUALITY,
  qualityNumber,
  type OutputQuality,
} from './encoders.js'

/**
 * The device layer described in docs/DEVICES.md: one name in the call,
 * everything else derived from it.
 *
 * Three layers, stacked, and the boundary between them is the point of this
 * module:
 *
 * 1. Playwright's registry — viewport, deviceScaleFactor, isMobile, hasTouch,
 *    userAgent, defaultBrowserType. Read from the installed `playwright` at
 *    runtime, never transcribed. docs/DEVICES.md counted 143 profiles; the
 *    playwright 1.64 in this worktree exposes 207 (107 base + 100
 *    `… landscape` variants), which is exactly why the list is read and not
 *    copied.
 * 2. Capture — the area actually recorded, plus fps, JPEG quality and the
 *    capture strategy. Separate from the device because the screencast
 *    delivers CSS pixels and ignores the pixel density (measured, M3), so the
 *    device profile alone does not determine the recorded resolution: a
 *    desktop profile is over-captured and scaled down, and a touch profile is
 *    filmed through the framed strategy in src/framed.ts.
 * 3. Output and pointer — encoded pixel size plus encoder quality, and how
 *    the pointer is drawn.
 *
 * ## How `record()` is meant to attach to this (not wired up here)
 *
 * `RecordOptions` currently carries `device?: string` and resolves it inline
 * via a private `resolveDeviceDescriptor` (src/record.ts:577-596), which
 * handles layer 1 only. The intended wiring, once record.ts is free:
 *
 * ```ts
 * const resolved = resolveDevice(
 *   options.aspect === undefined
 *     ? options.device
 *     : { extends: deviceName(options.device), aspect: options.aspect },
 * )
 * const context = await browser.newContext(resolved.device)
 * recordPage.hasTouch = resolved.device.hasTouch
 * ```
 *
 * `resolved.device` is deliberately shaped as a Playwright context option
 * bag, so it can be handed to `browser.newContext` unchanged. It is a private
 * copy of the registry entry, so editing it before that call cannot reach
 * Playwright's process-wide `devices` object; `resolved.
 * capture` feeds src/capture.ts, `resolved.output` feeds src/assemble.ts's
 * scale/encode arguments, `resolved.pointer` feeds the M4 pointer renderer.
 *
 * Nothing in this module launches, imports or needs a browser: `playwright`'s
 * `devices` export is a plain object.
 */

/** A device descriptor as Playwright's registry provides it, verbatim. */
export type DeviceDescriptor = {
  defaultBrowserType: 'chromium' | 'firefox' | 'webkit'
  deviceScaleFactor: number
  hasTouch: boolean
  isMobile: boolean
  userAgent: string
  viewport: { height: number; width: number }
}

export type DeviceRegistry = Readonly<Record<string, DeviceDescriptor>>

/**
 * Which mechanism produces frames. Two, because M3 measured four and kept
 * the two that work; docs/M3-VERDICT.md holds the numbers each was dropped on.
 *
 * - `screencast` films the page directly (M1, src/capture.ts). Right whenever
 *   the layout width and the recorded width may be the same number, which is
 *   every pointer device.
 * - `framed-scale` films a shell the application is laid out inside, at the
 *   device's own width, scaled up (src/framed.ts). The answer for touch
 *   devices, where those two numbers differ by a factor of three.
 */
export type CaptureStrategy = 'framed-scale' | 'screencast'

export type CaptureSettings = {
  /** Frames per second the capture aims for. */
  fps: number
  height: number
  /** JPEG quality Chromium encodes each screencast frame at, 1-100. */
  quality: number
  status: 'decided'
  strategy: CaptureStrategy
  width: number
}

/** Requestable output format. `output.width`/`height` stay the stored truth. */
export type Aspect = '1:1' | '16:9' | '9:16'

/**
 * Re-exported so a caller that already imports the device layer does not have
 * to reach into src/encoders.ts for the type of a field it just read. The
 * definition lives there because the assemble stage is handed this value and
 * must not import the device layer to name it.
 */
export type { OutputQuality }

export type OutputSettings = {
  height: number
  quality: OutputQuality
  width: number
}

export type PointerStyle = 'arrow' | 'none' | 'touch'

export type PointerSettings = {
  /** CSS color the touch ripple blooms in. */
  rippleColor: string
  /** Rendered pointer size in output pixels. */
  sizePx: number
  style: PointerStyle
}

export type ResolvedDevice = {
  capture: CaptureSettings
  /** Playwright's descriptor, unchanged, ready for `browser.newContext`. */
  device: DeviceDescriptor
  output: OutputSettings
  /** The Playwright registry name this resolved to. */
  playwrightName: string
  pointer: PointerSettings
  /** The curated preset used, or `null` for a bare Playwright name. */
  preset: string | null
}

/** Field-wise overrides on top of a preset or a Playwright device name. */
export type DeviceOverrides = {
  /**
   * Shorthand for `output.width`/`height`: sets both from
   * `ASPECT_DIMENSIONS`. Ignored when `output.width` and `output.height` are
   * given explicitly.
   */
  /**
   * What this variant is filed under: the name it appears as in a report and
   * the directory its artifacts land in.
   *
   * Defaults to `extends`, which is right until two variants extend the same
   * preset. Two recordings of `desktop` at different capture areas would then
   * both want the directory `desktop`, and the second would drop its files
   * between the first one's frames. Deriving a name from the overridden
   * fields instead was considered and dropped: it answers "which fields count"
   * with a guess, and a pointer colour would silently produce a second
   * directory nobody asked for.
   *
   * Ignored by `resolveDevice` — it names the variant, it does not resolve it.
   */
  as?: string
  aspect?: Aspect
  capture?: Partial<Omit<CaptureSettings, 'status'>>
  /** A curated preset name or any name from Playwright's registry. */
  extends: string
  output?: Partial<OutputSettings>
  pointer?: Partial<PointerSettings>
  /**
   * The capture area as a multiple of the output on both axes: `1.5` records
   * a 1080x1920 delivery at 1620x2880, `1` records exactly what is delivered
   * and leaves the camera no room to push in.
   *
   * The named form of `capture.width`/`height` for the one question a script
   * usually has — "how much zoom room" — without working out pixels per
   * device. Touch presets default to `MOBILE_CAPTURE_RESERVE`; desktop presets
   * keep their fixed area unless this is given. Naming both this and a capture
   * size is refused: the two answer the same question.
   */
  reserve?: number
}

export type DeviceSpec = DeviceOverrides | string

/**
 * Canonical pixel sizes per aspect. Presets may carry output sizes outside
 * this table on purpose — `desktop-wide` is 1920x1200 (16:10) and `tablet` is
 * 1200x1600 (3:4) per docs/DEVICES.md — which is why `aspect` is an input
 * shorthand and a derived label (`aspectOf`) rather than a stored field: a
 * stored aspect would contradict the stored pixel size for those two.
 */
export const ASPECT_DIMENSIONS: Readonly<
  Record<Aspect, { height: number; width: number }>
> = {
  '1:1': { height: 1080, width: 1080 },
  '16:9': { height: 1080, width: 1920 },
  '9:16': { height: 1920, width: 1080 },
}

/**
 * Re-exported for the same reason as `OutputQuality`: the default is a
 * statement about the encoder, not about any device.
 */
export { DEFAULT_OUTPUT_QUALITY }

/**
 * Pointer defaults. Both numbers are placeholders owned by M4 (pointer
 * rendering from the event log) and are overridable per device; they are not
 * measured. 24px is the nominal size of a desktop system cursor; the ripple
 * colour is a neutral translucent white that reads on light and dark UI.
 */
export const DEFAULT_POINTER_SIZE_PX = 24
export const DEFAULT_RIPPLE_COLOR = 'rgba(255, 255, 255, 0.72)'

type Preset = {
  capture: CaptureSettings
  output: { height: number; width: number }
  playwrightName: string
}

/**
 * The one area every desktop preset records, and the margin it buys.
 *
 * Over-capturing is the decision (PLAN.md, docs/DEVICES.md): M4 cuts three
 * output formats out of a single recording without a second browser run, and
 * the zoom spring frames the element each click hit — both need pixels
 * outside the finished frame, and 1920x1080 has none to give.
 *
 * 2560x1600 rather than a larger number, for three reasons. It is the only
 * desktop geometry with measurements behind it (docs/M1-VERDICT.md). It is
 * exactly the 1.33x linear reserve PLAN.md names, over the widest output any
 * desktop preset carries (1920x1200). And it is a viewport a real web app
 * still lays out sensibly; height is what a taller capture would have to buy,
 * and a page rendered 2560 CSS pixels tall stops resembling what a viewer
 * would see.
 *
 * What that buys, per output format, at full sharpness and no upscaling:
 *
 * - 16:10 1920x1200 — 1.33x reserve on both axes.
 * - 16:9 1920x1080 — 1.33x across, 1.48x down; the 160px the 16:9 crop drops
 *   are framing room for the zoom, not waste.
 * - 1:1 1080x1080 — a 1600x1600 square fits, so 1.48x reserve.
 *
 * And what it does **not** buy, said plainly: **9:16 1080x1920 does not fall
 * out of a desktop capture.** The tallest 9:16 crop from a 1600px-high frame
 * is 900x1600, which would have to be scaled up by 1.2x to reach 1080x1920 —
 * an upscale the render stage refuses to pretend is sharpness. Portrait
 * output is the mobile presets' job, and their capture area is M3's open
 * question, not something answered here.
 */
const DESKTOP_CAPTURE_SIZE = { height: 1600, width: 2560 }

function desktopCapture(
  size: { height: number; width: number } = DESKTOP_CAPTURE_SIZE,
): CaptureSettings {
  return {
    fps: FRAME_RATE,
    height: size.height,
    quality: CAPTURE_QUALITY,
    status: 'decided',
    strategy: 'screencast',
    width: size.width,
  }
}

/**
 * The one desktop area that is not 2560x1600, and what it buys and costs.
 *
 * Measured 2026-09-17 on the benchmark machine: capture yield 98.60 %
 * (282 of 286 presented frames), clearing the 95 % gate, with intact and sharp
 * frames — recording at this size is not the problem it was assumed to be.
 *
 * What it costs is the cadence, and that is stated rather than buried. At
 * 2560x1600 the browser presents a frame every 16.76 ms in the median, which
 * is 60 a second; at 3840x2160 it is 20.52 ms, and only half the gaps are a
 * single full interval against 84.8 % at the smaller size. So this preset
 * delivers 4K, and it does not deliver 4K at 60 frames a second. Anything
 * claiming otherwise is claiming more than was measured.
 *
 * It also costs the camera. The output is the capture area, so there is no
 * reserve to crop into and the render stage clamps every push-in to 1.00x. A
 * run that
 * wants both a large picture and a moving camera asks for the area and the
 * delivery separately, which the device layer takes:
 * `{ extends: 'desktop', capture: { width: 3840, height: 2160 } }` keeps the
 * preset's own 1920x1080 output and leaves a 2x reserve.
 */
const DESKTOP_4K_SIZE = { height: 2160, width: 3840 }

/**
 * How much larger than its output every touch profile records.
 *
 * M3's answer to "the screencast delivers CSS pixels" is `framed-scale`: the
 * recorded page is the video's own size and the application is laid out at
 * the device's width inside it, scaled up by a CSS transform that
 * re-rasterises (src/framed.ts carries the argument and the evidence). A
 * larger recorded page only raises that scale, so the reserve costs the
 * application nothing in layout.
 *
 * Until 2026-09-18 the touch presets recorded exactly their output, because a
 * larger area looked like it cost half the frame rate. It did not: the phone
 * path presented at 30 Hz at every size, and the cause was the swipe awaiting
 * each touch acknowledgement (#116, #142). With that fixed, 1620x2880 on the
 * AI box, stock Chrome for Testing 154, 13 passes: 16.70 ms median gap, 86.7 %
 * single-refresh gaps, 97.0 % yield — the same cadence as 1080x1920 (16.69 ms,
 * 84.0 %, 96.7 %) and clear of the 95 % gate (#149).
 *
 * What 1.5x buys: a push-in onto a small target up to 1.5x at full sharpness,
 * where 1x clamps every push-in to 1.00x. What it costs: 2.25 times the pixels
 * per frame — 322 KB per stored frame against 187 at 1x, measured 2026-09-17 —
 * and 13 % more time per pass. A run that does not want it says `reserve: 1`.
 */
export const MOBILE_CAPTURE_RESERVE = 1.5

function mobileCapture(output: {
  height: number
  width: number
}): CaptureSettings {
  const size = scaledArea(output, MOBILE_CAPTURE_RESERVE)
  return {
    fps: FRAME_RATE,
    height: size.height,
    quality: CAPTURE_QUALITY,
    status: 'decided',
    strategy: 'framed-scale',
    width: size.width,
  }
}

/**
 * `size` times `reserve`, rounded to the nearest even pixel on each axis:
 * the H.264 encoders refuse odd dimensions, and a 1.33x reserve on 1080
 * lands on 1436.4.
 */
function scaledArea(
  size: { height: number; width: number },
  reserve: number,
): { height: number; width: number } {
  return {
    height: 2 * Math.round((size.height * reserve) / 2),
    width: 2 * Math.round((size.width * reserve) / 2),
  }
}

/**
 * The twelve curated presets from docs/DEVICES.md. They exist so a later
 * dropdown has twelve sensible entries instead of 207; every Playwright name
 * resolves too, without a preset.
 *
 * `safari` records under WebKit, where the screencast interface is untested
 * (docs/DEVICES.md, "Engine-Hinweis"). Its capture is still marked decided
 * because docs/DEVICES.md decides its size; whether WebKit can deliver it is
 * an M3 question about the engine, not about the numbers.
 */
const PRESETS: Readonly<Record<string, Preset>> = {
  android: {
    capture: mobileCapture({ height: 1920, width: 1080 }),
    output: { height: 1920, width: 1080 },
    playwrightName: 'Pixel 7',
  },
  'android-small': {
    capture: mobileCapture({ height: 1920, width: 1080 }),
    output: { height: 1920, width: 1080 },
    playwrightName: 'Galaxy S24',
  },
  desktop: {
    capture: desktopCapture(),
    output: { height: 1080, width: 1920 },
    playwrightName: 'Desktop Chrome HiDPI',
  },
  'desktop-4k': {
    capture: desktopCapture(DESKTOP_4K_SIZE),
    output: { height: DESKTOP_4K_SIZE.height, width: DESKTOP_4K_SIZE.width },
    playwrightName: 'Desktop Chrome HiDPI',
  },
  'desktop-wide': {
    capture: desktopCapture(),
    output: { height: 1200, width: 1920 },
    playwrightName: 'Desktop Chrome',
  },
  iphone: {
    capture: mobileCapture({ height: 1920, width: 1080 }),
    output: { height: 1920, width: 1080 },
    playwrightName: 'iPhone 15 Pro',
  },
  'iphone-max': {
    capture: mobileCapture({ height: 1920, width: 1080 }),
    output: { height: 1920, width: 1080 },
    playwrightName: 'iPhone 15 Pro Max',
  },
  'iphone-quer': {
    capture: mobileCapture({ height: 1080, width: 1920 }),
    output: { height: 1080, width: 1920 },
    playwrightName: 'iPhone 15 Pro landscape',
  },
  'iphone-small': {
    capture: mobileCapture({ height: 1920, width: 1080 }),
    output: { height: 1920, width: 1080 },
    playwrightName: 'iPhone SE',
  },
  safari: {
    capture: desktopCapture(),
    output: { height: 1080, width: 1920 },
    playwrightName: 'Desktop Safari',
  },
  tablet: {
    capture: mobileCapture({ height: 1600, width: 1200 }),
    output: { height: 1600, width: 1200 },
    playwrightName: 'iPad Pro 11',
  },
  'tablet-small': {
    capture: mobileCapture({ height: 1600, width: 1200 }),
    output: { height: 1600, width: 1200 },
    playwrightName: 'iPad Mini',
  },
}

/** The twelve curated preset names, sorted. */
export function listPresetNames(): string[] {
  return Object.keys(PRESETS).sort()
}

/** Every name the installed Playwright offers, sorted. */
export function listDeviceNames(
  registry: DeviceRegistry = playwrightDevices as DeviceRegistry,
): string[] {
  return Object.keys(registry).sort()
}

/** `'16:9'`, `'9:16'`, `'1:1'` — or `null` for a size outside the three. */
export function aspectOf(size: {
  height: number
  width: number
}): Aspect | null {
  for (const [aspect, dimensions] of Object.entries(ASPECT_DIMENSIONS)) {
    if (size.width * dimensions.height === size.height * dimensions.width) {
      return aspect as Aspect
    }
  }
  return null
}

/**
 * Resolves a device name, a preset name, or a preset plus field overrides
 * into the full three-layer description.
 *
 * ```ts
 * resolveDevice('iphone')
 * resolveDevice('Pixel 7')
 * resolveDevice({ extends: 'Desktop Chrome HiDPI',
 *                 capture: { width: 3200, height: 2000 } })
 * ```
 *
 * Throws on an unknown name, listing the names that exist, and on an override
 * that cannot produce a usable value.
 */
export function resolveDevice(
  spec: DeviceSpec,
  registry: DeviceRegistry = playwrightDevices as DeviceRegistry,
): ResolvedDevice {
  const overrides: DeviceOverrides =
    typeof spec === 'string' ? { extends: spec } : spec
  const name = overrides.extends
  const preset = Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined
  const playwrightName = preset ? preset.playwrightName : name
  const descriptor = Object.hasOwn(registry, playwrightName)
    ? registry[playwrightName]
    : undefined
  if (descriptor === undefined) {
    throw new Error(unknownDeviceMessage(name, registry))
  }

  // A bare Playwright name has no curated output size. 16:9 for a pointer
  // device, 9:16 for a touch device mirrors what every curated preset does.
  const bareOutput = descriptor.hasTouch
    ? ASPECT_DIMENSIONS['9:16']
    : ASPECT_DIMENSIONS['16:9']
  const base: Preset = preset ?? {
    capture: descriptor.hasTouch ? mobileCapture(bareOutput) : desktopCapture(),
    output: bareOutput,
    playwrightName,
  }

  const output = applyOutputOverrides(base.output, overrides)
  return {
    capture: applyCaptureOverrides(
      base.capture,
      withReserve(overrides, output),
    ),
    device: copyDescriptor(descriptor),
    output,
    playwrightName,
    pointer: applyPointerOverrides(descriptor, overrides.pointer),
    preset: preset ? name : null,
  }
}

/**
 * A private copy of a registry descriptor.
 *
 * The resolved device is meant to be handed straight to `browser.newContext`,
 * which invites a caller to tweak a field first. Handing out Playwright's own
 * object would make that tweak reach into the process-wide `devices` registry
 * and change every later resolution in the same process. `viewport` is copied
 * too: a shallow copy would leave exactly that hole one level down.
 */
function copyDescriptor(descriptor: DeviceDescriptor): DeviceDescriptor {
  return { ...descriptor, viewport: { ...descriptor.viewport } }
}

/**
 * The capture override with `reserve` turned into the pixel size it names.
 *
 * The reserve is taken against the *resolved* output, so
 * `{ extends: 'iphone', aspect: '1:1', reserve: 1.5 }` records 1620x1620 and
 * not a 1.5x phone frame around a square delivery.
 */
function withReserve(
  overrides: DeviceOverrides,
  output: OutputSettings,
): DeviceOverrides['capture'] {
  const { reserve } = overrides
  if (reserve === undefined) return overrides.capture
  if (typeof reserve !== 'number' || !Number.isFinite(reserve) || reserve < 1) {
    throw new Error(
      `reserve must be a number of at least 1, got ${String(reserve)}. ` +
        '1 records exactly the output; 1.5 leaves room for a 1.5x push-in.',
    )
  }
  if (
    overrides.capture?.width !== undefined ||
    overrides.capture?.height !== undefined
  ) {
    throw new Error(
      `reserve ${String(reserve)} and capture ${String(overrides.capture.width ?? '?')}x` +
        `${String(overrides.capture.height ?? '?')} both set the capture area. ` +
        'Name one of them: reserve as a multiple of the output, or capture in pixels.',
    )
  }
  return { ...overrides.capture, ...scaledArea(output, reserve) }
}

function applyCaptureOverrides(
  base: CaptureSettings,
  override: DeviceOverrides['capture'],
): CaptureSettings {
  if (override === undefined) return base
  const merged: CaptureSettings = {
    fps: override.fps ?? base.fps,
    height: override.height ?? base.height,
    quality: override.quality ?? base.quality,
    status: 'decided',
    strategy: override.strategy ?? base.strategy,
    width: override.width ?? base.width,
  }
  validateCapture(merged)
  return merged
}

function applyOutputOverrides(
  base: { height: number; width: number },
  overrides: DeviceOverrides,
): OutputSettings {
  const fromAspect =
    overrides.aspect === undefined ? base : ASPECT_DIMENSIONS[overrides.aspect]
  const output: OutputSettings = {
    height: overrides.output?.height ?? fromAspect.height,
    quality: overrides.output?.quality ?? DEFAULT_OUTPUT_QUALITY,
    width: overrides.output?.width ?? fromAspect.width,
  }
  requirePositiveInteger(output.width, 'output.width')
  requirePositiveInteger(output.height, 'output.height')
  validateQuality(output.quality)
  return output
}

function applyPointerOverrides(
  descriptor: DeviceDescriptor,
  override: DeviceOverrides['pointer'],
): PointerSettings {
  // Every curated preset's pointer column follows the device's touch
  // capability — arrow on the three desktop profiles, touch on the eight
  // mobile ones — so it is derived, not tabulated a second time.
  const pointer: PointerSettings = {
    rippleColor: override?.rippleColor ?? DEFAULT_RIPPLE_COLOR,
    sizePx: override?.sizePx ?? DEFAULT_POINTER_SIZE_PX,
    style: override?.style ?? (descriptor.hasTouch ? 'touch' : 'arrow'),
  }
  requirePositiveInteger(pointer.sizePx, 'pointer.sizePx')
  return pointer
}

function validateCapture(capture: CaptureSettings): void {
  requirePositiveInteger(capture.width, 'capture.width')
  requirePositiveInteger(capture.height, 'capture.height')
  requirePositiveInteger(capture.fps, 'capture.fps')
  if (
    !Number.isInteger(capture.quality) ||
    capture.quality < 1 ||
    capture.quality > 100
  ) {
    throw new Error(
      `capture.quality must be an integer in 1..100, got ${String(capture.quality)}`,
    )
  }
}

function validateQuality(quality: OutputQuality): void {
  const { field, value } = qualityNumber(quality)
  if (!Number.isInteger(value) || value < 0 || value > 51) {
    throw new Error(
      `output.quality.${field} must be an integer in 0..51, got ${String(value)}`,
    )
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer, got ${String(value)}`)
  }
}

/**
 * The unknown-name failure required by MILESTONES.md M5. It always names the
 * eleven presets in full, and either the registry names that look like what
 * was asked for or — when nothing looks close — every registry name, so the
 * message never says "unknown" without saying what is known.
 */
function unknownDeviceMessage(name: string, registry: DeviceRegistry): string {
  const registryNames = listDeviceNames(registry)
  // Matching on words, not on the whole string: "iPhone 99" shares no
  // substring with any registry entry, yet the useful answer is every iPhone.
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((word) => word.length >= 3)
  const close = registryNames.filter((candidate) => {
    const lowerCandidate = candidate.toLowerCase()
    return words.some((word) => lowerCandidate.includes(word))
  })
  const offered = close.length > 0 ? close : registryNames
  const heading =
    close.length > 0
      ? `Close Playwright device names (${String(close.length)} of ${String(registryNames.length)})`
      : `Playwright device names (${String(registryNames.length)})`
  return (
    `Unknown device "${name}". ` +
    `Presets (${String(listPresetNames().length)}): ${listPresetNames().join(', ')}. ` +
    `${heading}: ${offered.join(', ')}.`
  )
}
