import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { assertTsxCli } from './support/tsx-cli.js'

const execFileAsync = promisify(execFile)

/**
 * P3 (issue 15) acceptance: two *separate OS processes* running the exact
 * same script and seed must produce byte-identical `events.jsonl`. Running
 * both in-process (as most of tests/record.test.ts does) only proves the
 * generator is a pure function of its JS inputs within a single process;
 * running the real `tsx` CLI twice, like tests/tsx-pipeline.test.ts already
 * does for the smoke script, proves nothing leaks in from process-local
 * state (env, timing, module init order) either.
 */
describe('scroll cadence determinism across processes', () => {
  it('produces byte-identical events.jsonl across two separate tsx processes', async () => {
    const runA = 'artifacts/scroll-cadence-determinism/run-a'
    const runB = 'artifacts/scroll-cadence-determinism/run-b'
    await rm(runA, { force: true, recursive: true })
    await rm(runB, { force: true, recursive: true })

    await execFileAsync(
      assertTsxCli(),
      ['demo/scroll-cadence-smoke.ts', runA],
      { cwd: process.cwd() },
    )
    await execFileAsync(
      assertTsxCli(),
      ['demo/scroll-cadence-smoke.ts', runB],
      { cwd: process.cwd() },
    )

    // cmp exits non-zero (execFileAsync throws) on any byte difference —
    // stronger than a string-equality assertion inside this one process.
    await expect(
      execFileAsync('cmp', [
        join(runA, 'events.jsonl'),
        join(runB, 'events.jsonl'),
      ]),
    ).resolves.toBeDefined()
  }, 30_000)
})
