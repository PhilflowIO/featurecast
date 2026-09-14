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

  Records <script> once per device, renders each recording to MP4 and
  optionally uploads it.

  The script exports the body of the recording, it does not call record():

    export default async (page, demo) => {
      await page.goto('https://app.example.com/feature')
      await demo.click('#nav-settings')
    }

Options
  --devices <a,b>   Comma-separated device or preset names. Required.
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
      devices: string[]
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
  const devices = (values.devices ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  if (devices.length === 0) {
    throw new Error(
      `--devices is required, e.g. --devices desktop-wide. Presets: ${listPresetNames().join(', ')}.`,
    )
  }
  return {
    devices,
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
