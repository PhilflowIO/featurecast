import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveDevice } from '../src/devices.js'
import {
  parseEventLog,
  parseEventTimes,
  toTimedEvents,
} from '../src/render/events.js'
import { recordSession } from '../src/session.js'

/**
 * The acceptance of issue #9: an interaction in the log has to sit on the
 * frame that shows it, and it has to keep sitting there after the recording
 * has spent real time doing something the log knows nothing about.
 *
 * The second half is the whole point. The log used to carry a *counter* of
 * planned 60 Hz slots, which advances for pointer motion, typing and `hold`
 * and stands still for a page load, a settle wait or a click's round trip. A
 * single interaction therefore looked fine; the drift only appeared after an
 * unplanned wait, and it never came back. Measured on one earlier recording it
 * reached 42.6 s over 62 s of capture — so a test that clicks once and checks
 * the offset would have passed all along while the defect sat next to it.
 *
 * Here the script clicks, then waits three seconds through the raw page — no
 * `demo.hold`, nothing the log records — and clicks again. Both clicks are
 * measured against the frame their own repaint produced, and the two offsets
 * have to agree. Under the counter the second would be about three seconds
 * late.
 *
 * The visible change is a dense pattern rather than a colour, because the
 * signal used here is the JPEG's size: a page of fine detail encodes several
 * times larger than the blank one it replaces, which is decoder-free and needs
 * nothing this repository does not already have. And the page is otherwise
 * completely still — the screencast carries no cursor, so a pointer crossing a
 * page that never repaints produces no frames at all, and every frame that
 * exists after a click is a frame that click caused.
 */

const FRAME_MS = 1000 / 60
/** How much bigger a patterned frame is than a blank one, at minimum. */
const PATTERN_SIZE_FACTOR = 2

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-clock-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

const PAGE_HTML =
  '<!doctype html><html><body style="margin:0;background:#fff">' +
  '<div id="pattern" style="position:absolute;inset:0;display:none;' +
  'background:repeating-linear-gradient(45deg,#000 0 3px,#fff 3px 6px)"></div>' +
  '<button id="flip" style="position:absolute;left:300px;top:200px;' +
  'width:160px;height:60px;font:16px sans-serif" ' +
  "onclick=\"document.getElementById('pattern').style.display=" +
  "document.getElementById('pattern').style.display==='none'?'block':'none'\">" +
  'Flip</button></body></html>'
const PAGE_URL = `data:text/html,${encodeURIComponent(PAGE_HTML)}`

type Manifest = {
  frames: ReadonlyArray<{ file: string; timestamp: number }>
  session: { duration: number; startedAt: number }
}

describe('one clock for the frames and the events', () => {
  it(
    'puts both clicks on their own repaint, with three unlogged seconds in between',
    { timeout: 180_000 },
    async () => {
      // `captureScreencast` insists on creating the output directory itself,
      // so it gets a name inside the scratch directory rather than the scratch
      // directory.
      const directory = join(await temporaryDirectory(), 'capture')
      const device = resolveDevice('desktop-wide')
      await recordSession({
        capture: device.capture,
        device,
        outputDirectory: directory,
        seed: 3,
        recording: async (page, demo) => {
          await page.goto(PAGE_URL)
          await demo.click('#flip')
          // Real time the log is blind to, on purpose: `waitForTimeout` on the
          // raw page is not an event and does not advance the tick counter.
          await page.waitForTimeout(3000)
          await demo.click('#flip')
          // The second flip's repaint has to reach the capture before the
          // screencast stops, or the frame that proves it never exists.
          await page.waitForTimeout(800)
        },
      })

      const manifest = JSON.parse(
        await readFile(join(directory, 'timestamps.json'), 'utf8'),
      ) as Manifest
      const events = toTimedEvents(
        parseEventLog(await readFile(join(directory, 'events.jsonl'), 'utf8')),
        parseEventTimes(
          await readFile(join(directory, 'event-times.jsonl'), 'utf8'),
        ),
        manifest.session.startedAt,
      )

      const clicks = events
        .filter(({ event }) => event.type === 'click')
        .map(({ timeMs }) => timeMs)
      expect(clicks).toHaveLength(2)

      const sizes = await Promise.all(
        manifest.frames.map(
          async (frame) =>
            (await stat(join(directory, 'frames', frame.file))).size,
        ),
      )
      const blank = Math.min(...sizes)
      // Every frame that is mostly pattern, in capture time. There are exactly
      // two transitions on this page — into the pattern and out of it — so the
      // repaint each click caused is the first frame of each run.
      const patterned = manifest.frames
        .map((frame, index) => ({
          patterned: sizes[index]! > blank * PATTERN_SIZE_FACTOR,
          timeMs: frame.timestamp - manifest.session.startedAt,
        }))
        .filter((frame) => frame.patterned)
      expect(patterned.length).toBeGreaterThan(0)

      const firstPatterned = patterned[0]!.timeMs
      // The frame after the last patterned one is the second flip landing.
      const lastPatterned = patterned[patterned.length - 1]!.timeMs
      const afterPattern = manifest.frames
        .map((frame) => frame.timestamp - manifest.session.startedAt)
        .find((timeMs) => timeMs > lastPatterned)
      expect(afterPattern).toBeDefined()
      if (afterPattern === undefined) return

      const first = clicks[0]!
      const second = clicks[1]!
      const firstLatency = firstPatterned - first
      const secondLatency = afterPattern - second

      // A click is logged the moment it is dispatched and the frame is stamped
      // when the browser process receives the resulting picture, so a positive
      // latency of a few frames is the truth of the machine, not an error.
      expect(firstLatency).toBeGreaterThan(0)
      expect(secondLatency).toBeGreaterThan(0)
      expect(firstLatency).toBeLessThan(500)
      expect(secondLatency).toBeLessThan(500)

      // The defect #9 closes, stated as a number: three seconds of unlogged
      // waiting must not move the second click relative to its own frame.
      expect(Math.abs(secondLatency - firstLatency)).toBeLessThan(4 * FRAME_MS)

      // And the proof that the assertion above can fail — measured on this
      // same recording, not argued. Reading the two clicks off the log's tick
      // counter instead of the clock reproduces the old behaviour, and the
      // difference it produces is the three seconds the counter slept through.
      // Without this, a clock that happened to be broken in some other way
      // could pass the bound above by accident.
      const ticks = parseEventLog(
        await readFile(join(directory, 'events.jsonl'), 'utf8'),
      )
        .filter((event) => event.type === 'click')
        .map((event) => ((event as { tick: number }).tick * 1000) / 60)
      expect(ticks).toHaveLength(2)
      const countedFirst = firstPatterned - ticks[0]!
      const countedSecond = afterPattern - ticks[1]!
      expect(Math.abs(countedSecond - countedFirst)).toBeGreaterThan(2500)
    },
  )
})
