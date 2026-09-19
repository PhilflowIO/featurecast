import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  FAKE_MEDIA_LAUNCH_ARGS,
  fakeMediaLaunchArgs,
  microphoneInitScript,
  readFakeMedia,
} from '../src/fake-media.js'

let directory: string
let face: string
let voice: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'featurecast-fake-media-unit-'))
  face = join(directory, 'face.y4m')
  voice = join(directory, 'voice.wav')
  await writeFile(face, 'YUV4MPEG2')
  await writeFile(voice, 'RIFF')
})

afterAll(async () => {
  await rm(directory, { force: true, recursive: true })
})

describe('readFakeMedia', () => {
  it('passes booleans through unchanged', () => {
    expect(readFakeMedia(true, 's.ts')).toBe(true)
    expect(readFakeMedia(false, 's.ts')).toBe(false)
  })

  it('reads a camera and a scheduled microphone, ISO or epoch', () => {
    expect(
      readFakeMedia(
        {
          camera: face,
          microphone: { file: voice, startsAt: '2026-09-18T21:00:00Z' },
        },
        's.ts',
      ),
    ).toEqual({
      camera: face,
      microphone: { file: voice, startsAt: Date.parse('2026-09-18T21:00:00Z') },
    })
    expect(readFakeMedia({ microphone: voice }, 's.ts')).toEqual({
      microphone: { file: voice },
    })
    expect(
      readFakeMedia(
        { microphone: { file: voice, startsAt: 1_700_000_000_000 } },
        's.ts',
      ),
    ).toEqual({ microphone: { file: voice, startsAt: 1_700_000_000_000 } })
  })

  it('refuses what only looks right, naming the file', () => {
    expect(() => readFakeMedia('false', 's.ts')).toThrow(
      /"s\.ts".*fakeMedia.*a boolean/s,
    )
    expect(() => readFakeMedia({}, 's.ts')).toThrow(/names no source at all/)
    expect(() => readFakeMedia({ camera: face, mic: voice }, 's.ts')).toThrow(
      /unknown field `mic`/,
    )
    expect(() => readFakeMedia({ camera: voice }, 's.ts')).toThrow(
      /\.y4m and \.mjpeg/,
    )
    expect(() =>
      readFakeMedia({ camera: join(directory, 'x.y4m') }, 's.ts'),
    ).toThrow(/does not exist/)
    expect(() =>
      readFakeMedia({ microphone: { file: voice, startsAt: 'soon' } }, 's.ts'),
    ).toThrow(/startsAt/)
  })
})

describe('fakeMediaLaunchArgs', () => {
  it('adds nothing without fake media and the two switches for `true`', () => {
    expect(fakeMediaLaunchArgs(undefined)).toEqual([])
    expect(fakeMediaLaunchArgs(false)).toEqual([])
    expect(fakeMediaLaunchArgs(true)).toEqual([...FAKE_MEDIA_LAUNCH_ARGS])
  })

  it('feeds the camera file by absolute path, and lets a voice play without a gesture', () => {
    expect(
      fakeMediaLaunchArgs({ camera: face, microphone: { file: voice } }),
    ).toEqual([
      ...FAKE_MEDIA_LAUNCH_ARGS,
      `--use-file-for-fake-video-capture=${resolve(face)}`,
      '--autoplay-policy=no-user-gesture-required',
    ])
  })
})

describe('microphoneInitScript', () => {
  it('anchors on the real wall clock, never on a pinnable Date', () => {
    const script = microphoneInitScript(123)
    expect(script).toContain('var anchor = 123;')
    expect(script).toContain('performance.timeOrigin + performance.now()')
    expect(script).not.toContain('Date.now')
    expect(microphoneInitScript(undefined)).toContain('var anchor = null;')
  })
})

describe('the screen a script asks to share (#190)', () => {
  it('takes a video file', async () => {
    const datei = join(directory, 'geteilt.mp4')
    await writeFile(datei, Buffer.alloc(8))
    expect(readFakeMedia({ screen: datei }, 'demo/x.ts')).toEqual({
      screen: datei,
    })
  })

  it('refuses a file that is not a video', () => {
    // The mistake is caught where it is made: a <video> served a wav never
    // fires `playing`, so the share would hang instead of failing.
    expect(() => readFakeMedia({ screen: voice }, 'demo/x.ts')).toThrow(/\.mp4/)
  })

  it('refuses a screen file that is not there', () => {
    expect(() =>
      readFakeMedia({ screen: join(directory, 'fehlt.mp4') }, 'demo/x.ts'),
    ).toThrow(/does not exist/)
  })

  it('still refuses a field nobody knows', () => {
    expect(() => readFakeMedia({ bildschirm: 'x.mp4' }, 'demo/x.ts')).toThrow(
      /unknown field/,
    )
  })
})
