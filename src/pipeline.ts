import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { assembleScreencast, type EncodeTarget } from './assemble.js'
import {
  requireCaptureSettings,
  resolveDevice,
  type CaptureSettings,
  type OutputSettings,
  type ResolvedDevice,
} from './devices.js'
import { defaultQualityFor, type Encoder } from './encoders.js'
import { assertCaptureSupported, recordSession } from './session.js'
import type { PrepareStep, RecordingScript } from './session.js'
import { uploadFile, resolveUploadConfig } from './upload.js'

/**
 * `featurecast run`: one script, N devices, optionally an upload each.
 *
 * Everything the chain touches from outside the process — the browser, ffmpeg
 * and the object store — enters through `PipelineDependencies`, so the order
 * of the stages, the error policy and the reporting are provable without any
 * of the three. The real implementations are the module defaults.
 */

/** The shape a recording script has to export to be runnable by name. */
export const SCRIPT_EXPORT_NAMES = ['default', 'recording'] as const

/**
 * What a script file yields: the recording itself, and optionally everything
 * that has to be true before the camera rolls.
 *
 * `prepare` is a second, optional export under that name. It runs against the
 * page the capture will attach to but outside the capture window, so a
 * sign-in, a navigation or a dismissed banner does not open the video — nor
 * does the pointer travel of those clicks, which is the part that actually
 * ruins a recording of a real application.
 */
export type LoadedScript = {
  prepare?: PrepareStep
  recording: RecordingScript
}

export type ScriptLoader = (path: string) => Promise<LoadedScript>

export type DeviceOutcome =
  | {
      device: string
      kind: 'failed'
      /** The stage that refused, for a report a reader can act on. */
      stage: 'assemble' | 'device' | 'record' | 'upload'
      reason: string
    }
  | {
      device: string
      kind: 'rendered'
      outputPath: string
      /** Present only when `--upload` was asked for and succeeded. */
      url?: string
    }

export type RunReport = {
  outcomes: DeviceOutcome[]
  /** True when every requested device produced a video. */
  ok: boolean
}

export type RunRequest = {
  devices: readonly string[]
  /** Overrides the encoder every resolved device's output layer carries. */
  encoder?: Encoder
  /** Root directory; each device gets a subdirectory of its own. */
  out: string
  script: string
  seed?: number
  upload: boolean
}

export type PipelineDependencies = {
  assemble: (
    captureDirectory: string,
    outputPath: string,
    target: EncodeTarget,
  ) => Promise<unknown>
  loadScript: ScriptLoader
  /** Called once, before any recording, when `--upload` was asked for. */
  checkUploadConfigured: () => void
  record: (
    device: ResolvedDevice,
    outputDirectory: string,
    script: LoadedScript,
    seed: number,
  ) => Promise<{ capture: CaptureSettings; captureDirectory: string }>
  report: (line: string) => void
  upload: (localPath: string, key: string) => Promise<string>
}

/**
 * Loads a recording script by path.
 *
 * The script exports the *body* of the recording rather than calling
 * `record()` itself, because the command owns the device, the output
 * directory and the capture that wraps the script — a module that called
 * `record()` on import would open its own uncaptured browser the moment it
 * was loaded. `default` is the ordinary spelling; `recording` exists for
 * files that already have a default export for another reason.
 */
export const importScript: ScriptLoader = async (path) => {
  const module_ = (await import(pathToFileURL(path).href)) as Record<
    string,
    unknown
  >
  const prepare = module_['prepare']
  for (const name of SCRIPT_EXPORT_NAMES) {
    const candidate = module_[name]
    if (typeof candidate !== 'function') continue
    return {
      recording: candidate as RecordingScript,
      ...(typeof prepare === 'function'
        ? { prepare: prepare as PrepareStep }
        : {}),
    }
  }
  throw new Error(
    `"${path}" exports no recording function. Export one as \`default\` or \`recording\`: ` +
      '`export default async (page, demo) => { await page.goto(url); await demo.click("#x") }`. ' +
      'It must not call record() itself — featurecast run opens the browser and the capture around it.',
  )
}

/**
 * A device name as a path and object-key component: lowercase, and every run
 * of characters that are neither letters nor digits collapsed to one dash.
 * Playwright's registry names contain spaces ("Desktop Chrome HiDPI") and
 * dots ("Galaxy S24"), which are legal in an S3 key but make for URLs nobody
 * can read out loud.
 */
export function deviceSlug(device: string): string {
  const slug = device
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
  return slug === '' ? 'device' : slug
}

/** `demo/feature-xy.ts` -> `feature-xy`. */
export function scriptStem(path: string): string {
  return basename(path, extname(path))
}

const DEFAULT_DEPENDENCIES: PipelineDependencies = {
  assemble: async (captureDirectory, outputPath, target) =>
    assembleScreencast(captureDirectory, outputPath, undefined, target),
  checkUploadConfigured: () => {
    // Deliberately before the first browser starts. Discovering that the
    // store is unconfigured *after* a 30-second recording and a
    // minutes-long encode throws away the most expensive work in the
    // pipeline for a fault that was knowable at second zero. The message is
    // the one src/upload.ts writes; nothing is added to it here.
    resolveUploadConfig(process.env)
  },
  loadScript: importScript,
  record: async (device, outputDirectory, script, seed) => {
    const capture = prepareCapture(device)
    const session = await recordSession({
      capture,
      device,
      outputDirectory,
      recording: script.recording,
      seed,
      ...(script.prepare === undefined ? {} : { prepare: script.prepare }),
    })
    return { capture, captureDirectory: session.captureDirectory }
  },
  report: (line) => {
    process.stdout.write(`${line}\n`)
  },
  upload: async (localPath, key) => uploadFile(localPath, { key }),
}

