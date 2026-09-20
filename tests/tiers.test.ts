import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The split between the two tiers, checked instead of trusted.
 *
 * `*.gpu.test.ts` records, and a recording is only worth anything on real
 * graphics hardware (src/renderer.ts). The portable tier runs everywhere,
 * including a hosted CI runner with no GPU. The danger is not that the split
 * is wrong today — it is that the next recording test is written with the
 * name everybody else uses, lands in the portable tier, and is then either
 * red on every runner or, worse, waved through by the software-renderer
 * switch and green about nothing.
 *
 * So the criterion lives here and is enforced from the tier that always
 * runs. `*.browser.test.ts` is deliberately NOT the criterion: nine of those
 * files start Chromium without ever recording and pass on a GPU-less host.
 * What matters is whether a file reaches `recordSession`.
 */

const TESTS_DIRECTORY = dirname(fileURLToPath(import.meta.url))

const RECORDING_CALL = /\b(recordSession|assertHardwareRenderer)\s*\(/

/**
 * `tests/renderer.test.ts` is the unit test of the guard itself: it calls
 * `assertHardwareRenderer` with hand-built renderer info and never launches
 * a browser, so it needs no GPU. It owns the software-renderer switch for
 * the two cases whose subject that switch is, and restores it afterwards.
 */
const NOT_A_RECORDING_TEST = new Set(['renderer.test.ts'])

async function testFiles(): Promise<string[]> {
  const entries = await readdir(TESTS_DIRECTORY, {
    recursive: true,
    withFileTypes: true,
  })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) =>
      relative(TESTS_DIRECTORY, join(entry.parentPath, entry.name)),
    )
    .sort()
}

async function records(file: string): Promise<boolean> {
  return RECORDING_CALL.test(
    await readFile(join(TESTS_DIRECTORY, file), 'utf8'),
  )
}

describe('test tiers', () => {
  it('keeps every recording test out of the portable tier', async () => {
    const misplaced: string[] = []
    for (const file of await testFiles()) {
      if (file.endsWith('.gpu.test.ts') || NOT_A_RECORDING_TEST.has(file)) {
        continue
      }
      if (await records(file)) {
        misplaced.push(file)
      }
    }
    expect(
      misplaced,
      'These tests record, so they need hardware GL and cannot run on a ' +
        'hosted runner. Rename them to *.gpu.test.ts — they then run via ' +
        'tools/gpu-box/test.sh on the GPU host.',
    ).toEqual([])
  })

  it('keeps the recording tier free of tests that do not record', async () => {
    const idle: string[] = []
    for (const file of await testFiles()) {
      if (!file.endsWith('.gpu.test.ts')) {
        continue
      }
      if (!(await records(file))) {
        idle.push(file)
      }
    }
    expect(
      idle,
      'These sit in the expensive tier without recording anything. Rename ' +
        'them to *.browser.test.ts (they start a browser) or *.test.ts.',
    ).toEqual([])
  })

  it('refuses the software-renderer switch in the portable tier', () => {
    expect(
      process.env['FEATURECAST_ALLOW_SOFTWARE_RENDERER'],
      'Setting this for a whole run turns off the guard that keeps a ~17fps ' +
        'software-rendered capture from passing as a 60fps one. Nothing in ' +
        'the portable tier records, so nothing here needs it.',
    ).toBeUndefined()
  })
})
