import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { Browser, LaunchOptions } from 'playwright'

/**
 * Which Chromium produced a run, decided once, verified against the running
 * process, and written next to the run's artifacts.
 *
 * Why this module exists: for three days every capture number in this
 * project was attributed to the wrong browser. The bench exported
 * `CHROME_BIN` pointing at a patched Chromium build, nothing read it, and
 * Playwright silently launched its bundled browser instead. From the outside
 * the run looked patched; the "18 % capture loss" it appeared to prove does
 * not exist on the patched build (#23, docs/JOURNEY.md). A set-but-ignored
 * variable is invisible, so three rules hold here:
 *
 * 1. `CHROME_BIN` (or an explicit path) is honoured, and a value that does
 *    not name an executable file fails before anything launches.
 * 2. The browser that actually runs is identified from the operating system
 *    (`/proc/<pid>/exe` of the child process Playwright started), not from
 *    what was passed in. An explicit request that does not match the running
 *    binary is a hard error.
 * 3. Every run records absolute path plus `--version` of that running
 *    binary in `browser.json`.
 */

export const BROWSER_ENV_VARIABLE = 'CHROME_BIN'
export const BROWSER_PROVENANCE_FILE_NAME = 'browser.json'

export type BrowserRequest =
  | { source: 'option' | typeof BROWSER_ENV_VARIABLE; path: string }
  | { source: 'playwright-bundle' }

export type BrowserProvenance = {
  /** What was asked for, before anything launched. */
  request: BrowserRequest
  /** Resolved absolute path of the browser process that actually runs. */
  executablePath: string
  /** Output of `<executablePath> --version`. */
  version: string
  /** What the browser reports about itself over CDP (`browser.version()`). */
  reportedVersion: string
}

export type BrowserLaunchDependencies = {
  launch: (options: LaunchOptions) => Promise<Browser>
  /** Resolved absolute path of an executable file; throws otherwise. */
  resolveExecutable: (path: string) => Promise<string>
  /** Trimmed, non-empty `--version` output; throws otherwise. */
  readVersion: (executablePath: string) => Promise<string>
  /** Direct child processes of this process: pid -> resolved executable. */
  listChildExecutables: () => Promise<Map<number, string>>
}

/**
 * An explicit path wins over `CHROME_BIN`, which wins over Playwright's
 * bundled browser. A `CHROME_BIN` that is set but empty is an error, not a
 * request for the bundle: an empty value is almost always a broken export,
 * and falling back silently is exactly the failure this module exists for.
 */
export function resolveBrowserRequest(
  env: Readonly<Record<string, string | undefined>>,
  explicitPath?: string,
): BrowserRequest {
  if (explicitPath !== undefined) {
    if (explicitPath.trim() === '') {
      throw new Error('Browser executable path option is empty')
    }
    return { path: explicitPath, source: 'option' }
  }
  const fromEnv = env[BROWSER_ENV_VARIABLE]
  if (fromEnv !== undefined) {
    if (fromEnv.trim() === '') {
      throw new Error(
        `${BROWSER_ENV_VARIABLE} is set but empty; unset it to use Playwright's bundled Chromium, or point it at a browser executable`,
      )
    }
    return { path: fromEnv, source: BROWSER_ENV_VARIABLE }
  }
  return { source: 'playwright-bundle' }
}

/**
 * Launches Chromium and proves which binary is running. The browser is
 * closed again if any check fails, so no run can proceed on an unverified
 * browser.
 */
