import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_OUTPUT_QUALITY,
  encoderProfile,
  qualityNumber,
  resolveEncoder,
  defaultQualityFor,
  type OutputQuality,
} from './encoders.js'
import { readVideoInfo, type VideoInfo } from './probe.js'

import type { FfmpegPlan } from './render/ffmpeg.js'

/**
 * `featurecast compare` — two videos in, one labelled side-by-side clip out.
 *
 * ## Why this is a command and not a shell line
 *
 * Every comparison this repository has shown so far was produced by a
 * hand-written `-filter_complex`: `hstack.filter` and `hstack-pointer.sh` on
 * the bench box are the surviving examples. They are unreviewable, they are
 * not reproducible by anyone who did not type them, and the labels burnt into
 * the picture — the part a reader actually believes — were never checked by
 * anything. A comparison is evidence; evidence produced by an unversioned
 * shell line is not evidence.
 *
 * ## Why slowed down, and why one file
 *
 * Two clips played separately in real time cannot be judged against each
 * other: by the time the second one plays, the first is a memory. The whole
 * reason this exists is that the judgement needs both pictures on screen at
 * the same instant, slowly enough that a single dropped frame is visible. The
 * default is 5x because that is the factor the earlier hand-written lines
 * converged on after the owner rejected real-time pairs twice.
 *
 * ## Why the labels are burnt in
 *
 * A comparison that needs a caption underneath it to be understood loses its
 * caption the first time somebody drags the file somewhere. The picture has
 * to say which side is which on its own.
 */

/** One half of the picture: a file, and what to call it on screen. */
export type CompareSide = {
  /** Burnt into the picture. Describes a *procedure*, not a product. */
  label: string
  path: string
}

export type CompareOptions = {
  /** Output frame rate. The chain's 60 unless a caller says otherwise. */
  fps?: number
  /**
   * The height both sides are brought to.
   *
   * Defaults to the taller of the two inputs. That direction is the decision:
   * the alternative — shrinking to the shorter one — would resample the
   * *better* side down, and the difference a comparison exists to show would
   * be softened away on exactly the side that was supposed to look good. A
   * side that has fewer pixels than the common height is enlarged, and its
   * label is the place to say so.
   */
  height?: number
  quality?: OutputQuality
  /** How much slower than real time. 5 unless a caller says otherwise. */
  slow?: number
}

export const DEFAULT_SLOW_FACTOR = 5
export const DEFAULT_COMPARE_FPS = 60

/**
 * Characters a burnt-in label may not contain.
 *
 * The text travels through two unescaping passes — the filtergraph parser's
 * and drawtext's — and a quote or a backslash survives neither reliably. The
 * rest of Unicode is passed through untouched inside a quoted section, so
 * colons, commas and umlauts are fine. Anything on this list is refused by
 * name rather than mangled: a label that silently lost half of itself is the
 * exact failure this command exists to stop.
 */
const REFUSED_LABEL_CHARACTERS = ["'", '\\', '\n', '\r']

function checkLabel(label: string, which: string): void {
  if (label.trim() === '') {
    throw new Error(
      `The ${which} label is empty. Both sides are labelled, or the picture ` +
        'does not say which side is which.',
    )
  }
  for (const character of REFUSED_LABEL_CHARACTERS) {
    if (label.includes(character)) {
      throw new Error(
        `The ${which} label contains ${JSON.stringify(character)}, which ` +
          'cannot be drawn into the picture. Use plain text.',
      )
    }
  }
}

function evenCeil(value: number): number {
  const ceiled = Math.ceil(value)
  return ceiled + (ceiled % 2)
}

/**
 * The common height, and the refusal to guess one.
 *
 * A probe that reports a zero or missing dimension means the file is not a
 * video this command can stack; saying so beats stacking a 0-pixel-wide
 * rectangle next to a real picture and calling it a comparison.
 */
export function commonHeight(
  probes: readonly VideoInfo[],
  requested?: number,
): number {
  for (const probe of probes) {
    if (probe.width <= 0 || probe.height <= 0) {
      throw new Error(
        `${probe.path} reports a ${String(probe.width)}x${String(probe.height)} ` +
          'video stream, which is not a picture that can be stacked.',
      )
    }
  }
  if (requested !== undefined) {
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error(
        `--height must be a positive number of pixels, got "${String(requested)}".`,
      )
    }
    return evenCeil(requested)
  }
  return evenCeil(Math.max(...probes.map((probe) => probe.height)))
}

/**
 * The filter graph: scale, hold, slow, label, stack — in that order.
 *
 * The order is load-bearing twice over. `tpad` runs *before* `setpts`, so the
 * freeze is measured in the input's own seconds and the slowdown then applies
 * to it like it applies to everything else; the other way round the shorter
 * side would hold for a fifth of the time it needs and the last seconds of
 * the longer side would play next to a black rectangle. And `drawtext` runs
 * *after* `setpts`, so the label is painted onto every output frame rather
 * than onto every fifth one.
 *
 * Holding the shorter side rather than truncating both to the shorter length
 * is the other decision here. A comparison is usually made to show what
 * happens at the end of a run — the scroll that stutters, the frame that
 * arrives late — and cutting the longer side at the shorter one's last frame
 * would throw away exactly the evidence. A frozen picture is visibly frozen;
 * a missing ending is not visibly missing.
 */
