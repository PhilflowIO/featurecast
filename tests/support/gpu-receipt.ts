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
 * The fingerprint closes that — but only if it covers the right thing.
 *
 * It is deliberately not the commit hash: a README fix would then invalidate
 * a measurement it cannot possibly affect, and a receipt that expires every
 * day is one nobody renews. It is also no longer all of `src/**`, which was
 * the first attempt and failed on its first day: the render stage runs after
 * the browser has closed and no recording test ever reaches it, yet adding a
 * montage renderer expired a receipt about recordings.
 *
 * What it covers instead is what the recording tier actually loads: every
 * recording test, walked through its own import statements until nothing new
 * turns up, plus the manifest and lockfile, because which browser version is
 * installed is the single input that most changes what a recording looks
 * like.
 *
 * The walk is static, so a module reached only through a dynamic import would
 * be missed — and a fingerprint with a silent gap is worse than a broad one.
 * `collectRecordingInputs` therefore refuses to return a set it could not
 * fully resolve: an unresolvable relative import is an error, not an
 * omission.
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

/**
 * Every relative import in a file, as written. Bare specifiers (`playwright`,
 * `node:fs`) are not paths in this repository and are covered by the lockfile
 * instead.
 */
function relativeImports(source: string): string[] {
  const found: string[] = []
  const pattern =
    /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"](\.[^'"]*)['"]/g
  let match = pattern.exec(source)
  while (match !== null) {
    const specifier = match[1]
    if (specifier !== undefined) found.push(specifier)
    match = pattern.exec(source)
  }
  return found
}

/** This project writes `./x.js` and means `./x.ts`; both are accepted here. */
async function resolveImport(
  fromFile: string,
  specifier: string,
): Promise<string | undefined> {
  const base = join(REPOSITORY_ROOT, dirname(fromFile), specifier)
  const candidates = base.endsWith('.js')
    ? [`${base.slice(0, -3)}.ts`, base]
    : [`${base}.ts`, base]
  for (const candidate of candidates) {
    try {
      await readFile(candidate)
      return relative(REPOSITORY_ROOT, candidate)
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Every file the recording tier loads, starting from the recording tests and
 * walking their imports. Throws rather than guessing when a relative import
 * cannot be resolved — see the note at the top of this file.
 */
export async function collectRecordingInputs(): Promise<string[]> {
  const entry = (await filesUnder('tests')).filter(
    (file) =>
      file.endsWith('.gpu.test.ts') ||
      file === join('tests', 'support', 'require-hardware-gl.ts'),
  )
  const seen = new Set<string>()
  const queue = [...entry]
  const unresolved: string[] = []
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    const source = await readFile(join(REPOSITORY_ROOT, file), 'utf8')
    for (const specifier of relativeImports(source)) {
      const resolved = await resolveImport(file, specifier)
      if (resolved === undefined) {
        unresolved.push(`${file} -> ${specifier}`)
        continue
      }
      if (!seen.has(resolved)) queue.push(resolved)
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      'The recording fingerprint could not follow these imports, so it would ' +
        `have a silent gap: ${unresolved.join(', ')}`,
    )
  }
  return [...seen, 'package.json', 'pnpm-lock.yaml'].sort()
}

/** A hash over exactly the files the recording tier loads. */
export async function computeInputsDigest(): Promise<string> {
  const digest = createHash('sha256')
  for (const file of await collectRecordingInputs()) {
    const content = await readFile(join(REPOSITORY_ROOT, file))
    digest.update(file.split(sep).join('/'))
    digest.update('\0')
    digest.update(createHash('sha256').update(content).digest('hex'))
    digest.update('\n')
  }
  return digest.digest('hex')
}
