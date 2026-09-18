import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { resolveDevice } from '../src/devices.js'
import {
  readRecordedPointerStyle,
  RECORDED_DEVICE_FILE_NAME,
  writeRecordedDevice,
} from '../src/recorded-device.js'
import {
  serializeEvent,
  serializeEventTimes,
  type RecordEvent,
} from '../src/record.js'
import { renderRecording } from '../src/render/render.js'

/**
 * The device's pointer, carried from the recording to the render.
 *
 * featurecast#155: the device layer resolved every phone preset to a touch
 * pointer, the render stage never saw it and guessed from the event log, and a
 * phone recording that only swiped came out with a desktop arrow. These tests
 * pin the carrier — the file a capture writes and `pnpm render` reads — and
 * the render's answer with and without it.
 */
const scratchDirectories: string[] = []

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  scratchDirectories.push(directory)
  return directory
}

afterAll(async () => {
  await Promise.all(
    scratchDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

const STARTED_AT = 1_700_000_000_000
const SOURCE = { height: 2880, width: 1620 }
const FRAME_COUNT = 60

/**
 * A capture directory of the shape a phone recording that only swipes leaves
 * behind: a pointer track, a scroll, no tap. Frames are listed but never
 * decoded — every render below is a dry run, which reads the manifest and the
 * log and writes the decisions.
 */
async function swipeOnlyCapture(): Promise<string> {
  const directory = await scratch('featurecast-swipe-')
  const frameMs = 1000 / 60
  await writeFile(
    join(directory, 'timestamps.json'),
    JSON.stringify({
      captureSize: SOURCE,
      frames: Array.from({ length: FRAME_COUNT }, (_, index) => ({
        file: `frame-${String(index).padStart(6, '0')}.jpg`,
        timestamp: STARTED_AT + index * frameMs,
        viewport: SOURCE,
      })),
      session: {
        duration: FRAME_COUNT * frameMs,
        endedAt: STARTED_AT + FRAME_COUNT * frameMs,
        startedAt: STARTED_AT,
      },
      version: 1,
    }),
    'utf8',
  )
  const events: RecordEvent[] = [
    { type: 'header', version: 1, fps: 60, seed: 1 },
  ]
  for (let tick = 0; tick < FRAME_COUNT; tick += 1) {
    events.push({ type: 'pointer', tick, x: 810, y: 2200 - tick * 12 })
  }
  events.push({ type: 'scroll', tick: 30, deltaX: 0, deltaY: 600 })
  const logged = events.filter((event) => event.type !== 'header')
  await writeFile(
    join(directory, 'events.jsonl'),
    `${events.map(serializeEvent).join('\n')}\n`,
    'utf8',
  )
  await writeFile(
    join(directory, 'event-times.jsonl'),
    serializeEventTimes(
      logged,
      logged.map((event) => STARTED_AT + (event.tick * 1000) / 60),
    ),
    'utf8',
  )
  return directory
}

async function drawnKinds(capture: string): Promise<Set<string | null>> {
  const out = await scratch('featurecast-swipe-out-')
  const result = await renderRecording(capture, out, { dryRun: true })
  return new Set(
    result.plan.formats
      .flatMap((format) => format.frames)
      .map((frame) => frame.cursor?.kind ?? null),
  )
}

describe('the capture names the device it was recorded on', () => {
  it('writes the touch style for a phone and the arrow for a desktop', async () => {
    const phone = await scratch('featurecast-device-')
    const desktop = await scratch('featurecast-device-')
    await writeRecordedDevice(phone, resolveDevice('iphone'))
    await writeRecordedDevice(desktop, resolveDevice('desktop'))
    expect(await readRecordedPointerStyle(phone)).toBe('touch')
    expect(await readRecordedPointerStyle(desktop)).toBe('arrow')
    expect(
      JSON.parse(
        await readFile(join(phone, RECORDED_DEVICE_FILE_NAME), 'utf8'),
      ),
    ).toEqual({ name: 'iphone', pointer: { style: 'touch' }, version: 1 })
  })

  it('carries an overridden style, including none', async () => {
    const directory = await scratch('featurecast-device-')
    await writeRecordedDevice(
      directory,
      resolveDevice({ extends: 'iphone', pointer: { style: 'none' } }),
    )
    expect(await readRecordedPointerStyle(directory)).toBe('none')
  })

  it('answers null for a capture made before the file existed', async () => {
    expect(
      await readRecordedPointerStyle(await scratch('featurecast-device-')),
    ).toBeNull()
  })

  it('refuses a broken record instead of guessing past it', async () => {
    const directory = await scratch('featurecast-device-')
    const path = join(directory, RECORDED_DEVICE_FILE_NAME)
    await writeFile(path, '{"version":1,"pointer":{"style":"finger"}}')
    await expect(readRecordedPointerStyle(directory)).rejects.toThrow(
      /pointer\.style must be one of arrow, none, touch/,
    )
    await writeFile(path, '{"version":2,"pointer":{"style":"touch"}}')
    await expect(readRecordedPointerStyle(directory)).rejects.toThrow(
      /unsupported version 2/,
    )
    await writeFile(path, 'not json')
    await expect(readRecordedPointerStyle(directory)).rejects.toThrow(
      /is not JSON/,
    )
  })
})

describe('pnpm render draws the recording device’s pointer', () => {
  it('draws the touch dot for a swipe-only phone recording', async () => {
    const capture = await swipeOnlyCapture()
    await writeRecordedDevice(capture, resolveDevice('iphone'))
    expect(await drawnKinds(capture)).toEqual(new Set(['touch']))
  })

  it('draws nothing for a device whose pointer is none', async () => {
    const capture = await swipeOnlyCapture()
    await writeRecordedDevice(
      capture,
      resolveDevice({ extends: 'iphone', pointer: { style: 'none' } }),
    )
    expect(await drawnKinds(capture)).toEqual(new Set([null]))
  })

  it('keeps the arrow for a desktop recording', async () => {
    const capture = await swipeOnlyCapture()
    await writeRecordedDevice(capture, resolveDevice('desktop-wide'))
    expect(await drawnKinds(capture)).toEqual(new Set(['arrow']))
  })

  it('falls back to reading the log for a capture without the record', async () => {
    // What every capture made before featurecast#155 looks like. The guess
    // is unchanged, so such a recording keeps its arrow until it is recorded
    // again or given the device record it was made without: nothing else in
    // the directory says which device filmed it.
    const capture = await swipeOnlyCapture()
    expect(await drawnKinds(capture)).toEqual(new Set(['arrow']))
  })
})
