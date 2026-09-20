import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

/**
 * The calibration of `tools/cadence/cadence.mjs`.
 *
 * The instrument answers "how many written frames carry no new picture", and
 * every comparison against another tool rests on it. An instrument whose
 * needle has never been seen to move proves nothing, so each case below is a
 * clip whose answer is known before it is measured.
 *
 * The last two cases are why ffmpeg's own `mpdecimate` was rejected: at its
 * defaults it calls a frame in which only a cursor-sized area moved a repeat,
 * and a screen recording is mostly exactly that.
 */

const TOOL = fileURLToPath(
  new URL('../tools/cadence/cadence.mjs', import.meta.url),
)

const directories: string[] = []

afterAll(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

function run(command: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`${command} exited with ${String(code)}`))
    })
  })
}

async function clip(path: string, filter: string): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    filter,
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    path,
  ])
}

/** The percentage the tool reports, parsed out of its one output line. */
async function repeatShare(path: string): Promise<number> {
  const output = await run('node', [TOOL, path])
  const match = /\(([\d.]+)%\)/.exec(output)
  if (match?.[1] === undefined) {
    throw new Error(`cadence printed no share: ${output}`)
  }
  return Number(match[1])
}

/**
 * A cursor-sized dot on black, moving twelve pixels every frame.
 *
 * Drawn with `overlay` rather than `drawbox`: this build evaluates a
 * `drawbox` position once while configuring the filter, where the frame
 * number does not exist yet, and refuses the expression outright.
 */
function dotGraph(rate: number): string {
  return (
    `color=c=black:s=960x540:r=${String(rate)}:d=2[bg];` +
    `color=c=white:s=12x18:r=${String(rate)}:d=2[dot];` +
    '[bg][dot]overlay=x=12*(n-40*floor(n/40)):y=200'
  )
}

describe('the cadence instrument, against clips with a known answer', () => {
  it(
    'reads full-frame motion, a halved rate, a still, and cursor-sized motion',
    { timeout: 300_000 },
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'featurecast-cadence-'))
      directories.push(scratch)

      const moving = join(scratch, 'moving-60.mp4')
      const halved = join(scratch, 'moving-30-in-60.mp4')
      const still = join(scratch, 'still-60.mp4')
      const dot = join(scratch, 'dot-60.mp4')
      const dotHalved = join(scratch, 'dot-30-in-60.mp4')

      await clip(moving, 'testsrc2=size=960x540:rate=60:duration=2')
      // Thirty distinct pictures written into a sixty-frame container: every
      // second frame is a genuine repeat, and the header still says 60.
      await clip(halved, 'testsrc2=size=960x540:rate=30:duration=2,fps=60')
      await clip(still, 'color=c=gray:s=960x540:rate=60:duration=2')
      await clip(dot, dotGraph(60))
      await clip(dotHalved, `${dotGraph(30)},fps=60`)

      expect(await repeatShare(moving)).toBeLessThan(2)
      expect(await repeatShare(halved)).toBeGreaterThan(45)
      expect(await repeatShare(halved)).toBeLessThan(55)
      expect(await repeatShare(still)).toBeGreaterThan(98)
      // Only 216 of 518,400 pixels move here. An instrument tuned to
      // "most of the picture changed" calls this a still; this one must not.
      expect(await repeatShare(dot)).toBeLessThan(2)
      expect(await repeatShare(dotHalved)).toBeGreaterThan(45)
      expect(await repeatShare(dotHalved)).toBeLessThan(55)
    },
  )
})
