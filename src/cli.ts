import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { listPresetNames } from './devices.js'
import { ENCODERS, resolveEncoder, type Encoder } from './encoders.js'
import {
  runPipeline,
  scriptStem,
  type PipelineDependencies,
} from './pipeline.js'

/**
 * The `featurecast` command.
 *
 * Argument parsing is `node:util`'s `parseArgs`, not a dependency. What this
 * command needs is four flags and one positional, with no subcommand tree, no
 * shell completion and no interpolated help — which is the subset `parseArgs`
 * covers outright. `package.json` has never carried a runtime dependency (see
 * the header of src/upload.ts for the same argument made about the AWS SDK),
 * and a `commander`-shaped tree would be the first, in exchange for
 * formatting the usage text below.
 */

const USAGE = `featurecast run <script> [options]

  Records <script> once per device, runs the recording through
  post-production — zoom, pointer, idle trimming — and optionally uploads
  what comes out.

  A look is not changed here. Every look parameter belongs to \`pnpm render\`,
  which reads a finished recording and costs no browser run: that is the whole
  reason post-production is its own stage, and putting its dials on this
  command would invite a re-record to change a colour.

  The script exports the body of the recording, it does not call record():

    export const url = 'https://app.example.com'

    export default async (page, demo) => {
      await page.goto('https://app.example.com/feature')
      await demo.click('#nav-settings')
    }

  \`url\` names the application. Optional for a pointer device, required for
  a touch one: a mobile recording films the application inside a shell served
  from its own origin, and that origin has to be known before the first frame.

  \`devices\` says what it is filmed on. A bare name is a preset or a
  Playwright device; an object overrides any field of it, and \`as\` gives the
  variant its own name and directory:

    export const devices = [
      'desktop-wide',
      { extends: 'iphone', as: 'phone-with-reserve',
        capture: { width: 1620, height: 2880 } },
    ]

  Three further exports describe the browser context, which a script cannot
  reach itself — it is handed a page that is already open:

    export const storageStatePath = 'auth/state.json'
    export const hideSelectors = ['#cookie-banner', '#internal-card']
    export const fixedTime = '2026-01-15T09:00:00Z'

  That is how a signed-in application is filmed. \`storageStatePath\` is the
  path of a Playwright storage state and never the state itself: the file is
  the access, it stays under \`auth/\`, which git ignores.

  A touch recording of an application that forbids framing (X-Frame-Options:
  DENY, frame-ancestors 'none') needs one more. It relaxes exactly those
  headers on the filmed document, inside the recording browser only:

    export const allowFramingOfApp = true

Options
  --devices <a,b>   Comma-separated device or preset names. Overrides the
                    script's own \`devices\` export for this run. Required only
                    when the script does not name any.
  --all-formats     Deliver 16:9, 9:16 and 1:1 instead of the one size the
                    device promises. One recording either way.
  --out <dir>       Root output directory. Default: artifacts/<script name>.
  --upload          Upload each finished video and print its URL.
  --encoder <name>  Override the encoder: ${ENCODERS.join(', ')}.
  --seed <n>        Seed for pointer motion and typing delays. Default 1.
  --help            This text.

Presets
  ${listPresetNames().join(', ')}
  — plus every name in Playwright's own device registry.
`

export type CliDependencies = {
  pipeline: Partial<PipelineDependencies>
  write: (text: string) => void
  writeError: (text: string) => void
}

/**
 * Parses arguments and runs the pipeline. Returns the process exit code
 * rather than calling `process.exit`, so the whole command is testable.
 *
 * Every failure leaves through here as a message, never as a stack trace: the
 * errors this command surfaces — an unconfigured upload, an unknown device
 * name, a capture area nobody has decided — are all written to be read by the
 * person who typed the command, and a stack trace above them buries the one
 * line that says what to do.
 */
export async function runCli(
  argv: readonly string[],
  dependencies: Partial<CliDependencies> = {},
): Promise<number> {
  const write = dependencies.write ?? ((text) => process.stdout.write(text))
  const writeError =
    dependencies.writeError ?? ((text) => process.stderr.write(text))

  let request: ReturnType<typeof parseRunArguments>
  try {
    request = parseRunArguments(argv)
  } catch (error) {
    writeError(`${messageOf(error)}\n\n${USAGE}`)
    return 2
  }
  if (request === undefined) {
    write(USAGE)
    return 0
  }

  try {
    const report = await runPipeline(request, {
      report: (line) => {
        write(`${line}\n`)
      },
      ...dependencies.pipeline,
    })
    return report.ok ? 0 : 1
  } catch (error) {
    writeError(`${messageOf(error)}\n`)
    return 1
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `undefined` means "print the usage and stop", not "no arguments". */
function parseRunArguments(argv: readonly string[]):
  | undefined
  | {
      allFormats: boolean
      devices?: string[]
      encoder?: Encoder
      out: string
      script: string
      seed?: number
      upload: boolean
    } {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...argv],
    options: {
      'all-formats': { type: 'boolean' },
      devices: { type: 'string' },
      encoder: { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      out: { type: 'string' },
      seed: { type: 'string' },
      upload: { type: 'boolean' },
    },
    strict: true,
  })
  if (values.help === true) return undefined
  const [command, script, ...rest] = positionals
  if (command === undefined) return undefined
  if (command !== 'run') {
    throw new Error(`Unknown command "${command}". The only command is "run".`)
  }
  if (script === undefined) {
    throw new Error('featurecast run needs the path of a recording script.')
  }
  if (rest.length > 0) {
    // Two scripts in one run would need two output roots and two sets of
    // URLs; naming them one per invocation keeps that unambiguous.
    throw new Error(
      `featurecast run takes one script, got ${String(rest.length + 1)}: ${[script, ...rest].join(', ')}.`,
    )
  }
  // Not required any more: a script may name its own devices, and overriding
  // that per run is what this flag is for. An empty `--devices desktop,,` is
  // still an empty list and reaches the pipeline as one, which refuses it
  // there with the message that knows both sources.
  const devices = (values.devices ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  return {
    allFormats: values['all-formats'] === true,
    ...(devices.length > 0 ? { devices } : {}),
    out: values.out ?? `artifacts/${scriptStem(script)}`,
    script,
    upload: values.upload === true,
    ...(values.encoder === undefined
      ? {}
      : { encoder: resolveEncoder(values.encoder) }),
    ...(values.seed === undefined ? {} : { seed: parseSeed(values.seed) }),
  }
}

function parseSeed(raw: string): number {
  const seed = Number(raw)
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`--seed must be a non-negative integer, got "${raw}".`)
  }
  return seed
}

// Same guard `demo/record-smoke.ts` uses: the module is importable by the
// tests without running anything, and executable as a command.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2))
}
