import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Browser } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BROWSER_PROVENANCE_FILE_NAME,
  launchChromium,
  listChildExecutables,
  readExecutableFingerprint,
  readExecutableVersion,
  resolveBrowserRequest,
  resolveExecutableFile,
  writeBrowserProvenance,
  type BrowserLaunchDependencies,
} from '../src/browser.js'

// No test in this file launches a browser. The launch flow is driven through
// injected dependencies; the two operating-system mechanisms it relies on --
// identifying a child process's executable via /proc and reading
// `--version` -- are exercised against real processes (`sleep`, a script
// posing as Chromium), so they are proven to work, not assumed.

const PATCHED = '/opt/chromium-patched/chrome'
const FINGERPRINT = { sha256: 'a'.repeat(64), sizeBytes: 516_058_688 }
const BUNDLE =
  '/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell'

function fakeBrowser(): Browser & { close: ReturnType<typeof vi.fn> } {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    version: () => '153.0.8010.12',
  } as unknown as Browser & { close: ReturnType<typeof vi.fn> }
}

function dependencies(
  overrides: Partial<BrowserLaunchDependencies> & { runningExecutable: string },
): BrowserLaunchDependencies & { browser: ReturnType<typeof fakeBrowser> } {
  const browser = fakeBrowser()
  let launched = false
  return {
    browser,
    launch: vi.fn(async () => {
      launched = true
      return browser
    }),
    listChildExecutables: vi.fn(async () =>
      launched
        ? new Map([
            [100, '/usr/bin/unrelated-earlier-child'],
            [200, overrides.runningExecutable],
          ])
        : new Map([[100, '/usr/bin/unrelated-earlier-child']]),
    ),
    readFingerprint: vi.fn(async () => FINGERPRINT),
    readVersion: vi.fn(async () => 'Chromium 153.0.8010.12'),
    resolveExecutable: vi.fn(async (path: string) => path),
    ...overrides,
  }
}

describe('resolveBrowserRequest', () => {
  it('prefers an explicit path, then CHROME_BIN, then the bundle', () => {
    expect(resolveBrowserRequest({ CHROME_BIN: PATCHED }, '/x/chrome')).toEqual(
      { path: '/x/chrome', source: 'option' },
    )
    expect(resolveBrowserRequest({ CHROME_BIN: PATCHED })).toEqual({
      path: PATCHED,
      source: 'CHROME_BIN',
    })
    expect(resolveBrowserRequest({})).toEqual({ source: 'playwright-bundle' })
  })

  it('refuses a CHROME_BIN that is set but empty instead of falling back', () => {
    expect(() => resolveBrowserRequest({ CHROME_BIN: '  ' })).toThrow(
      /CHROME_BIN is set but empty/,
    )
  })
})

