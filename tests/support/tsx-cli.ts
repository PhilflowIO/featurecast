import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path to the `tsx` CLI this repo installed.
 *
 * The tests that need a *separate process* used to reach it through
 * `pnpm exec tsx`, which makes them depend on a package manager being on
 * `PATH` — and inside the measurement container it is not, because pnpm
 * ships through corepack and corepack is not enabled there. All six
 * cross-process tests, i.e. every determinism guarantee this repo makes,
 * therefore failed with `spawn pnpm ENOENT` in the one environment where
 * the acceptance runs happen, and were reported as a green suite of 168.
 *
 * Resolving the binary directly removes the dependency entirely: the
 * separate-process property is what these tests are about, the package
 * manager never was. `assertTsxCli` fails with the reason rather than with
 * an errno, because "spawn pnpm ENOENT" is the kind of message that reads
 * like an environment quirk and gets waved past.
 */
export const TSX_CLI = fileURLToPath(
  new URL('../../node_modules/.bin/tsx', import.meta.url),
)

export function assertTsxCli(): string {
  if (!existsSync(TSX_CLI)) {
    throw new Error(
      `The tsx CLI is missing at ${TSX_CLI}. This test exists to run a demo script in a separate process; without it there is no result to report, green or otherwise. Run the install step before the suite.`,
    )
  }
  return TSX_CLI
}
