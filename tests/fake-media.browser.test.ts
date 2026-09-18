import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resolveDevice } from '../src/devices.js'
import {
  type FixtureServer,
  startFixtureServer,
} from '../src/fixture-server.js'
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

async function probe(fakeMedia: boolean | undefined): Promise<Reading> {
  const scratch = await mkdtemp(join(tmpdir(), 'featurecast-fake-media-'))
  directories.push(scratch)
  const device = resolveDevice('desktop-wide')
  let reading: Reading | undefined
  await recordSession({
    capture: device.capture,
    device,
    outputDirectory: join(scratch, 'capture'),
    seed: 1,
    ...(fakeMedia === undefined ? {} : { fakeMedia }),
    recording: async (page) => {
      await page.goto(`${server.origin}/`)
      reading = await page.evaluate(PROBE as unknown as () => Promise<Reading>)
    },
  })
  expect(reading).toBeDefined()
  return reading as Reading
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
})
