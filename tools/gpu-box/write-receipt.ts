import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  RECEIPT_FILE,
  computeInputsDigest,
  type GpuReceipt,
} from '../../tests/support/gpu-receipt.js'

/**
 * Turns a finished run of the recording tier into the receipt the portable
 * tier checks (see tests/gpu-receipt.test.ts).
 *
 * It reads results rather than asserting them: the vitest summary of the run
 * that just happened, and the renderer the tier's own gate probed before the
 * first case. Nothing here can claim a GPU that was not there — the gate
 * refuses that host long before this file runs.
 */

const run = promisify(execFile)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type VitestSummary = {
  numPassedTests: number
  numFailedTests: number
  testResults: unknown[]
}

async function capture(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(command, args, { cwd: ROOT })
    return stdout.trim()
  } catch {
    return 'unknown'
  }
}

const summaryPath = process.argv[2]
if (summaryPath === undefined) {
  throw new Error('usage: write-receipt.ts <vitest-json-summary>')
}

const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as VitestSummary
const probe = JSON.parse(
  await readFile(join(ROOT, 'artifacts', 'gpu-tier', 'renderer.json'), 'utf8'),
) as { renderer: string; browser: { version: string; source: string } }

const receipt: GpuReceipt = {
  inputsDigest: await computeInputsDigest(),
  generatedAt: new Date().toISOString(),
  commit: await capture('git', ['rev-parse', 'HEAD']),
  host: process.env['FEATURECAST_RECEIPT_HOST'] ?? hostname(),
  gpu: await capture('nvidia-smi', [
    '--query-gpu=name',
    '--format=csv,noheader',
  ]),
  renderer: probe.renderer,
  browser: probe.browser,
  tests: {
    files: summary.testResults.length,
    passed: summary.numPassedTests,
    failed: summary.numFailedTests,
  },
}

await mkdir(dirname(RECEIPT_FILE), { recursive: true })
await writeFile(RECEIPT_FILE, `${JSON.stringify(receipt, undefined, 2)}\n`)
console.log(
  `receipt: ${receipt.tests.passed} passed, ${receipt.tests.failed} failed, on ${receipt.gpu} (${receipt.renderer})`,
)
