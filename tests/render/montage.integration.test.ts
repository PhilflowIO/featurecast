import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { readVideoInfo } from '../../src/probe.js'
import {
  parseMontageArguments,
  runMontage,
} from '../../src/render/montage-cli.js'

/**
 * The filter graph, run for real.
 *
 * The unit tests check what the graph says; only ffmpeg can say whether it
 * parses, whether the overlay chain terminates, and whether the picture that
 * comes out is the size the layout promised. No browser is involved, so this
 * stays in the portable tier and is provable on any machine.
 */

const directories: string[] = []

afterAll(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

function ffmpeg(arguments_: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', arguments_, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with ${String(code)}`))
    })
  })
}

async function synthetic(
  path: string,
  width: number,
  height: number,
  seconds: number,
): Promise<void> {
  await ffmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${String(width)}x${String(height)}:rate=30:duration=${String(seconds)}`,
    '-c:v',
    'libx264',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    path,
  ])
}

describe('a montage ffmpeg actually renders', () => {
  it(
    'is the size the layout promised, as long as its shortest recording, and the same bytes twice',
    { timeout: 180_000 },
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'featurecast-montage-it-'))
      directories.push(scratch)
      const desktop = join(scratch, 'desktop.mp4')
      const tablet = join(scratch, 'tablet.mp4')
      const phone = join(scratch, 'phone.mp4')
      await synthetic(desktop, 640, 400, 2)
      await synthetic(tablet, 480, 360, 2)
      // The short one: every device has to end here.
      await synthetic(phone, 180, 320, 1)

      const first = join(scratch, 'first.mp4')
      const lines: string[] = []
      await runMontage(
        parseMontageArguments([
          desktop,
          tablet,
          phone,
          '--out',
          first,
          '--device',
          'monitor',
          '--device',
          'tablet',
          '--device',
          'phone',
          '--height',
          '480',
        ]),
        { write: (text) => lines.push(text) },
      )

      const info = await readVideoInfo(first)
      expect(info.durationSeconds).toBeGreaterThan(0.9)
      expect(info.durationSeconds).toBeLessThan(1.2)
      expect(info.width).toBeGreaterThan(info.height)
      expect(lines.join('')).toContain('1.00s cut off the end')

      const second = join(scratch, 'second.mp4')
      await runMontage(
        parseMontageArguments([
          desktop,
          tablet,
          phone,
          '--out',
          second,
          '--device',
          'monitor',
          '--device',
          'tablet',
          '--device',
          'phone',
          '--height',
          '480',
        ]),
        { write: () => undefined },
      )
      expect((await readFile(first)).equals(await readFile(second))).toBe(true)
    },
  )

  it('refuses a device list that does not match the videos', () => {
    expect(() =>
      parseMontageArguments([
        'a.mp4',
        'b.mp4',
        '--out',
        'o.mp4',
        '--device',
        'phone',
      ]),
    ).toThrow(/2 videos, 1 devices/)
  })

  it('refuses a device kind it cannot draw', () => {
    expect(() =>
      parseMontageArguments([
        'a.mp4',
        'b.mp4',
        '--out',
        'o.mp4',
        '--device',
        'phone',
        '--device',
        'watch',
      ]),
    ).toThrow(/not a device kind/)
  })
})
