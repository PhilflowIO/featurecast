import { defineConfig, configDefaults } from 'vitest/config'

// Serializing test files, in both tiers.
//
// Most of this suite drives real headless Chromium instances
// (record.browser.test.ts, capture.integration.test.ts,
// scroll-cadence-determinism.test.ts, tsx-pipeline.test.ts, ...).
// Vitest's default file-level parallelism runs several of those test
// files at once, each launching its own Chromium process; the
// resulting cross-process CPU contention is real, not simulated, and
// it does not just slow every measurement down proportionally — it can
// starve one process's CDP/IPC round trip much more than another's,
// which broke even a load-independent ratio metric (capture efficiency
// dropped to 63% under full-suite contention vs 97%+ in isolation for
// the same fixture; see the comment on
// `tests/capture.integration.test.ts`'s first test). Serializing test
// files removes that contention instead of chasing a threshold that
// has to guess how much of it to tolerate.
const serial = { fileParallelism: false } as const

// Two tiers, split by what a test *needs*, not by what it starts.
//
// `*.gpu.test.ts` records: it reaches `recordSession`, which refuses a
// software GL renderer before the first filmed frame (src/renderer.ts).
// On a GPU-less host — every hosted CI runner — those tests either fail
// or, with the guard switched off, film at ~17fps and assert nothing
// about the thing they are named after. So they do not run there at all.
//
// `*.browser.test.ts` also starts Chromium but never records; nine such
// files pass on a hosted runner. The filename is therefore not the
// criterion — `tests/tiers.test.ts` enforces the real one and fails if a
// recording test ever lands in the portable tier.
export default defineConfig({
  test: {
    ...serial,
    projects: [
      {
        test: {
          ...serial,
          name: 'portable',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'tests/**/*.gpu.test.ts'],
        },
      },
      {
        test: {
          ...serial,
          name: 'gpu',
          include: ['tests/**/*.gpu.test.ts'],
          setupFiles: ['tests/support/require-hardware-gl.ts'],
        },
      },
    ],
  },
})