export function buildCompareFilter(
  sides: readonly [CompareSide, CompareSide],
  probes: readonly [VideoInfo, VideoInfo],
  options: CompareOptions = {},
): string {
  const slow = options.slow ?? DEFAULT_SLOW_FACTOR
  if (!Number.isFinite(slow) || slow <= 0) {
    throw new Error(
      `--slow must be a positive factor, got "${String(options.slow)}". ` +
        '5 means five times slower than real time.',
    )
  }
  for (const [index, side] of sides.entries()) {
    checkLabel(side.label, index === 0 ? 'left' : 'right')
  }
  const height = commonHeight(probes, options.height)
  const longest = Math.max(...probes.map((probe) => probe.durationSeconds))
  const fontSize = Math.max(14, Math.round(height / 28))
  const margin = Math.round(fontSize * 0.8)

  const chains = sides.map((side, index) => {
    const probe = probes[index]
    if (probe === undefined) throw new Error('A side has no probe')
    const hold = longest - probe.durationSeconds
    const steps = [`[${String(index)}:v]scale=-2:${String(height)}`, 'setsar=1']
    if (hold > 0.001) {
      steps.push(`tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`)
    }
    steps.push(`setpts=${slow.toFixed(4)}*PTS`)
    steps.push(
      `drawtext=text='${side.label}':expansion=none` +
        `:x=${String(margin)}:y=${String(margin)}` +
        `:fontsize=${String(fontSize)}:fontcolor=white` +
        `:box=1:boxcolor=black@0.72:boxborderw=${String(Math.round(fontSize / 2))}`,
    )
    return `${steps.join(',')}[side${String(index)}]`
  })

  return `${chains.join(';')};[side0][side1]hstack=inputs=2[stacked]`
}

/**
 * The whole command, ready to spawn.
 *
 * The encoder vocabulary is `src/encoders.ts`'s, not ffmpeg's, for the same
 * reason the render stage uses it: `libx264` is the name of a library, not a
 * property of the video anybody wants, and there is exactly one table in this
 * repository that translates.
 */
export function buildComparePlan(
  sides: readonly [CompareSide, CompareSide],
  probes: readonly [VideoInfo, VideoInfo],
  outputPath: string,
  options: CompareOptions = {},
): FfmpegPlan {
  const quality = options.quality ?? DEFAULT_OUTPUT_QUALITY
  const { field, value } = qualityNumber(quality)
  const profile = encoderProfile(quality.encoder)
  const fps = options.fps ?? DEFAULT_COMPARE_FPS
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`--fps must be a positive number, got "${String(fps)}".`)
  }
  return {
    arguments: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      sides[0].path,
      '-i',
      sides[1].path,
      '-filter_complex',
      buildCompareFilter(sides, probes, options),
      '-map',
      '[stacked]',
      '-r',
      String(fps),
      '-c:v',
      profile.ffmpegCodec,
      ...(profile.family === 'nvenc'
        ? ['-rc', 'vbr', `-${field}`, String(value), '-b:v', '0']
        : [`-${field}`, String(value)]),
      '-pix_fmt',
      'yuv420p',
      '-an',
      outputPath,
    ],
    command: 'ffmpeg',
  }
}

export type CompareRequest = {
  options: CompareOptions
  outputPath: string
  sides: readonly [CompareSide, CompareSide]
}

const USAGE = `featurecast compare — one labelled side-by-side clip out of two videos.

  pnpm compare <left.mp4> <right.mp4> --out <clip.mp4> [options]

  The two pictures end up in one frame, next to each other, each carrying its
  own label, slowed down so a human can actually judge them. Two clips played
  one after the other in real time cannot be compared; that is the whole
  reason this command exists.

  A label describes what was *done* to that side — "rendered at device
  resolution", "upscaled from a smaller capture". It is burnt into the
  picture, so it outlives whatever text the file was posted with.

Options
  --out <file>        Where the comparison goes. Required.
  --label-left <t>    Left caption (default: the left file's name)
  --label-right <t>   Right caption (default: the right file's name)
  --slow <n>          How much slower than real time (${String(DEFAULT_SLOW_FACTOR)})
  --height <px>       Common height (default: the taller input's)
  --fps <n>           Output frame rate (${String(DEFAULT_COMPARE_FPS)})
  --encoder <name>    x264, nvenc-h264 or nvenc-hevc (x264)
  --quality <n>       Constant quality, lower is better (23)

Unequal inputs are handled rather than ignored: both sides are scaled to a
common height, and the shorter one holds its last frame until the longer one
has played out. Nothing is cropped away silently.
`