/**
 * The two gates a device has to pass before a browser is worth starting: the
 * milestone that owes its capture decision (`requireCaptureSettings`, M3 for
 * every mobile preset) and the geometry the capture stage can actually
 * record (`assertCaptureSupported`). Separate from `recordSession` so both
 * refusals are provable without a browser.
 */
export function prepareCapture(device: ResolvedDevice): CaptureSettings {
  const capture = requireCaptureSettings(device)
  assertCaptureSupported(capture, describeDevice(device))
  return capture
}

/** `"desktop" (Desktop Chrome HiDPI)`, or just the name for a bare profile. */
function describeDevice(device: ResolvedDevice): string {
  return device.preset === null
    ? `"${device.playwrightName}"`
    : `"${device.preset}" (${device.playwrightName})`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs the chain for every requested device.
 *
 * **Error policy: one device's failure never stops the others.** A run of
 * `--devices desktop,iphone` where the second is blocked by an undecided
 * milestone must still hand over the first video; a recording is minutes of
 * work and throwing away a finished one to report a sibling's problem sooner
 * helps nobody. Every failure is collected, reported at the end with the
 * stage that refused, and turns the whole run's verdict to not-ok — so a
 * caller that checks the exit code still cannot miss it.
 *
 * The one thing that *does* stop the run before it starts is an unconfigured
 * upload, because it is knowable without doing any work at all.
 */
export async function runPipeline(
  request: RunRequest,
  dependencies: Partial<PipelineDependencies> = {},
): Promise<RunReport> {
  const deps: PipelineDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies,
  }
  if (request.devices.length === 0) {
    throw new Error(
      'No device requested. Pass --devices with at least one name, e.g. --devices desktop-wide.',
    )
  }
  if (request.upload) deps.checkUploadConfigured()
  const script = await deps.loadScript(request.script)
  const stem = scriptStem(request.script)
  const seed = request.seed ?? 1

  const outcomes: DeviceOutcome[] = []
  for (const device of request.devices) {
    outcomes.push(await runOneDevice(deps, request, script, device, stem, seed))
  }
  for (const outcome of outcomes) {
    deps.report(formatOutcome(outcome))
  }
  return {
    ok: outcomes.every((outcome) => outcome.kind === 'rendered'),
    outcomes,
  }
}

async function runOneDevice(
  deps: PipelineDependencies,
  request: RunRequest,
  script: LoadedScript,
  device: string,
  stem: string,
  seed: number,
): Promise<DeviceOutcome> {
  const slug = deviceSlug(device)
  const directory = join(request.out, slug)
  const outputPath = join(directory, 'output.mp4')

  // Resolution and the capture gate are one stage on purpose: both are the
  // device layer answering "can this name be recorded", and both messages
  // already name what is missing. The command adds no check of its own —
  // an unknown name is refused by `resolveDevice`, which lists the names
  // that exist, and a second list here would drift from it.
  let resolved: ResolvedDevice
  try {
    resolved = resolveDevice(device)
  } catch (error) {
    return { device, kind: 'failed', reason: messageOf(error), stage: 'device' }
  }

  let recorded: { capture: CaptureSettings; captureDirectory: string }
  try {
    recorded = await deps.record(resolved, directory, script, seed)
  } catch (error) {
    return { device, kind: 'failed', reason: messageOf(error), stage: 'record' }
  }

  try {
    await deps.assemble(
      recorded.captureDirectory,
      outputPath,
      encodeTargetFor(recorded.capture, resolved.output, request.encoder),
    )
  } catch (error) {
    return {
      device,
      kind: 'failed',
      reason: messageOf(error),
      stage: 'assemble',
    }
  }

  if (!request.upload) return { device, kind: 'rendered', outputPath }
  try {
    const url = await deps.upload(outputPath, `${stem}/${slug}.mp4`)
    return { device, kind: 'rendered', outputPath, url }
  } catch (error) {
    return { device, kind: 'failed', reason: messageOf(error), stage: 'upload' }
  }
}

/**
 * The resolved device's own capture and output layers, with the encoder
 * replaced when the caller named one. `--encoder` overrides the preset
 * rather than being a second, parallel setting: there is one encoder per
 * render and the device layer is where it is stored.
 */
export function encodeTargetFor(
  capture: CaptureSettings,
  output: OutputSettings,
  encoder?: Encoder,
): EncodeTarget {
  return {
    capture: { height: capture.height, width: capture.width },
    output: {
      height: output.height,
      quality:
        encoder === undefined ? output.quality : defaultQualityFor(encoder),
      width: output.width,
    },
  }
}

function formatOutcome(outcome: DeviceOutcome): string {
  if (outcome.kind === 'failed') {
    return `${outcome.device}: ${outcome.stage} refused — ${outcome.reason}`
  }
  return outcome.url === undefined
    ? `${outcome.device}: ${outcome.outputPath}`
    : `${outcome.device}: ${outcome.url}`
}
