import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
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
    fileParallelism: false,
  },
})
