import { fileURLToPath } from 'node:url'

import {
  DEFAULT_ENCODER as DEFAULT_ENCODER_NAME,
  defaultQualityFor,
  resolveEncoder,
  type Encoder,
} from '../encoders.js'
import { DEFAULT_FORMATS, type FormatSpec } from './format.js'
import { renderRecording, type RenderOptions } from './render.js'

const USAGE = `featurecast render — turn a raw recording into finished videos.

  pnpm render <capture-dir> <out-dir> [options]

The capture directory is what a recording wrote: frames/, timestamps.json and
events.jsonl. No browser is started; changing a look parameter costs a re-run
of this command and nothing else.

Options
  --formats 16:9,9:16,1:1   Which aspect ratios to deliver (default: all three);
                            a size such as 1920x1200 works too
  --zoom <n>                Tightest framing allowed on a single element (2.6)
  --padding <px>            Breathing room around the element, source px (140)
  --cursor-size <px>        Arrow height / touch dot diameter, output px (46)
  --ripple <ms>             How long a click ripple blooms (520)
  --no-cursor               Draw no pointer at all
  --idle-threshold <ms>     Stillness this long may be trimmed (600)
  --idle-hold <ms>          What a trimmed stretch is compressed to (250)
  --fps <n>                 Output frame rate (the chain's 60)
  --threads <n>             Composition threads (what the machine can spare)
  --encoder <name>          x264, nvenc-h264 or nvenc-hevc (x264)
  --quality <n>             Constant quality, lower is better (23)
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
    const known = DEFAULT_FORMATS.find((spec) => spec.label === aspect)
    if (known !== undefined) return known satisfies FormatSpec
    // An explicit size. A device can promise a size that has none of the
    // three names — desktop-wide's 1920x1200 is 16:10 — and without this a
    // second render of its take could only ship a crop of it. The label is
    // the size itself, the same one `formatsFor` in the chain gives it.
    const size = /^([1-9]\d*)x([1-9]\d*)$/.exec(aspect)
    if (size !== null) {
      return {
        desired: { height: Number(size[2]), width: Number(size[1]) },
        label: aspect,
      } satisfies FormatSpec
    }
    throw new Error(
      `Unknown format "${aspect}". Available: ` +
        DEFAULT_FORMATS.map((spec) => spec.label).join(', ') +
        ', or a size such as 1920x1200',
    )
  })
}

export function parseArguments(argv: readonly string[]): Parsed {
  const positional: string[] = []
  const options: RenderOptions = {}
  const cursor: NonNullable<RenderOptions['cursor']> = {}
  const zoom: NonNullable<RenderOptions['zoom']> = {}
  const idle: NonNullable<RenderOptions['idle']> = {}
  let encoderName: Encoder = DEFAULT_ENCODER_NAME
  let quality: number | undefined

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
      case '--encoder':
        if (next === undefined) throw new Error('--encoder needs a value')
        encoderName = resolveEncoder(next)
        index += 1
        break
      case '--quality':
        quality = readNumber(argument, next)
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
  // The encoder and its quality number travel together: `-crf` and `-cq` are
  // different scales, so a number without a name is meaningless. Naming only
  // the encoder takes that encoder's own default.
  if (encoderName !== DEFAULT_ENCODER_NAME || quality !== undefined) {
    const base = defaultQualityFor(encoderName)
    options.encoder =
      quality === undefined
        ? base
        : 'crf' in base
          ? { crf: quality, encoder: base.encoder }
          : { cq: quality, encoder: base.encoder }
  }
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
      `  ${output.label.padEnd(9)} ${output.width}x${output.height}  ${output.outputPath}\n`,
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
