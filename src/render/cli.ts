import { fileURLToPath } from 'node:url'
import { DEFAULT_FORMATS, type AspectName, type FormatSpec } from './format.js'
import { renderRecording, type RenderOptions } from './render.js'

const USAGE = `featurecast render — turn a raw recording into finished videos.

  pnpm render <capture-dir> <out-dir> [options]

The capture directory is what a recording wrote: frames/, timestamps.json and
events.jsonl. No browser is started; changing a look parameter costs a re-run
of this command and nothing else.

Options
  --formats 16:9,9:16,1:1   Which aspect ratios to deliver (default: all three)
  --zoom <n>                Tightest framing allowed on a single element (2.6)
  --padding <px>            Breathing room around the element, source px (140)
  --cursor-size <px>        Arrow height / touch dot diameter, output px (46)
  --ripple <ms>             How long a click ripple blooms (520)
  --no-cursor               Draw no pointer at all
  --idle-threshold <ms>     Stillness this long may be trimmed (600)
  --idle-hold <ms>          What a trimmed stretch is compressed to (250)
  --fps <n>                 Output frame rate (60)
  --threads <n>             Composition threads (what the machine can spare)
  --crf <n>                 x264 quality, lower is better (18)
  --preset <name>           x264 preset (medium)
  --dry-run                 Write decisions and commands, skip the encode
`

type Parsed = {
  captureDirectory: string
  options: RenderOptions
  outDirectory: string
}

function readNumber(name: string, value: string | undefined): number {
  const parsed = Number(value)
  if (value === undefined || !Number.isFinite(parsed)) {
    throw new Error(`${name} needs a number, got ${String(value)}`)
  }
  return parsed
}

function readFormats(value: string | undefined): readonly FormatSpec[] {
  if (value === undefined) throw new Error('--formats needs a value')
  const wanted = value.split(',').map((entry) => entry.trim())
  return wanted.map((aspect) => {
    const known = DEFAULT_FORMATS.find((spec) => spec.aspect === aspect)
    if (known === undefined) {
      throw new Error(
        `Unknown format "${aspect}". Available: ` +
          DEFAULT_FORMATS.map((spec) => spec.aspect).join(', '),
      )
    }
    return known satisfies FormatSpec & { aspect: AspectName }
  })
}

export function parseArguments(argv: readonly string[]): Parsed {
  const positional: string[] = []
  const options: RenderOptions = {}
  const cursor: NonNullable<RenderOptions['cursor']> = {}
  const zoom: NonNullable<RenderOptions['zoom']> = {}
  const idle: NonNullable<RenderOptions['idle']> = {}
  const encoder: NonNullable<RenderOptions['encoder']> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const next = argv[index + 1]
    switch (argument) {
      case '--formats':
        options.formats = readFormats(next)
        index += 1
        break
      case '--zoom':
        zoom.maxZoom = readNumber(argument, next)
        index += 1
        break
      case '--padding':
        zoom.paddingPx = readNumber(argument, next)
        index += 1
        break
      case '--cursor-size':
        cursor.sizePx = readNumber(argument, next)
        index += 1
        break
      case '--ripple':
        cursor.rippleMs = readNumber(argument, next)
        index += 1
        break
      case '--no-cursor':
        cursor.visible = false
        break
      case '--idle-threshold':
        idle.thresholdMs = readNumber(argument, next)
        index += 1
        break
      case '--idle-hold':
        idle.compressToMs = readNumber(argument, next)
        index += 1
        break
      case '--fps':
        options.fps = readNumber(argument, next)
        index += 1
        break
      case '--threads':
        options.threads = readNumber(argument, next)
        index += 1
        break
      case '--crf':
        encoder.crf = readNumber(argument, next)
        index += 1
        break
      case '--preset':
        if (next === undefined) throw new Error('--preset needs a value')
        encoder.preset = next
        index += 1
        break
      case '--dry-run':
        options.dryRun = true
        break
      default:
        throw new Error(`Unknown option ${argument}`)
    }
  }

  const [captureDirectory, outDirectory] = positional
  if (captureDirectory === undefined || outDirectory === undefined) {
    throw new Error(
      'Both a capture directory and an output directory are required',
    )
  }
  if (Object.keys(cursor).length > 0) options.cursor = cursor
  if (Object.keys(zoom).length > 0) options.zoom = zoom
  if (Object.keys(idle).length > 0) options.idle = idle
  if (Object.keys(encoder).length > 0) options.encoder = encoder
  return { captureDirectory, options, outDirectory }
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    process.stdout.write(USAGE)
    return
  }
  const { captureDirectory, options, outDirectory } = parseArguments(argv)
  const started = Date.now()
  const result = await renderRecording(captureDirectory, outDirectory, options)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  process.stdout.write(
    `Rendered ${result.outputs.length} format(s) in ${seconds}s ` +
      `(${result.durationSeconds.toFixed(2)}s of video, ` +
      `${result.removedIdleSeconds.toFixed(2)}s of stillness trimmed)\n`,
  )
  for (const output of result.outputs) {
    process.stdout.write(
      `  ${output.aspect.padEnd(5)} ${output.width}x${output.height}  ${output.outputPath}\n`,
    )
    for (const clamp of output.clamps) {
      process.stdout.write(`    ! ${clamp}\n`)
    }
  }
}

// Compared against this module's own path, not against a file *name*. The
// chain's entry point is `src/cli.ts`, so `endsWith('cli.ts')` matched it too:
// the moment anything in the chain imported from here — sharing the look flags
// is the obvious reason to — `tsx src/cli.ts` would also start the render CLI,
// which would then die on the chain's own `--devices`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
