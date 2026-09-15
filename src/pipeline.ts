import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  aspectOf,
  resolveDevice,
  type CaptureSettings,
  type OutputSettings,
  type ResolvedDevice,
} from './devices.js'
import {
  defaultQualityFor,
  type Encoder,
  type OutputQuality,
} from './encoders.js'
import { DEFAULT_FORMATS, type FormatSpec } from './render/format.js'
import { formatSlug, renderRecording } from './render/render.js'
import {
  assertCaptureSupported,
  recordSession,
  requireAppUrl,
} from './session.js'
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
  /**
   * The application the script films, as a third optional export named
   * `url`. A direct capture does not need it — the script navigates there
   * itself — but a framed one does, because the shell it puts the
   * application inside is served from the application's own origin and that
   * origin has to be known before the first frame (src/framed.ts).
   */
  url?: string
}

export type ScriptLoader = (path: string) => Promise<LoadedScript>

/** One finished video: where it is, what it is called, and where it went. */
export type Delivery = {
  label: string
  outputPath: string
  /** Present only when `--upload` was asked for and succeeded. */
  url?: string
}

export type DeviceOutcome =
  | {
      device: string
      kind: 'failed'
      /** The stage that refused, for a report a reader can act on. */
      stage: 'device' | 'record' | 'render' | 'upload'
      reason: string
    }
  | {
      device: string
      /**
       * Everything the device promised, in the order it was asked for. Plural
       * since the render stage joined the chain: one recording yields as many
       * formats as were requested, and the whole point of the post-production
       * stage is that a second one costs no second browser.
       */
      deliveries: readonly Delivery[]
      /** Where the decisions the render took were written. */
      decisionsPath: string
      kind: 'rendered'
    }

export type RunReport = {
  outcomes: DeviceOutcome[]
  /** True when every requested device produced a video. */
  ok: boolean
}

export type RunRequest = {
  /**
   * Deliver all three curated formats instead of the one the device promises.
   * Off by default; see `formatsFor`.
   */
  allFormats?: boolean
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
  loadScript: ScriptLoader
  /** Called once, before any recording, when `--upload` was asked for. */
  checkUploadConfigured: () => void
  record: (
    device: ResolvedDevice,
    outputDirectory: string,
    script: LoadedScript,
    seed: number,
  ) => Promise<{ capture: CaptureSettings; captureDirectory: string }>
  /**
   * Post-production. It **replaces** the assemble step rather than following
   * it: both read the same capture directory and write an MP4, and encoding
   * twice would feed the second pass from pixels the first one threw away.
   */
  render: (
    captureDirectory: string,
    outDirectory: string,
    request: RenderRequest,
  ) => Promise<{
    decisionsPath: string
    outputs: ReadonlyArray<{ label: string; outputPath: string }>
  }>
  report: (line: string) => void
  upload: (localPath: string, key: string) => Promise<string>
}

/** What the chain asks the render stage for, per device. */
export type RenderRequest = {
  formats: readonly FormatSpec[]
  quality: OutputQuality
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
  const url = module_['url']
  for (const name of SCRIPT_EXPORT_NAMES) {
    const candidate = module_[name]
    if (typeof candidate !== 'function') continue
    return {
      recording: candidate as RecordingScript,
      ...(typeof prepare === 'function'
        ? { prepare: prepare as PrepareStep }
        : {}),
      ...(typeof url === 'string' ? { url } : {}),
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
    requireAppUrl(device, script.url)
    const session = await recordSession({
      capture,
      device,
      outputDirectory,
      recording: script.recording,
      seed,
      ...(script.prepare === undefined ? {} : { prepare: script.prepare }),
      ...(script.url === undefined ? {} : { appUrl: script.url }),
    })
    return { capture, captureDirectory: session.captureDirectory }
  },
  render: async (captureDirectory, outDirectory, request) => {
    const result = await renderRecording(captureDirectory, outDirectory, {
      encoder: request.quality,
      formats: request.formats,
    })
    return { decisionsPath: result.decisionsPath, outputs: result.outputs }
  },
  report: (line) => {
    process.stdout.write(`${line}\n`)
  },
  upload: async (localPath, key) => uploadFile(localPath, { key }),
}

/**
 * What a device is delivered in.
 *
 * The device layer names exactly one size — that is what a preset promises —
 * so that is what the chain delivers unless the caller asks for more. Three
 * formats are a switch and not a default: two of them would be crops nobody
 * asked for, and for a mobile recording two of the three cannot be cut
 * sharply at all.
 *
 * The label is derived rather than stored, the same rule `docs/DEVICES.md`
 * states for the device layer: `desktop-wide` delivers 1920x1200, which is
 * 16:10 and has no name in the curated three, and a stored name would have
 * contradicted the pixels beside it.
 */
export function formatsFor(
  output: OutputSettings,
  all: boolean,
): readonly FormatSpec[] {
  if (all) return DEFAULT_FORMATS
  const size = { height: output.height, width: output.width }
  return [
    {
      desired: size,
      label: aspectOf(size) ?? `${String(size.width)}x${String(size.height)}`,
    },
  ]
}

/**
 * The gate a device has to pass before a browser is worth starting: the
 * geometry and cadence the capture stage can actually record. Separate from
 * `recordSession` so the refusal is provable without a browser.
 */
export function prepareCapture(device: ResolvedDevice): CaptureSettings {
  const capture = device.capture
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
  // Two directories, not one. The capture owns `frames/`, `timestamps.json`
  // and the event log; the render writes its decisions and its videos. Mixed
  // together, a reader cannot tell which artifact is raw material and which
  // is a result, and a second render would drop its files between the frames
  // it read.
  const directory = join(request.out, slug)
  const renderDirectory = join(request.out, `${slug}-video`)

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

  let rendered: Awaited<ReturnType<PipelineDependencies['render']>>
  try {
    rendered = await deps.render(recorded.captureDirectory, renderDirectory, {
      formats: formatsFor(resolved.output, request.allFormats === true),
      quality:
        request.encoder === undefined
          ? resolved.output.quality
          : defaultQualityFor(request.encoder),
    })
  } catch (error) {
    return {
      device,
      kind: 'failed',
      reason: messageOf(error),
      stage: 'render',
    }
  }

  const deliveries: Delivery[] = rendered.outputs.map((output) => ({
    label: output.label,
    outputPath: output.outputPath,
  }))
  if (!request.upload) {
    return {
      decisionsPath: rendered.decisionsPath,
      deliveries,
      device,
      kind: 'rendered',
    }
  }
  try {
    const uploaded: Delivery[] = []
    for (const delivery of deliveries) {
      // One key per deliverable, named after the format: a device that ships
      // three videos cannot have them all land on one object.
      const key = `${stem}/${slug}-${formatSlug(delivery.label)}.mp4`
      uploaded.push({
        ...delivery,
        url: await deps.upload(delivery.outputPath, key),
      })
    }
    return {
      decisionsPath: rendered.decisionsPath,
      deliveries: uploaded,
      device,
      kind: 'rendered',
    }
  } catch (error) {
    return { device, kind: 'failed', reason: messageOf(error), stage: 'upload' }
  }
}

function formatOutcome(outcome: DeviceOutcome): string {
  if (outcome.kind === 'failed') {
    return `${outcome.device}: ${outcome.stage} refused — ${outcome.reason}`
  }
  return outcome.deliveries
    .map(
      (delivery) =>
        `${outcome.device} ${delivery.label}: ${delivery.url ?? delivery.outputPath}`,
    )
    .join('\n')
}
