import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resolveDevice } from '../src/devices.js'
import {
  type FixtureServer,
  startFixtureServer,
} from '../src/fixture-server.js'
import type { FakeMedia } from '../src/fake-media.js'
import { recordSession } from '../src/session.js'

/**
 * What `fakeMedia` changes in the page, measured the way a video-call page
 * asks: a `getUserMedia` for camera and microphone, and the permission state
 * a page may read before it asks.
 *
 * Both halves matter. Without the export the recording browser has no media
 * at all, and Raven's pre-join card films a red "without camera and
 * microphone" banner (observed on staging, 2026-09-18). With it, the call has
 * to resolve with one live track of each kind — a synthetic picture and tone,
 * not a real device.
 *
 * The probe runs on the corpus server's loopback origin, not on `about:blank`
 * or a `data:` URL: there `navigator.mediaDevices` does not exist at all
 * (measured: `TypeError`), and a loopback origin is a secure context.
 */

type Reading = {
  audio: string[]
  camera: string
  error: string
  video: string[]
}

/** A string payload for the reason `docs/RECORDING-SCRIPTS.md` gives. */
const PROBE = `
  (async function () {
    var camera = 'unknown';
    try {
      camera = (await navigator.permissions.query({ name: 'camera' })).state;
    } catch (e) {}
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
      var reading = {
        audio: stream.getAudioTracks().map(function (t) { return t.readyState; }),
        camera: camera,
        error: '',
        video: stream.getVideoTracks().map(function (t) { return t.readyState; })
      };
      stream.getTracks().forEach(function (t) { t.stop(); });
      return reading;
    } catch (e) {
      return { audio: [], camera: camera, error: e.name, video: [] };
    }
  })()
`

const directories: string[] = []
let server: FixtureServer

beforeAll(async () => {
  server = await startFixtureServer()
})

afterAll(async () => {
  await server.close()
})

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function scratchDirectory(): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'featurecast-fake-media-'))
  directories.push(scratch)
  return scratch
}

async function evaluateIn<T>(
  fakeMedia: FakeMedia | undefined,
  payload: string,
  extra: { fixedTime?: string } = {},
): Promise<T> {
  const scratch = await scratchDirectory()
  const device = resolveDevice('desktop-wide')
  let reading: T | undefined
  await recordSession({
    capture: device.capture,
    device,
    outputDirectory: join(scratch, 'capture'),
    seed: 1,
    ...extra,
    ...(fakeMedia === undefined ? {} : { fakeMedia }),
    recording: async (page) => {
      await page.goto(`${server.origin}/`)
      reading = await page.evaluate(payload as unknown as () => Promise<T>)
    },
  })
  expect(reading).toBeDefined()
  return reading as T
}

async function probe(fakeMedia: boolean | undefined): Promise<Reading> {
  return evaluateIn<Reading>(fakeMedia, PROBE)
}

/** A 64x48 Y4M of three grey frames: a size no synthetic camera has. */
async function writeY4m(directory: string): Promise<string> {
  const width = 64
  const height = 48
  const frame = Buffer.concat([
    Buffer.from('FRAME\n'),
    Buffer.alloc(width * height, 128),
    Buffer.alloc((width / 2) * (height / 2) * 2, 128),
  ])
  const file = join(directory, 'face.y4m')
  await writeFile(
    file,
    Buffer.concat([
      Buffer.from(
        `YUV4MPEG2 W${String(width)} H${String(height)} F30:1 Ip A1:1 C420jpeg\n`,
      ),
      frame,
      frame,
      frame,
    ]),
  )
  return file
}

/** One second of a 440 Hz tone, 16-bit mono PCM at 48 kHz. */
async function writeToneWav(directory: string): Promise<string> {
  const rate = 48_000
  const samples = rate
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16_000),
      i * 2,
    )
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  const file = join(directory, 'voice.wav')
  await writeFile(file, Buffer.concat([header, data]))
  return file
}

/**
 * Opens the microphone, then reads its level twice: shortly after opening
 * (before `startsAt`) and shortly after `startsAt`.
 */
function levelProbe(startsAt: number): string {
  return `
  (async function () {
    var wall = function () { return performance.timeOrigin + performance.now(); };
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var ac = new AudioContext();
    await ac.resume();
    var analyser = ac.createAnalyser();
    ac.createMediaStreamSource(stream).connect(analyser);
    var level = function () {
      var d = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(d);
      var sum = 0;
      for (var i = 0; i < d.length; i++) sum += d[i] * d[i];
      return Math.sqrt(sum / d.length);
    };
    await sleep(600);
    var before = level();
    var wait = ${String(startsAt)} + 700 - wall();
    if (wait > 0) await sleep(wait);
    var after = level();
    stream.getTracks().forEach(function (t) { t.stop(); });
    return { before: before, after: after, openedEarlyMs: ${String(startsAt)} - wall() };
  })()
`
}

describe('fakeMedia', () => {
  it(
    'gives the page a live synthetic camera and microphone',
    { timeout: 120_000 },
    async () => {
      const seen = await probe(true)
      expect(seen.error).toBe('')
      expect(seen.camera).toBe('granted')
      expect(seen.video).toEqual(['live'])
      expect(seen.audio).toEqual(['live'])
    },
  )

  it(
    'leaves a recording without it as it was: no media',
    { timeout: 120_000 },
    async () => {
      const seen = await probe(undefined)
      expect(seen.video).toEqual([])
      expect(seen.error).not.toBe('')
    },
  )

  it('plays a camera file as the camera', { timeout: 120_000 }, async () => {
    const camera = await writeY4m(await scratchDirectory())
    const size = await evaluateIn<{ height: number; width: number }>(
      { camera },
      `(async function () {
          var s = await navigator.mediaDevices.getUserMedia({ video: true });
          var t = s.getVideoTracks()[0].getSettings();
          s.getTracks().forEach(function (x) { x.stop(); });
          return { width: t.width, height: t.height };
        })()`,
    )
    expect(size).toEqual({ height: 48, width: 64 })
  })

  it(
    'keeps a microphone file silent until its wall-clock start, then plays it — under a pinned clock too',
    { timeout: 120_000 },
    async () => {
      const file = await writeToneWav(await scratchDirectory())
      // Far enough ahead to cover the browser launch and the page load.
      const startsAt = Date.now() + 12_000
      const seen = await evaluateIn<{ after: number; before: number }>(
        { microphone: { file, startsAt } },
        levelProbe(startsAt),
        // A pinned `Date` years away: the schedule must not read it.
        { fixedTime: '2020-01-01T00:00:00Z' },
      )
      expect(seen.before).toBeLessThan(0.01)
      expect(seen.after).toBeGreaterThan(0.1)
    },
  )
})