describe('launchChromium', () => {
  it('launches the requested binary and records the one that runs', async () => {
    const deps = dependencies({ runningExecutable: PATCHED })
    const { provenance } = await launchChromium(
      { headless: true },
      { path: PATCHED, source: 'CHROME_BIN' },
      deps,
    )
    expect(deps.launch).toHaveBeenCalledWith({
      executablePath: PATCHED,
      headless: true,
    })
    expect(provenance).toEqual({
      executablePath: PATCHED,
      fingerprint: FINGERPRINT,
      reportedVersion: '153.0.8010.12',
      request: { path: PATCHED, source: 'CHROME_BIN' },
      version: 'Chromium 153.0.8010.12',
    })
    expect(deps.readVersion).toHaveBeenCalledWith(PATCHED)
    expect(deps.readFingerprint).toHaveBeenCalledWith(PATCHED)
  })

  it('is a hard error when the running browser is not the requested one', async () => {
    // The ticket 23 incident: CHROME_BIN named the patched build, the bundle ran.
    const deps = dependencies({ runningExecutable: BUNDLE })
    await expect(
      launchChromium(
        { headless: true },
        { path: PATCHED, source: 'CHROME_BIN' },
        deps,
      ),
    ).rejects.toThrow(
      `Requested browser ${PATCHED} (CHROME_BIN) but the running browser is ${BUNDLE}`,
    )
    expect(deps.browser.close).toHaveBeenCalledOnce()
  })

  it('fails before launching when the requested path is not an executable', async () => {
    const deps = dependencies({
      resolveExecutable: vi.fn(async () => {
        throw new Error('ENOENT')
      }),
      runningExecutable: PATCHED,
    })
    await expect(
      launchChromium(
        { headless: true },
        { path: '/nowhere/chrome', source: 'CHROME_BIN' },
        deps,
      ),
    ).rejects.toThrow(
      'CHROME_BIN "/nowhere/chrome" does not name an executable file: ENOENT',
    )
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('records the bundle path from the running process, without forcing a path', async () => {
    const deps = dependencies({ runningExecutable: BUNDLE })
    const { provenance } = await launchChromium(
      { headless: true },
      { source: 'playwright-bundle' },
      deps,
    )
    expect(deps.launch).toHaveBeenCalledWith({ headless: true })
    expect(provenance.executablePath).toBe(BUNDLE)
    expect(provenance.request).toEqual({ source: 'playwright-bundle' })
    // Nothing was requested, so the fingerprint can only come from the
    // running process -- the case that catches a fingerprint read off the
    // requested path instead.
    expect(deps.readFingerprint).toHaveBeenCalledWith(BUNDLE)
    expect(provenance.fingerprint).toEqual(FINGERPRINT)
  })

  it('closes the browser when the binary cannot be fingerprinted', async () => {
    const deps = dependencies({
      readFingerprint: vi.fn(async () => {
        throw new Error('EACCES')
      }),
      runningExecutable: PATCHED,
    })
    await expect(
      launchChromium({}, { path: PATCHED, source: 'option' }, deps),
    ).rejects.toThrow('EACCES')
    expect(deps.browser.close).toHaveBeenCalledOnce()
  })

  it('refuses to guess when the launched browser cannot be identified', async () => {
    const browser = fakeBrowser()
    let calls = 0
    const deps: BrowserLaunchDependencies = {
      launch: vi.fn(async () => browser),
      // Two new children with different executables: no way to tell which
      // one is the browser.
      listChildExecutables: vi.fn(async () =>
        calls++ === 0
          ? new Map()
          : new Map([
              [1, PATCHED],
              [2, '/usr/bin/ffmpeg'],
            ]),
      ),
      readFingerprint: vi.fn(async () => FINGERPRINT),
      readVersion: vi.fn(async () => 'x'),
      resolveExecutable: vi.fn(async (path: string) => path),
    }
    await expect(
      launchChromium({}, { source: 'playwright-bundle' }, deps),
    ).rejects.toThrow(/Cannot identify the launched browser/)
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('closes the browser when --version cannot be read', async () => {
    const deps = dependencies({
      readVersion: vi.fn(async () => {
        throw new Error('printed nothing')
      }),
      runningExecutable: PATCHED,
    })
    await expect(
      launchChromium({}, { path: PATCHED, source: 'option' }, deps),
    ).rejects.toThrow('printed nothing')
    expect(deps.browser.close).toHaveBeenCalledOnce()
  })
})

describe('operating-system mechanisms (real processes, no browser)', () => {
  let directory: string | undefined
  afterEach(async () => {
    if (directory) await rm(directory, { force: true, recursive: true })
    directory = undefined
  })

  it.skipIf(process.platform !== 'linux')(
    'identifies a real child process by its executable',
    async () => {
      const sleepBinary = await realpath('/bin/sleep')
      const before = await listChildExecutables()
      const child = spawn(sleepBinary, ['5'])
      try {
        // The exec has to have happened before /proc shows the new image.
        await vi.waitFor(async () => {
          const after = await listChildExecutables()
          expect(after.get(child.pid as number)).toBe(sleepBinary)
        })
        expect(before.has(child.pid as number)).toBe(false)
      } finally {
        child.kill()
      }
    },
  )

  it('reads --version from a real executable and rejects non-executables', async () => {
    directory = await mkdtemp(join(tmpdir(), 'featurecast-browser-'))
    const fake = join(directory, 'chrome')
    await writeFile(fake, '#!/bin/sh\necho "Chromium 153.0.8010.12 "\n')
    await chmod(fake, 0o755)
    expect(await resolveExecutableFile(fake)).toBe(await realpath(fake))
    expect(await readExecutableVersion(fake)).toBe('Chromium 153.0.8010.12')

    const notExecutable = join(directory, 'not-executable')
    await writeFile(notExecutable, 'x')
    await expect(resolveExecutableFile(notExecutable)).rejects.toThrow()
    await expect(resolveExecutableFile(directory)).rejects.toThrow(
      /is not a file/,
    )
    await expect(
      resolveExecutableFile(join(directory, 'missing')),
    ).rejects.toThrow()

    // Two binaries that differ only in their bytes -- the ticket 36 case, where
    // both builds are mounted at the same container path and report the
    // same version.
    const twin = join(directory, 'twin')
    await writeFile(twin, '#!/bin/sh\necho "Chromium 153.0.8010.12 "\n# twin\n')
    await chmod(twin, 0o755)
    const fakePrint = await readExecutableFingerprint(fake)
    const twinPrint = await readExecutableFingerprint(twin)
    expect(fakePrint.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fakePrint.sha256).toBe(
      createHash('sha256')
        .update(await readFile(fake))
        .digest('hex'),
    )
    expect(fakePrint.sizeBytes).toBe((await stat(fake)).size)
    expect(twinPrint.sha256).not.toBe(fakePrint.sha256)
    await expect(
      readExecutableFingerprint(join(directory, 'missing')),
    ).rejects.toThrow()

    const silent = join(directory, 'silent')
    await writeFile(silent, '#!/bin/sh\n')
    await chmod(silent, 0o755)
    await expect(readExecutableVersion(silent)).rejects.toThrow(
      /printed nothing/,
    )
  })

  it('writes browser.json next to the run', async () => {
    directory = await mkdtemp(join(tmpdir(), 'featurecast-browser-'))
    const provenance = {
      executablePath: PATCHED,
      fingerprint: FINGERPRINT,
      reportedVersion: '153.0.8010.12',
      request: { path: PATCHED, source: 'CHROME_BIN' as const },
      version: 'Chromium 153.0.8010.12',
    }
    await writeBrowserProvenance(directory, provenance)
    expect(
      JSON.parse(
        await readFile(join(directory, BROWSER_PROVENANCE_FILE_NAME), 'utf8'),
      ),
    ).toEqual(provenance)
  })
})
