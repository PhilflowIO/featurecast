import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { POINTER_STYLES, type PointerStyle } from './render/cursor.js'

/**
 * Which device a capture was recorded on, written beside its frames.
 *
 * The render stage runs without a browser and without the device layer: its
 * inputs are the files a capture left behind, so that a different zoom or a
 * different pointer size is a re-run of `pnpm render` and not of the script.
 * That design has one consequence the renderer paid for: anything the device
 * knew and the files did not say was lost by the time the video was drawn.
 * The pointer was the case that showed it (featurecast#155) — the device layer
 * resolves every touch preset to `pointer.style: 'touch'`, the renderer never
 * saw that and guessed from the log instead, and a phone recording that only
 * swiped got a desktop arrow.
 *
 * A file of its own rather than a field in `timestamps.json`: that manifest is
 * written by the screencast, which records a rectangle and knows nothing about
 * the device filming it, and it sits beside `browser.json`, the same kind of
 * statement about a different part of the setup.
 *
 * Only the pointer *style* is carried. The device layer's `sizePx` and
 * `rippleColor` are unmeasured placeholders (see `DEFAULT_POINTER_SIZE_PX`),
 * and the renderer's own sizes per kind are the measured ones; carrying the
 * placeholders across would silently change every render's pointer size.
 */
export const RECORDED_DEVICE_FILE_NAME = 'device.json'

export const RECORDED_DEVICE_VERSION = 1

export type RecordedDevice = {
  /** The name the device was asked for: a curated preset or a Playwright name. */
  name: string
  pointer: { style: PointerStyle }
  version: typeof RECORDED_DEVICE_VERSION
}

/**
 * The part of a resolved device this file describes. Structural, so the
 * writer does not import the device layer; `ResolvedDevice` satisfies it.
 */
export type RecordingDevice = {
  playwrightName: string
  pointer: { style: PointerStyle }
  preset: string | null
}

export async function writeRecordedDevice(
  directory: string,
  device: RecordingDevice,
): Promise<void> {
  const recorded: RecordedDevice = {
    name: device.preset ?? device.playwrightName,
    pointer: { style: device.pointer.style },
    version: RECORDED_DEVICE_VERSION,
  }
  await writeFile(
    join(directory, RECORDED_DEVICE_FILE_NAME),
    `${JSON.stringify(recorded, null, 2)}\n`,
  )
}

/**
 * The pointer style the capture was recorded with, or `null` for a capture
 * made before this file existed.
 *
 * Absent is a legitimate answer, a broken file is not: a `device.json` that
 * does not parse, or names a style this build does not know, is refused with
 * the path in the message. Falling back to a guess there would render a phone
 * recording with an arrow again and say nothing — the exact failure this file
 * was introduced to end.
 */
export async function readRecordedPointerStyle(
  directory: string,
): Promise<PointerStyle | null> {
  const path = join(directory, RECORDED_DEVICE_FILE_NAME)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const record = (
    typeof parsed === 'object' && parsed !== null ? parsed : {}
  ) as Record<string, unknown>
  if (record['version'] !== RECORDED_DEVICE_VERSION) {
    throw new Error(
      `${path}: unsupported version ${String(record['version'])} ` +
        `(this build reads version ${String(RECORDED_DEVICE_VERSION)})`,
    )
  }
  const pointer = record['pointer']
  const style =
    typeof pointer === 'object' && pointer !== null
      ? (pointer as Record<string, unknown>)['style']
      : undefined
  if (!POINTER_STYLES.includes(style as PointerStyle)) {
    throw new Error(
      `${path}: pointer.style must be one of ${POINTER_STYLES.join(', ')}, ` +
        `got ${JSON.stringify(style) ?? 'nothing'}`,
    )
  }
  return style as PointerStyle
}
