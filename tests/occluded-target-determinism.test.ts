import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { assertTsxCli } from './support/tsx-cli.js'

const execFileAsync = promisify(execFile)

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Issue #13 acceptance, in three *separate OS processes* — not three
 * in-process calls, which would only prove the flood fill is a pure
 * function within one process. The point the grid search returns feeds
 * straight into the logged pointer curve and click coordinates, so a
 * region-scan order that depended on `Map`/`Set` iteration happenstance,
 * or a centroid tie broken by anything timing-dependent, would show up
 * here as a differing hash while a single run looked perfectly fine.
 * Three, because a two-run comparison has caught a divergence far less
 * reliably than three in this repo's history.
 */
describe('occluded target search determinism across processes', () => {
  it('produces byte-identical events.jsonl across three separate tsx processes', async () => {
    const root = 'artifacts/occluded-target-determinism'
    const runs = [join(root, 'run-a'), join(root, 'run-b'), join(root, 'run-c')]
    await Promise.all(
      runs.map((run) => rm(run, { force: true, recursive: true })),
    )

    await Promise.all(
      runs.map((run) =>
        execFileAsync(
          assertTsxCli(),
          ['demo/occluded-target-determinism-smoke.ts', run],
          { cwd: process.cwd() },
        ),
      ),
    )

    const logs = await Promise.all(
      runs.map((run) => readFile(join(run, 'events.jsonl'), 'utf8')),
    )
    const hashes = logs.map(sha256)

    expect(hashes[1]).toBe(hashes[0])
    expect(hashes[2]).toBe(hashes[0])
  }, 60_000)
})