function readNumber(name: string, value: string | undefined): number {
  const parsed = Number(value)
  if (value === undefined || !Number.isFinite(parsed)) {
    throw new Error(`${name} needs a number, got ${String(value)}`)
  }
  return parsed
}

function fileLabel(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.[^.]+$/, '')
}

/** `undefined` means "print the usage and stop", not "no arguments". */
export function parseCompareArguments(
  argv: readonly string[],
): CompareRequest | undefined {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return undefined
  }
  const positional: string[] = []
  const options: CompareOptions = {}
  let outputPath: string | undefined
  let labelLeft: string | undefined
  let labelRight: string | undefined
  let encoderName: string | undefined
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
      case '--out':
        if (next === undefined) throw new Error('--out needs a file path')
        outputPath = next
        index += 1
        break
      case '--label-left':
        if (next === undefined) throw new Error('--label-left needs a text')
        labelLeft = next
        index += 1
        break
      case '--label-right':
        if (next === undefined) throw new Error('--label-right needs a text')
        labelRight = next
        index += 1
        break
      case '--slow':
        options.slow = readNumber(argument, next)
        index += 1
        break
      case '--height':
        options.height = readNumber(argument, next)
        index += 1
        break
      case '--fps':
        options.fps = readNumber(argument, next)
        index += 1
        break
      case '--encoder':
        if (next === undefined) throw new Error('--encoder needs a value')
        encoderName = next
        index += 1
        break
      case '--quality':
        quality = readNumber(argument, next)
        index += 1
        break
      default:
        throw new Error(`Unknown option ${argument}`)
    }
  }

  const [left, right, ...rest] = positional
  if (left === undefined || right === undefined) {
    throw new Error(
      'featurecast compare needs two videos: a left one and a right one.',
    )
  }
  if (rest.length > 0) {
    // Three pictures side by side is a different command with a different
    // layout question; guessing one here would produce a shape nobody chose.
    throw new Error(
      `featurecast compare takes two videos, got ${String(rest.length + 2)}.`,
    )
  }
  if (outputPath === undefined) {
    throw new Error('--out is required: name the file the comparison goes to.')
  }
  if (outputPath === left || outputPath === right) {
    throw new Error(
      `--out ${outputPath} is one of the inputs. The comparison would ` +
        'overwrite the material it is made of.',
    )
  }
  if (encoderName !== undefined || quality !== undefined) {
    const base = defaultQualityFor(
      encoderName === undefined ? 'x264' : resolveEncoder(encoderName),
    )
    options.quality =
      quality === undefined
        ? base
        : 'crf' in base
          ? { crf: quality, encoder: base.encoder }
          : { cq: quality, encoder: base.encoder }
  }
  return {
    options,
    outputPath,
    sides: [
      { label: labelLeft ?? fileLabel(left), path: left },
      { label: labelRight ?? fileLabel(right), path: right },
    ],
  }
}

export type CompareDependencies = {
  probe: (path: string) => Promise<VideoInfo>
  run: (command: string, arguments_: readonly string[]) => Promise<void>
  write: (text: string) => void
}

/** Probes both inputs, builds the command, runs it. */
export async function runCompare(
  request: CompareRequest,
  dependencies: Partial<CompareDependencies> = {},
): Promise<void> {
  const probe = dependencies.probe ?? readVideoInfo
  const run = dependencies.run ?? runCommand
  const write = dependencies.write ?? ((text) => process.stdout.write(text))

  const probes: [VideoInfo, VideoInfo] = [
    await probe(request.sides[0].path),
    await probe(request.sides[1].path),
  ]
  const plan = buildComparePlan(
    request.sides,
    probes,
    request.outputPath,
    request.options,
  )
  await run(plan.command, plan.arguments)

  const slow = request.options.slow ?? DEFAULT_SLOW_FACTOR
  const height = commonHeight(probes, request.options.height)
  const longest = Math.max(...probes.map((one) => one.durationSeconds))
  write(
    `${request.outputPath}\n` +
      `  ${String(height)} px tall per side, ${slow.toFixed(1)}x slower, ` +
      `${(longest * slow).toFixed(1)}s long\n`,
  )
  for (const [index, side] of request.sides.entries()) {
    const info = probes[index]
    if (info === undefined) continue
    const hold = longest - info.durationSeconds
    write(
      `  ${index === 0 ? 'left ' : 'right'}  ${side.label} ` +
        `(${String(info.width)}x${String(info.height)}` +
        `${hold > 0.001 ? `, holds its last frame for ${hold.toFixed(2)}s` : ''})\n`,
    )
  }
}

function runCommand(
  command: string,
  arguments_: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with code ${String(code)}`))
    })
  })
}

export async function main(argv: readonly string[]): Promise<number> {
  let request: CompareRequest | undefined
  try {
    request = parseCompareArguments(argv)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    )
    return 2
  }
  if (request === undefined) {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    await runCompare(request)
    return 0
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }
}

// Same guard `src/cli.ts` uses: importable by the tests without running
// anything, executable as a command.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
