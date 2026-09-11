import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

/**
 * Vitest transforms TypeScript with esbuild's default settings, which do
 * NOT set `keepNames`. `tsx` (how every demo script in this repo actually
 * runs — see package.json's `demo:*` scripts) compiles with
 * `keepNames: true`, so a named function declared anywhere inside a
 * `page.evaluate()`/`addInitScript()` payload gets wrapped in an
 * esbuild-injected `__name(...)` call. Playwright serializes that payload's
 * *source text* to run in the browser, where `__name` was never defined —
 * `ReferenceError: __name is not defined`. Every Vitest test in this suite
 * is structurally blind to that failure mode; this test runs the wrapper
 * through the real `tsx` CLI instead, so a regression fails here rather than
 * only in production.
 */
describe('record under the tsx pipeline', () => {
  it('runs demo/record-smoke.ts via tsx and writes a non-empty events.jsonl', async () => {
    const out = 'artifacts/tsx-smoke'
    await rm(out, { force: true, recursive: true })

    await execFileAsync('pnpm', ['exec', 'tsx', 'demo/record-smoke.ts', out], {
      cwd: process.cwd(),
    })

    const log = await readFile(join(out, 'events.jsonl'), 'utf8')
    expect(log.length).toBeGreaterThan(0)
    expect(log).toContain('{"type":"header"')
    expect(log).toContain('{"type":"click"')
    expect(log).toContain('{"type":"scroll"')
  }, 30_000)
})
