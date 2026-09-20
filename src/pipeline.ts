import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  aspectOf,
  resolveDevice,
  type CaptureSettings,
  type DeviceOverrides,
  type DeviceSpec,
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
import { type FakeMedia, readFakeMedia } from './fake-media.js'
import { readLocale, readTimezone } from './locale.js'
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
 *
 * Next to it stand six exports that describe the *browser context* rather
 * than the recording: `storageStatePath`, `hideSelectors`, `fixedTime`,
 * `fakeMedia`, `allowFramingOfApp` and `locale`. They are here rather than in
 * a script's own hands because a script cannot reach them — it is handed a
 * page, and all six have to be true before that page exists. Until they were part of this contract there was a
 * second, cameraless recording path in `demo/` that owned its own browser
 * just to set them, and the one script that films this product ran on it
 * and produced an event log instead of a video.
 */
export type LoadedScript = {
  /**
   * `allowFramingOfApp`: `true` lets a phone or tablet recording film an
   * application that forbids framing, by relaxing its framing headers on the
   * framed application document inside the recording browser (src/framed.ts,
   * "An application that forbids framing altogether").
   *
   * Opt-in per script because it lowers a security header, however narrowly:
   * an application that allows same-origin framing never needs it, and one
   * that forbids it should be filmed that way only where somebody said so.
   */
  allowFramingOfApp?: boolean
  /**
   * `devices`: which devices this script is meant to be filmed on, with any
   * field of the device layer overridden.
   *
   * It belongs to the script for the same reason the context exports do
   * — it is knowable where the script is written and nowhere else. A tour of a
   * phone layout is not a desktop tour with a narrower window; a capture area
   * larger than the delivery exists to buy the camera room to move into, and
   * how much room a particular journey needs is a property of that journey.
   *
   * Until this existed, the only selectable thing was a **name**: one of the
   * curated presets or an entry in Playwright's registry. The override type
   * underneath has always been complete — capture area, output size, frame
   * rate, pointer — and was reachable only by writing TypeScript against the
   * API. That is why "can it do 4K" and "why does the camera not move on a
   * phone" were both unanswerable in practice: not because the layer could not
   * do it, but because nobody outside the code could ask for it.
   *
   * `--devices` on the command line overrides this for a single run. Neither
   * present is an error, not a default: filming the wrong device is a whole
   * wasted recording, and guessing one is worse than refusing.
   */
  devices?: readonly DeviceSpec[]
  /**
   * `fakeMedia`: `true` gives the page a synthetic camera and microphone that
   * are already permitted.
   *
   * Context-level for the plainest reason of all: it is two launch switches
   * of the browser, and a script is handed a page of a browser that is
   * already running. Without it a video-call page films its "no camera, no
   * microphone" state — in Raven's case a red banner over the join card.
   *
   * An object instead of `true` names files: a face for the camera, a voice
   * for the microphone, the voice anchored on the wall clock so several
   * browsers in one meeting speak on one timeline (src/fake-media.ts).
   */
  fakeMedia?: FakeMedia
  /**
   * `fixedTime`: the wall clock the recording claims, as an ISO instant.
   *
   * It is part of the contract rather than something a script does for
   * itself because it cannot be done from a script at all: Playwright's
   * clock is a property of the browser context, and a script is handed a
   * page that is already open. By then "3 days ago" has been rendered
   * against today's date, and two runs a week apart no longer show the same
   * list. The same init script also pins the page's own `Math.random`.
   */
  fixedTime?: string
  /**
   * `hideSelectors`: CSS selectors of surfaces that are gone before the
   * page's own scripts run.
   *
   * Also context-level, and for a stronger reason than convenience: a node
   * a script removes after the first paint has already been on screen, and
   * the screencast has the frames. A consent banner is noise; a card
   * showing an internal address is a leak that no later edit can take back.
   */
  hideSelectors?: readonly string[]
  /**
   * `locale`: the language the application is filmed in, as a BCP 47 tag
   * with a region (`'de-DE'`).
   *
   * Browser-level for the same reason as `fakeMedia`: half of it is the
   * browser process's environment, which decides the UI and the spellcheck
   * dictionary, and a script is handed a page of a browser already running.
   * Without it a German application is filmed in an English browser, and
   * every correctly spelled German word typed on camera gets a red squiggle
   * (featurecast#172, src/locale.ts).
   */
  locale?: string
  prepare?: PrepareStep
  recording: RecordingScript
  /**
   * `storageStatePath`: the saved sign-in to record under — a **path**, and
   * deliberately never the state itself.
   *
   * A `storageState` file is cookies and local storage of a signed-in
   * account: it is the access, not a configuration artifact. Taking a path
   * keeps it out of every value this process handles; the browser opens the
   * file. `auth/` is git-ignored for that reason, and the credentials that
   * produce it belong in a secret store — never in a file of this
   * repository (`CONTRIBUTING.md`, "Things that must never be committed").
   */
  storageStatePath?: string
  /**
   * The application the script films, as a third optional export named
   * `url`. A direct capture does not need it — the script navigates there
   * itself — but a framed one does, because the shell it puts the
   * application inside is served from the application's own origin and that
   * origin has to be known before the first frame (src/framed.ts).
   */
  url?: string
  /**
   * `timezone`: the wall clock the application is filmed on, as an IANA name
   * (`'Europe/Berlin'`).
   *
   * Context-level like `locale`, and its sibling: the language decides the
   * words, this decides the numbers. Without it the page runs on the
   * container's clock — UTC — and a scene that asks for an appointment at
   * "10 Uhr" films it standing at 08:00 (src/locale.ts).
   */
  timezone?: string
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
  /**
   * The devices this run films, overriding the script's own `devices` export.
   * Absent means "whatever the script says"; neither is an error.
   */
  devices?: readonly DeviceSpec[]
  /** Overrides the encoder every resolved device's output layer carries. */
  encoder?: Encoder
  /** Root directory; each device gets a subdirectory of its own. */
  out: string
  /**
   * The capture reserve for every device of this run, as `reserve` in the
   * device layer: a multiple of the output. Absent means each device's own
   * default — 1.5 on a touch preset, the fixed area on a desktop one.
   */
  reserve?: number
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
      ...readDeviceSpecs(module_, path),
      ...readContextSettings(module_, path),
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
 * The `devices` export, read and checked field by field.
 *
 * Checked here for the same reason the context settings are: this is the last
 * place that still knows which file the value came from. And the failure it
 * prevents is the expensive one — a spec whose `capture` is secretly a string
 * resolves to a device that records at the preset's area, produces a perfectly
 * good video of the wrong size, and nobody finds out until somebody watches
 * it. A message naming the file and the index costs nothing; a silent pass
 * costs the recording.
 *
 * Deliberately shallow: only the shape this module depends on is checked here
 * — that each entry is a name or an object carrying `extends`. Whether
 * `capture.width` is a positive integer, whether a capture smaller than the
 * output is allowed, and whether the name resolves at all are the device
 * layer's own refusals (`resolveDevice`), and repeating them here would give
 * two messages for one fault that drift apart.
 */
export function readDeviceSpecs(
  module_: Record<string, unknown>,
  path = 'the script',
): Pick<LoadedScript, 'devices'> {
  const devices = module_['devices']
  if (devices === undefined) return {}
  if (!Array.isArray(devices)) {
    throw new Error(
      `"${path}" exports \`devices\` as ${describeType(devices)}, but it has to be an array: ` +
        "`export const devices = ['desktop', { extends: 'iphone', capture: { width: 1620, height: 2880 } }]`.",
    )
  }
  if (devices.length === 0) {
    throw new Error(
      `"${path}" exports an empty \`devices\` array. Name at least one device, or drop the export ` +
        'and pass --devices on the command line.',
    )
  }
  devices.forEach((spec: unknown, index: number) => {
    if (typeof spec === 'string') {
      if (spec.trim() !== '') return
      throw new Error(
        `"${path}" exports \`devices[${String(index)}]\` as an empty name.`,
      )
    }
    if (typeof spec !== 'object' || spec === null) {
      throw new Error(
        `"${path}" exports \`devices[${String(index)}]\` as ${describeType(spec)}. ` +
          'Each entry is either a device name or an object with an `extends` field.',
      )
    }
    const extendsValue = (spec as Record<string, unknown>)['extends']
    if (typeof extendsValue !== 'string' || extendsValue.trim() === '') {
      throw new Error(
        `"${path}" exports \`devices[${String(index)}]\` without a usable \`extends\`. ` +
          'An override names the preset it starts from: ' +
          "`{ extends: 'desktop', capture: { width: 3840, height: 2160 } }`.",
      )
    }
    const asValue = (spec as Record<string, unknown>)['as']
    if (
      asValue !== undefined &&
      (typeof asValue !== 'string' || asValue.trim() === '')
    ) {
      throw new Error(
        `"${path}" exports \`devices[${String(index)}].as\` as ${describeType(asValue)}. ` +
          'It names the directory the variant is filed under, so it has to be a non-empty string.',
      )
    }
  })
  return { devices: devices as readonly DeviceSpec[] }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/**
 * The exports that describe the browser context rather than the
 * recording, read and checked one by one.
 *
 * Checked here and not where they are used, because here is the only place
 * that still knows the file they came from. A `hideSelectors` that is
 * secretly a string reaches the browser as a context option, is accepted,
 * hides nothing, and the recording that follows is fine except for the card
 * that should not be in it — which is the one failure mode this whole
 * contract exists to prevent. A message that names the file and the export
 * costs a browser launch; a silent pass costs the recording and nobody
 * notices until the video is watched.
 */
export function readContextSettings(
  module_: Record<string, unknown>,
  path = 'the script',
): Pick<
  LoadedScript,
  | 'allowFramingOfApp'
  | 'fakeMedia'
  | 'fixedTime'
  | 'hideSelectors'
  | 'locale'
  | 'storageStatePath'
  | 'timezone'
> {
  const settings: {
    allowFramingOfApp?: boolean
    fakeMedia?: FakeMedia
    fixedTime?: string
    hideSelectors?: readonly string[]
    locale?: string
    storageStatePath?: string
    timezone?: string
  } = {}

  const storageStatePath = module_['storageStatePath']
  if (storageStatePath !== undefined) {
    if (typeof storageStatePath !== 'string' || storageStatePath === '') {
      throw new Error(
        `"${path}" exports \`storageStatePath\`, which has to be the path of a Playwright ` +
          "storageState file: `export const storageStatePath = 'auth/state.json'`. " +
          'It is a path and never the state itself — that file is the access, and ' +
          '`auth/` is ignored by git for exactly that reason.',
      )
    }
    settings.storageStatePath = storageStatePath
  }

  const hideSelectors = module_['hideSelectors']
  if (hideSelectors !== undefined) {
    if (
      !Array.isArray(hideSelectors) ||
      hideSelectors.some(
        (selector) => typeof selector !== 'string' || selector === '',
      )
    ) {
      throw new Error(
        `"${path}" exports \`hideSelectors\`, which has to be a list of CSS selectors: ` +
          "`export const hideSelectors = ['#cookie-banner']`.",
      )
    }
    settings.hideSelectors = hideSelectors as readonly string[]
  }

  const fixedTime = module_['fixedTime']
  if (fixedTime !== undefined) {
    if (
      typeof fixedTime !== 'string' ||
      Number.isNaN(new Date(fixedTime).getTime())
    ) {
      throw new Error(
        `"${path}" exports \`fixedTime\`, which has to be an instant a Date can read: ` +
          "`export const fixedTime = '2026-01-15T09:00:00Z'`.",
      )
    }
    settings.fixedTime = fixedTime
  }

  const fakeMedia = module_['fakeMedia']
  if (fakeMedia !== undefined) {
    settings.fakeMedia = readFakeMedia(fakeMedia, path)
  }

  const allowFramingOfApp = module_['allowFramingOfApp']
  if (allowFramingOfApp !== undefined) {
    // The same strictness as `fakeMedia`, for a sharper reason: this one
    // lowers a security header, and `'false'` switching it on is the last
    // way that should happen.
    if (typeof allowFramingOfApp !== 'boolean') {
      throw new Error(
        `"${path}" exports \`allowFramingOfApp\`, which has to be a boolean: ` +
          '`export const allowFramingOfApp = true`.',
      )
    }
    settings.allowFramingOfApp = allowFramingOfApp
  }

  const locale = module_['locale']
  if (locale !== undefined) {
    settings.locale = readLocale(locale, path)
  }

  const timezone = module_['timezone']
  if (timezone !== undefined) {
    settings.timezone = readTimezone(timezone, path)
  }

  return settings
}

/**
 * A device name as a path and object-key component: lowercase, and every run
 * of characters that are neither letters nor digits collapsed to one dash.
 * Playwright's registry names contain spaces ("Desktop Chrome HiDPI") and
 * dots ("Galaxy S24"), which are legal in an S3 key but make for URLs nobody
 * can read out loud.
 */
export function deviceSlug(device: DeviceSpec): string {
  const slug = deviceName(device)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
  return slug === '' ? 'device' : slug
}

/**
 * What a spec is called: its own `as`, else the preset it extends, else the
 * bare name. This is the string a report shows and the directory name comes
 * from, so it is derived in one place rather than at each of the three.
 */
export function deviceName(device: DeviceSpec): string {
  if (typeof device === 'string') return device
  return device.as ?? device.extends
}

/**
 * A spec with the run's `--reserve` laid over it. The name is untouched on
 * purpose: `--reserve` changes how a device is recorded for one run, not what
 * it is called, so its directory and its line in the report stay the same.
 * A spec that already names a capture size is refused by the device layer,
 * which says which two instructions collide.
 */
function withRunReserve(
  device: DeviceSpec,
  reserve: number | undefined,
): DeviceSpec {
  if (reserve === undefined) return device
  const spec: DeviceOverrides =
    typeof device === 'string' ? { extends: device } : device
  return { ...spec, reserve }
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
      ...(script.allowFramingOfApp === undefined
        ? {}
        : { allowFramingOfApp: script.allowFramingOfApp }),
      ...(script.fakeMedia === undefined
        ? {}
        : { fakeMedia: script.fakeMedia }),
      ...(script.fixedTime === undefined
        ? {}
        : { fixedTime: script.fixedTime }),
      ...(script.hideSelectors === undefined
        ? {}
        : { hideSelectors: script.hideSelectors }),
      ...(script.locale === undefined ? {} : { locale: script.locale }),
      ...(script.prepare === undefined ? {} : { prepare: script.prepare }),
      ...(script.storageStatePath === undefined
        ? {}
        : { storageStatePath: script.storageStatePath }),
      ...(script.timezone === undefined ? {} : { timezone: script.timezone }),
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

/**
 * Refuses two devices that would file their artifacts under the same name.
 *
 * Silently allowed, the second recording writes its frames into the first
 * one's directory, the render reads a mixture of the two and the result is a
 * video nobody can explain. This is the one failure the name field exists to
 * make impossible, so it is checked before any browser starts rather than
 * discovered in the output.
 */
function requireDistinctNames(devices: readonly DeviceSpec[]): void {
  const seen = new Map<string, string>()
  for (const device of devices) {
    const name = deviceName(device)
    const slug = deviceSlug(device)
    const previous = seen.get(slug)
    if (previous !== undefined) {
      throw new Error(
        `Two devices would both be filed under "${slug}": "${previous}" and "${name}". ` +
          'Give one of them a name of its own with `as`, e.g. ' +
          "`{ extends: 'desktop', as: 'desktop-4k', capture: { width: 3840, height: 2160 } }`.",
      )
    }
    seen.set(slug, name)
  }
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
  if (request.upload) deps.checkUploadConfigured()
  const script = await deps.loadScript(request.script)
  // The command line wins over the script, because it is the later and more
  // specific instruction: a script says what it is normally filmed on, and
  // `--devices` is somebody overriding that for one run.
  const devices =
    request.devices !== undefined && request.devices.length > 0
      ? request.devices
      : (script.devices ?? [])
  if (devices.length === 0) {
    throw new Error(
      `No device requested. Either pass --devices, e.g. --devices desktop-wide, or export one from ` +
        `"${request.script}": \`export const devices = ['desktop-wide']\`.`,
    )
  }
  requireDistinctNames(devices)
  const stem = scriptStem(request.script)
  const seed = request.seed ?? 1

  const outcomes: DeviceOutcome[] = []
  for (const device of devices) {
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
  device: DeviceSpec,
  stem: string,
  seed: number,
): Promise<DeviceOutcome> {
  // The outcome carries the *name*, not the spec: it is what a reader sees in
  // the report, and an override object printed into an error message is noise
  // around the one word that says which recording failed.
  const label = deviceName(device)
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
    resolved = resolveDevice(withRunReserve(device, request.reserve))
  } catch (error) {
    return {
      device: label,
      kind: 'failed',
      reason: messageOf(error),
      stage: 'device',
    }
  }

  let recorded: { capture: CaptureSettings; captureDirectory: string }
  try {
    recorded = await deps.record(resolved, directory, script, seed)
  } catch (error) {
    return {
      device: label,
      kind: 'failed',
      reason: messageOf(error),
      stage: 'record',
    }
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
      device: label,
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
      device: label,
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
      device: label,
      kind: 'rendered',
    }
  } catch (error) {
    return {
      device: label,
      kind: 'failed',
      reason: messageOf(error),
      stage: 'upload',
    }
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
