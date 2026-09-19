import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

import { BUNDLE_CHANNEL } from '../src/browser.js'
import { FAKE_MEDIA_LAUNCH_ARGS, installFakeScreen } from '../src/fake-media.js'
import { startFixtureServer } from '../src/fixture-server.js'

/**
 * A recording can film a screen share (featurecast#190).
 *
 * WHY THIS IS NOT A CHROMIUM SWITCH. In the headless recording browser
 * `getDisplayMedia` does return a live track — measured 1280x720@30 — but with
 * `--use-fake-device-for-media-stream` its source is the SYNTHETIC screen,
 * labelled `screen:-3:0` under both `--auto-select-tab-capture-source-by-title`
 * and `--auto-select-desktop-capture-source`. A test pattern, not a tab. So the
 * share is fed from a file, the way the microphone already is.
 *
 * The assertions read the track and then a PIXEL, because a track that exists
 * and a picture that arrives are two different claims: a `<video>` served the
 * wrong content type never fires `playing`, and a stream captured from a
 * never-painted element is a black rectangle that every count-based check
 * passes.
 */

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

/**
 * A one-colour video, written by the browser itself with `MediaRecorder`, so
 * the test needs neither ffmpeg nor a fixture checked into the repository —
 * and so the colour it later looks for is one it chose.
 */
async function farbvideo(rot: number, gruen: number, blau: number) {
  const browser = await chromium.launch({
    args: [...FAKE_MEDIA_LAUNCH_ARGS],
    channel: BUNDLE_CHANNEL,
    headless: true,
  })
  try {
    const page = await browser.newPage()
    const base64 = await page.evaluate(
      async ([r, g, b]) => {
        const canvas = document.createElement('canvas')
        canvas.width = 320
        canvas.height = 180
        const ctx = canvas.getContext('2d')
        if (ctx === null) throw new Error('no 2d context')
        const malen = () => {
          ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
          ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
        malen()
        const timer = setInterval(malen, 50)
        const stream = canvas.captureStream(20)
        const recorder = new MediaRecorder(stream, {
          mimeType: 'video/webm',
        })
        const stuecke: Blob[] = []
        recorder.ondataavailable = (event) => stuecke.push(event.data)
        recorder.start()
        await new Promise((fertig) => setTimeout(fertig, 1200))
        const blob = await new Promise<Blob>((fertig) => {
          recorder.onstop = () =>
            fertig(new Blob(stuecke, { type: 'video/webm' }))
          recorder.stop()
        })
        clearInterval(timer)
        const puffer = await blob.arrayBuffer()
        let roh = ''
        const bytes = new Uint8Array(puffer)
        for (const byte of bytes) roh += String.fromCharCode(byte)
        return btoa(roh)
      },
      [rot, gruen, blau] as const,
    )
    const verzeichnis = await mkdtemp(join(tmpdir(), 'featurecast-screen-'))
    directories.push(verzeichnis)
    const datei = join(verzeichnis, 'geteilt.webm')
    await writeFile(datei, Buffer.from(base64, 'base64'))
    return datei
  } finally {
    await browser.close()
  }
}

describe('a shared screen fed from a file', () => {
  it(
    'hands the page a live track whose picture is the file',
    { timeout: 120_000 },
    async () => {
      // A distinctive colour, so a black stream — the failure this test is
      // really about — cannot pass for a picture.
      const datei = await farbvideo(0, 128, 255)
      const server = await startFixtureServer()
      const browser = await chromium.launch({
        args: [
          ...FAKE_MEDIA_LAUNCH_ARGS,
          '--autoplay-policy=no-user-gesture-required',
        ],
        channel: BUNDLE_CHANNEL,
        headless: true,
      })
      try {
        const context = await browser.newContext()
        await installFakeScreen(context, datei)
        const page = await context.newPage()
        await page.goto(server.origin)
        const gemessen = await page.evaluate(async () => {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
          })
          const track = stream.getVideoTracks()[0]
          if (track === undefined) throw new Error('no video track')
          const einstellungen = track.getSettings()
          const video = document.createElement('video')
          video.srcObject = stream
          video.muted = true
          await video.play()
          await new Promise((fertig) => setTimeout(fertig, 700))
          const canvas = document.createElement('canvas')
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          const ctx = canvas.getContext('2d')
          if (ctx === null) throw new Error('no 2d context')
          ctx.drawImage(video, 0, 0)
          const [r, g, b] = ctx.getImageData(
            Math.floor(canvas.width / 2),
            Math.floor(canvas.height / 2),
            1,
            1,
          ).data
          return {
            b,
            breite: einstellungen.width ?? 0,
            g,
            label: track.label,
            r,
            zustand: track.readyState,
          }
        })
        expect(gemessen.zustand).toBe('live')
        expect(gemessen.breite).toBeGreaterThan(0)
        // Not Chromium's synthetic screen, which is what every launch switch
        // hands back instead.
        expect(gemessen.label).not.toContain('screen:')
        // The picture is the file's, within the slack a video codec costs.
        expect(gemessen.r).toBeLessThan(60)
        expect(gemessen.g).toBeGreaterThan(90)
        expect(gemessen.b).toBeGreaterThan(200)
      } finally {
        await browser.close()
        await server.close()
      }
    },
  )

  it(
    'refuses a file the browser cannot play as video',
    { timeout: 60_000 },
    async () => {
      const verzeichnis = await mkdtemp(join(tmpdir(), 'featurecast-screen-'))
      directories.push(verzeichnis)
      const datei = join(verzeichnis, 'stimme.wav')
      await writeFile(datei, Buffer.alloc(64))
      const browser = await chromium.launch({
        channel: BUNDLE_CHANNEL,
        headless: true,
      })
      try {
        const context = await browser.newContext()
        await expect(installFakeScreen(context, datei)).rejects.toThrow(
          /has to be a video/,
        )
      } finally {
        await browser.close()
      }
    },
  )
})
