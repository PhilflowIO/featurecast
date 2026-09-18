import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { assertTsxCli } from './support/tsx-cli.js'

const execFileAsync = promisify(execFile)

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * How many busy loops run alongside the recordings. Not optional garnish:
 * on an idle machine the old criterion's phase dependence hid under the
 * noise floor and three processes agreed roughly two times in three, while
 * under full load they disagreed three times out of three. A determinism
 * guarantee has to be checked where it breaks, so the load is part of the
 * test rather than a separate command someone has to remember. Override with
 * `FEATURECAST_LOAD_WORKERS=0` to reproduce the idle-machine baseline.
 *
 * One loop per logical core, because that is the condition it was measured
 * under: 32 loops on the 32-thread bench box. A fixed 32 on a 4-core CI
 * runner is eight times that, starves Chromium until no target settles
 * inside its timeout, and tests the runner instead of the criterion.
 */
const LOAD_WORKERS = Number(
  process.env.FEATURECAST_LOAD_WORKERS ?? String(availableParallelism()),
)

const busy: ChildProcess[] = []

function startLoad(count: number): void {
  for (let index = 0; index < count; index += 1) {
    busy.push(
      spawn(process.execPath, ['-e', 'for(;;){Math.sqrt(Math.random()*1e9)}'], {
        stdio: 'ignore',
      }),
    )
  }
}

afterEach(() => {
  for (const worker of busy.splice(0)) worker.kill('SIGKILL')
})

/**
 * Issue 12 acceptance, in three *separate OS processes* per case — not
 * three in-process calls, and not two: the verifier's report used three
 * and got three different hashes. Each case is a target whose geometry
 * never stops changing, so every byte of the log downstream of the settled
 * box and the chosen point is at stake: the click coordinates, the pointer
 * curve that leads to them, and the logged bbox itself.
 */
describe.each(['pulsing', 'bounce', 'asymmetric'])(
  'settle determinism across processes under load: %s',
  (caseName) => {
    it('produces byte-identical events.jsonl across three separate tsx processes', async () => {
      startLoad(LOAD_WORKERS)
      const root = `artifacts/settle-determinism/${caseName}`
      const runs = [
        join(root, 'run-a'),
        join(root, 'run-b'),
        join(root, 'run-c'),
      ]
      await Promise.all(
        runs.map((run) => rm(run, { force: true, recursive: true })),
      )

      await Promise.all(
        runs.map((run) =>
          execFileAsync(
            assertTsxCli(),
            ['demo/settle-determinism-smoke.ts', caseName, run],
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
    }, 180_000)
  },
)