export async function launchChromium(
  launchOptions: LaunchOptions,
  request: BrowserRequest,
  dependencies: BrowserLaunchDependencies = defaultBrowserLaunchDependencies,
): Promise<{ browser: Browser; provenance: BrowserProvenance }> {
  let requestedExecutable: string | undefined
  if (request.source !== 'playwright-bundle') {
    try {
      requestedExecutable = await dependencies.resolveExecutable(request.path)
    } catch (error) {
      throw new Error(
        `${request.source === 'option' ? 'Browser executable path' : BROWSER_ENV_VARIABLE} "${request.path}" does not name an executable file: ${errorMessage(error)}`,
      )
    }
  }

  // Playwright spawns the browser as a direct child of this process. The
  // child that is new after launch is the browser; its executable comes from
  // the operating system, not from the options we passed.
  const before = await dependencies.listChildExecutables()
  const browser = await dependencies.launch(
    requestedExecutable === undefined
      ? launchOptions
      : { ...launchOptions, executablePath: requestedExecutable },
  )
  try {
    const after = await dependencies.listChildExecutables()
    const started = [
      ...new Set(
        [...after].filter(([pid]) => !before.has(pid)).map(([, exe]) => exe),
      ),
    ]
    if (started.length !== 1) {
      throw new Error(
        `Cannot identify the launched browser: expected exactly one new child executable, found ${JSON.stringify(started)}`,
      )
    }
    const executablePath = started[0] as string
    if (
      requestedExecutable !== undefined &&
      executablePath !== requestedExecutable
    ) {
      throw new Error(
        `Requested browser ${requestedExecutable} (${request.source}) but the running browser is ${executablePath}`,
      )
    }
    return {
      browser,
      provenance: {
        executablePath,
        reportedVersion: browser.version(),
        request,
        version: await dependencies.readVersion(executablePath),
      },
    }
  } catch (error) {
    await browser.close()
    throw error
  }
}

export async function writeBrowserProvenance(
  directory: string,
  provenance: BrowserProvenance,
): Promise<void> {
  await writeFile(
    join(directory, BROWSER_PROVENANCE_FILE_NAME),
    `${JSON.stringify(provenance, null, 2)}\n`,
  )
}

export async function resolveExecutableFile(path: string): Promise<string> {
  const absolute = await realpath(resolve(path))
  if (!(await stat(absolute)).isFile()) {
    throw new Error(`${absolute} is not a file`)
  }
  await access(absolute, constants.X_OK)
  return absolute
}

export async function readExecutableVersion(
  executablePath: string,
): Promise<string> {
  const { stdout } = await promisify(execFile)(executablePath, ['--version'], {
    timeout: 15_000,
  })
  const version = stdout.trim()
  if (version === '') {
    throw new Error(`${executablePath} --version printed nothing`)
  }
  return version
}

/**
 * Linux only, on purpose: without `/proc` the running browser cannot be
 * identified, and an unidentified browser is exactly what this module
 * refuses to run with.
 */
export async function listChildExecutables(
  parentPid: number = process.pid,
  procRoot = '/proc',
): Promise<Map<number, string>> {
  let entries: string[]
  try {
    entries = await readdir(procRoot)
  } catch (error) {
    throw new Error(
      `Browser provenance needs ${procRoot} to identify the running browser: ${errorMessage(error)}`,
    )
  }
  const children = new Map<number, string>()
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const statLine = await readFile(join(procRoot, entry, 'stat'), 'utf8')
      // Field 4 is the parent pid. The command name in field 2 may contain
      // spaces and parentheses, so fields are counted after its closing ')'.
      const afterName = statLine.slice(statLine.lastIndexOf(')') + 2)
      const parent = Number(afterName.split(' ')[1])
      if (parent !== parentPid) continue
      const exe = await readlink(join(procRoot, entry, 'exe'))
      children.set(Number(entry), await realpath(exe))
    } catch {
      // Processes exit while being listed; a vanished entry is not a child
      // we could have launched.
    }
  }
  return children
}

export const defaultBrowserLaunchDependencies: BrowserLaunchDependencies = {
  async launch(options) {
    const { chromium } = await import('playwright')
    return chromium.launch(options)
  },
  listChildExecutables: () => listChildExecutables(),
  readVersion: readExecutableVersion,
  resolveExecutable: resolveExecutableFile,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
