import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The receipt the recording tier leaves behind, and the fingerprint that
 * decides when it has gone stale.
 *
 * The recording tier cannot run where the public check runs, so its result
 * has to travel as a file. A file alone would rot: it would keep saying
 * "recordings work" long after the recording code changed underneath it.
 * The fingerprint closes that: it covers the product source and the
 * recording tests themselves, so any change to either invalidates the
 * receipt and turns the portable tier red until the tier has run again.
 *
 * Deliberately NOT the commit hash: a README fix would then invalidate a
 * measurement it cannot possibly affect, and a receipt that is invalid
 * every day is one nobody renews.
 */

const REPOSITORY_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

export const RECEIPT_FILE = join(
  REPOSITORY_ROOT,
  'docs',
  'evidence',
  'gpu-tier',
  'latest.json',
)

export type GpuReceipt = {
  /** What the receipt vouches for; compared against a fresh computation. */
  inputsDigest: string
  generatedAt: string
  commit: string
  host: string
  gpu: string
  /** WebGL renderer string the tier actually painted with. */
  renderer: string
  browser: { version: string; source: string }
  tests: { files: number; passed: number; failed: number }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(join(REPOSITORY_ROOT, directory), {
    recursive: true,
    withFileTypes: true,
  })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(REPOSITORY_ROOT, join(entry.parentPath, entry.name)),
    )
}

/** Covers every `src/**\/*.ts` and every recording test, path included. */
export async function computeInputsDigest(): Promise<string> {
  const source = (await filesUnder('src')).filter((file) =>
    file.endsWith('.ts'),
  )
  const recording = (await filesUnder('tests')).filter(
    (file) =>
      file.endsWith('.gpu.test.ts') ||
      file === join('tests', 'support', 'require-hardware-gl.ts'),
  )
  const digest = createHash('sha256')
  for (const file of [...source, ...recording].sort()) {
    const content = await readFile(join(REPOSITORY_ROOT, file))
    digest.update(file.split(sep).join('/'))
    digest.update('\0')
    digest.update(createHash('sha256').update(content).digest('hex'))
    digest.update('\n')
  }
  return digest.digest('hex')
}
