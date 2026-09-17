import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, describe, expect, it } from 'vitest'

import {
  buildComparePlan,
  compareOutputSize,
  type CompareSide,
} from '../src/compare.js'
import { parseVideoInfo, readVideoInfo } from '../src/probe.js'
import { buildFfprobeArguments } from '../src/probe.js'

const run = promisify(execFile)

/**
 * The band, measured rather than computed.
 *
 * Every other test in this file's sibling reads the filter graph, which is a
 * statement of intent — and intent is exactly what was wrong before: the
 * command *said* it labelled each side and it did, straight onto the picture,
 * over the filmed application's own header. The only check that can tell a
 * caption in a band from a caption on the video without a human looking is
 * the finished file's own height, read back out of it. So this one encodes
 * two real clips and asks ffprobe.
 */
const scratchDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    scratchDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-compare-'))
  scratchDirectories.push(directory)
  return directory
}

/** A throwaway clip of a given size and length, from ffmpeg's own generator. */
async function testClip(
  path: string,
  size: string,
  seconds: number,
): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${size}:rate=30:duration=${String(seconds)}`,
    '-c:v',
    'libx264',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p',
    path,
  ])
}

describe('a real comparison encode', () => {
  it('comes out one band taller than the material, not the same height', async () => {
    const directory = await scratch()
    const left = join(directory, 'left.mp4')
    const right = join(directory, 'right.mp4')
    const out = join(directory, 'comparison.mp4')
    // Different sizes and different lengths: the two things the command
    // promises not to get silently wrong.
    await testClip(left, '640x360', 2)
    await testClip(right, '320x180', 1)

    const probes: [
      Awaited<ReturnType<typeof readVideoInfo>>,
      Awaited<ReturnType<typeof readVideoInfo>>,
    ] = [await readVideoInfo(left), await readVideoInfo(right)]
    const sides: readonly [CompareSide, CompareSide] = [
      { label: 'rendered at device resolution', path: left },
      { label: 'upscaled from a smaller capture', path: right },
    ]
    const expected = compareOutputSize(sides, probes)
    const plan = buildComparePlan(sides, probes, out, { fps: 30, slow: 2 })
    await run(plan.command, plan.arguments)

    const { stdout } = await run('ffprobe', buildFfprobeArguments(out))
    const finished = parseVideoInfo(stdout, out)

    expect(finished.height).toBe(expected.height)
    expect(finished.width).toBe(expected.width)
    // The claim, stated as the inequality that the old behaviour failed: the
    // frame is taller than the pictures inside it, so nothing is under the
    // caption.
    expect(finished.height).toBeGreaterThan(probes[0].height)
    expect(expected.band).toBeGreaterThan(0)
    // Both sides end together: 2 seconds of material at half speed.
    expect(finished.durationSeconds).toBeGreaterThan(3.8)
  }, 60_000)
})
