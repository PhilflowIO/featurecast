import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { availableParallelism, loadavg } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { SETTLE_STARVED_MARKER } from '../src/record.js'
import { assertTsxCli } from './support/tsx-cli.js'

const execFileAsync = promisify(execFile)

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Cores this test must leave alone. It starts three recordings, and each
 * one needs its Chromium main thread and its compositor to keep getting
 * scheduled — those are the two threads that decide whether
 * `requestAnimationFrame` fires on time, and sampling geometry is exactly
 * what the criterion under test does. Six is three runs times those two
 * threads, not a tuning knob.
 */
const RECORDING_RESERVE_CORES = 6

/**
 * How many busy loops run alongside the recordings. Not optional garnish:
 * on an idle machine the old criterion's phase dependence hid under the
 * noise floor and three processes agreed roughly two times in three, while
 * under full load they disagreed three times out of three. A determinism
 * guarantee has to be checked where it breaks, so the load is part of the
 * test rather than a separate command someone has to remember. Override with
 * `FEATURECAST_LOAD_WORKERS=0` to reproduce the idle-machine baseline.
 *
 * The number is headroom, not core count. One loop per logical core was the
 * condition it was first measured under — 32 loops on the 32-thread bench
 * box, which was assumed idle. It is not: that box is the permanent
 * toolchain host, and whatever else runs there lands on top. Total demand
 * then passes saturation by a wide margin, Chromium drops below the rate at
 * which any period can be measured, and the run fails without having
 * measured anything. So the load is sized to what is actually free, which
 * is what "under contention" meant in the first place: enough demand to
 * saturate the machine, not enough to starve the thing being observed.
 *
 * Read per test rather than once at import, because the co-tenants come and
 * go. `loadavg` is a one-minute average and therefore lags a job that just
 * started — it is the only headroom signal available without a dependency,
 * and it errs toward less load, which is the safe direction here.
 */
function loadWorkers(): number {
  const override = process.env.FEATURECAST_LOAD_WORKERS
  if (override !== undefined) return Number(override)
  const [oneMinute = 0] = loadavg()
  return Math.max(
    1,
    availableParallelism() - Math.ceil(oneMinute) - RECORDING_RESERVE_CORES,
  )
}

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
      const workers = loadWorkers()
      startLoad(workers)
      const root = `artifacts/settle-determinism/${caseName}`
      const runs = [
        join(root, 'run-a'),
        join(root, 'run-b'),
        join(root, 'run-c'),
      ]
      await Promise.all(
        runs.map((run) => rm(run, { force: true, recursive: true })),
      )

      // A run that could not take the measurement and a run whose three
      // hashes disagreed are two different results, and only the second
      // says anything about the criterion. Without this split they arrive
      // as the same red, and the reader starts looking for a determinism
      // bug that the run never got close to testing.
      try {
        await Promise.all(
          runs.map((run) =>
            execFileAsync(
              assertTsxCli(),
              ['demo/settle-determinism-smoke.ts', caseName, run],
              { cwd: process.cwd() },
            ),
          ),
        )
      } catch (error) {
        const reported = `${String((error as { stderr?: string }).stderr ?? '')}\n${(error as Error).message}`
        if (reported.includes(SETTLE_STARVED_MARKER)) {
          throw new Error(
            'NO MEASUREMENT — this is not a determinism failure. A recording ' +
              'could not sample its target fast enough to produce a hash, so ' +
              'the three logs were never compared and nothing is claimed ' +
              `about the criterion. The test applied ${String(workers)} busy ` +
              `workers on ${String(availableParallelism())} logical cores; ` +
              'something else on this host is using the rest. Re-run when it ' +
              `is quieter.\n\n${reported}`,
          )
        }
        throw error
      }

      const logs = await Promise.all(
        runs.map((run) => readFile(join(run, 'events.jsonl'), 'utf8')),
      )
      const hashes = logs.map(sha256)

      const disagreed =
        'DETERMINISM FAILURE — the measurement was taken and the runs ' +
        'disagreed: three separate processes recorded the same target and ' +
        'produced different event logs.'
      expect(hashes[1], disagreed).toBe(hashes[0])
      expect(hashes[2], disagreed).toBe(hashes[0])
    }, 180_000)
  },
)
