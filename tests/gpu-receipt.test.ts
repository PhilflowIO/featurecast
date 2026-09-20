import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  RECEIPT_FILE,
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
        `${receipt.host}, GPU ${receipt.gpu}). ${RENEW}`,
    ).toBe(await computeInputsDigest())
  })
})
