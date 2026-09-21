import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  RECEIPT_FILE,
  collectRecordingInputs,
  computeInputsDigest,
  type GpuReceipt,
} from './support/gpu-receipt.js'

/**
 * The one check that makes the recording tier non-optional.
 *
 * Splitting the suite by what it needs is only honest if the expensive half
 * is still *required*. Without this, a change to the recorder could be
 * merged with a green check on a runner that never recorded anything — the
 * split would have bought a green badge instead of a guarantee.
 *
 * This case runs in the portable tier, on exactly that GPU-less runner, and
 * fails whenever the recording code has moved since the last time the
 * recording tier actually ran. The remedy is a run on the GPU host, not an
 * edit here.
 */

const RENEW =
  'Run the recording tier on the GPU host and commit the receipt it writes:\n' +
  '  tools/gpu-box/test.sh\n' +
  'The receipt is docs/evidence/gpu-tier/latest.json.'

/**
 * Why this case also runs on `git push`, not only in the public check.
 *
 * `main` was once red here while no pull request had ever been red. The
 * explanation is not subtle once the receipt is seen for what it is: a
 * single file that every change inside the fingerprint must rewrite. Two
 * branches that both move the recording path therefore always collide on
 * it, and the forge refuses that merge; a merge that goes through cleanly
 * carries exactly one side's receipt together with that side's source.
 *
 * Which leaves one way for `main` to end up stale — a branch that moved a
 * fingerprinted file without renewing, merged without anyone running this.
 * That branch is red the instant this case runs. It was not run, because
 * the only runner is on a mirror, and the mirror had been standing still
 * since midday.
 *
 * So the check moved to where it cannot be skipped by an outage: the push
 * itself. It costs well under a second and needs no GPU — it reads two
 * files and hashes a dozen.
 */
const PUSH_HOOK = 'pnpm check:receipt'

describe('recording-tier receipt', () => {
  it('matches the source it vouches for', async () => {
    let receipt: GpuReceipt
    try {
      receipt = JSON.parse(await readFile(RECEIPT_FILE, 'utf8')) as GpuReceipt
    } catch (error) {
      throw new Error(
        `No receipt from the recording tier (${(error as Error).message}). ${RENEW}`,
      )
    }

    expect(
      receipt.tests.failed,
      'The receipt records failing recording tests, so it vouches for nothing.',
    ).toBe(0)
    expect(receipt.tests.passed).toBeGreaterThan(0)
    expect(
      receipt.renderer,
      'The receipt was written on a software renderer, which proves nothing ' +
        'about a recording. It should be impossible to produce — ' +
        'tests/support/require-hardware-gl.ts refuses that host.',
    ).not.toMatch(/swiftshader|software|llvmpipe|softpipe/i)

    expect(
      receipt.inputsDigest,
      'The recorder or a recording test has changed since the recording ' +
        `tier last ran (receipt written ${receipt.generatedAt} on ` +
        `${receipt.host}, GPU ${receipt.gpu}). If you are reading this on ` +
        '`main` and no pull request was ever red, then nothing ran this ' +
        'check before the merge — which is what the pre-push hook is for. ' +
        `${RENEW}`,
    ).toBe(await computeInputsDigest())
  })
})

describe('when the receipt is checked', () => {
  it('runs on every push, so a stalled mirror cannot postpone it to after the merge', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      scripts: Record<string, string>
      'simple-git-hooks': Record<string, string>
    }

    expect(
      manifest['simple-git-hooks']['pre-push'] ?? '(no pre-push hook)',
      'Without this hook the only thing that checks the receipt is a job on ' +
        'the GitHub mirror, and `main` has already been red for a merge no ' +
        'pull request could have caught.',
    ).toContain(PUSH_HOOK)
    expect(
      manifest.scripts['check:receipt'] ?? '(no check:receipt script)',
      'The hook names this script; it has to exist and it has to run this file.',
    ).toContain('tests/gpu-receipt.test.ts')
  })
})

describe('what the receipt vouches for', () => {
  it('covers the recording path, and follows every import of it', async () => {
    const inputs = await collectRecordingInputs()
    for (const file of [
      'tests/hardware-gl.gpu.test.ts',
      'tests/support/require-hardware-gl.ts',
      'src/session.ts',
      'src/record.ts',
      'src/renderer.ts',
      'src/browser.ts',
    ]) {
      expect(inputs, `${file} is loaded by a recording test`).toContain(file)
    }
  })

  it('leaves out what a recording cannot reach', async () => {
    const inputs = await collectRecordingInputs()
    // The render stage runs after the browser has closed. Covering it was the
    // first attempt and it expired a receipt about recordings the same day a
    // montage renderer was added.
    expect(inputs).not.toContain('src/render/montage.ts')
    expect(inputs).not.toContain('src/render/shell.ts')
    expect(inputs).not.toContain('src/compare.ts')
  })

  it('covers the manifest and the lockfile', async () => {
    const inputs = await collectRecordingInputs()
    // Which browser version is installed is the single input that most
    // changes what a recording looks like, and it lives in neither.
    expect(inputs).toContain('package.json')
    expect(inputs).toContain('pnpm-lock.yaml')
  })
})
