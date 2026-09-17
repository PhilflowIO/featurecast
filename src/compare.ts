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
 * ## Why one file, and why real time
 *
 * Two clips played separately cannot be judged against each other: by the
 * time the second one plays, the first is a memory. The judgement needs both
 * pictures on screen at the same instant — that is what the command is for.
 *
 * It runs at **real time**, and the reason is the opposite of obvious. Slow
 * motion is the better instrument for *inspecting* two results: at a fifth
 * speed a single late frame is visible, which is exactly what an internal
 * A/B wants to see. It is the wrong thing to publish. A pointer path that is
 * smooth at real speed reads as a stutter at 5x, so a slowed comparison
 * argues against the tool it was made to defend — the viewer's conclusion is
 * not "look how even that is", it is "why is the mouse lagging".
 *
 * So `--slow` stays, and is an inspection tool. Nothing shown to somebody who
 * has not already made up their mind should use it.
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
  /**
   * Where both sides start, in the inputs' own seconds.
   *
   * A comparison whose point arrives after a minute does not get watched to
   * the end. The offset is deliberately the same for both sides: a comparison
   * that starts the two halves at different moments is not comparing them,
   * and there is no honest reason to want that.
   */
  from?: number
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
  /**
   * How much slower than real time.
   *
   * 1 — real time — unless a caller says otherwise. Raise it to *inspect* a
   * pair, never to present one: see this module's header for why a slowed
   * comparison makes the smooth side look broken.
   */
  slow?: number
}

/**
 * Real time.
 *
 * This was 5 and the first comparisons were all made at it, which was a
 * mistake with a direction: every one of them made the product look worse
 * than it is, because slowing a smooth motion down is indistinguishable from
 * a motion that was never smooth.
 */
export const DEFAULT_SLOW_FACTOR = 1
export const DEFAULT_COMPARE_FPS = 60

/**
 * How tall the caption band is, as a multiple of the font size.
 *
 * 1.9 leaves roughly half a line of air above and below the glyphs, which is
 * what stops the band reading as a crop of the picture rather than a caption
 * belonging to it. It is derived rather than tabulated so that a comparison of
 * two phone recordings and a comparison of two 1080p ones get bands in the
 * same proportion to their type.
 */
const BAND_HEIGHT_EM = 1.9

/** The colour behind the caption. Not a shade of the picture — a border. */
const BAND_COLOUR = 'black'

/**
 * The band the caption sits in, in pixels.
 *
 * The first version of this command had no band: it painted the caption onto
 * the video with a translucent plate behind it, and every clip it produced
 * covered the filmed application's own header — its title and its dark-mode
 * toggle — with the words describing it. A comparison exists to be evidence,
 * and a caption that eats the top row of the thing it captions destroys
 * evidence to save vertical space nobody was short of.
 */
export function labelBandHeight(fontSize: number): number {
  const band = Math.round(fontSize * BAND_HEIGHT_EM)
  return band + (band % 2)
}

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
 * How wide a side ends up once it has been scaled to the common height.
 *
 * Not the probed width: the side that gets enlarged is the one whose label is
 * most likely to run off the edge, and the label has to be sized against the
 * picture it will actually sit on.
 */
export function scaledWidth(probe: VideoInfo, height: number): number {
  return Math.round((probe.width * height) / probe.height)
}

/**
 * The average advance width of a glyph, as a fraction of the font size.
 *
 * freetype does not tell the filter graph how wide a string will be before it
 * draws it, so the fit has to be estimated. 0.62 em is a deliberate
 * over-estimate for the container's default sans face — real mixed-case text
 * averages nearer 0.5 — because the failure modes are not symmetric: a label
 * ten per cent smaller than it could be is merely modest, while a label ten
 * per cent too wide walks off the edge of its own half of the picture and the
 * comparison ships with half a sentence on it.
 */
const GLYPH_ADVANCE_EM = 0.62

/**
 * One font size for both labels, chosen so the longer of the two fits.
 *
 * The first version of this read the common height and nothing else, and the
 * first real comparison it produced — a 1080x1920 phone recording next to a
 * 540x960 one — came out with `upscaled from a 540x960 capture` cut off after
 * `captur`. The height says how *tall* a legible label is; how *wide* it may
 * be is a question about the side it sits on and the number of characters in
 * it, and neither of those was being asked. Both sides get the same size,
 * because two captions in different sizes read as a hierarchy that is not
 * there.
 */
export function labelFontSize(
  sides: readonly CompareSide[],
  probes: readonly VideoInfo[],
  height: number,
): number {
  const fromHeight = Math.round(height / 28)
  const fits = sides.map((side, index) => {
    const probe = probes[index]
    if (probe === undefined) return fromHeight
    // The box border eats a little on each end, and a caption pressed against
    // the frame edge reads as an accident even when it fits.
    const budget = scaledWidth(probe, height) * 0.92
    return Math.floor(budget / (GLYPH_ADVANCE_EM * side.label.length))
  })
  return Math.max(14, Math.min(fromHeight, ...fits))
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
/**
 * What is left of each input once the start offset has been skipped.
 *
 * The offset has to reach the *durations* and not only the ffmpeg command,
 * because the durations are what decide which side is the longer one and how
 * long the other has to hold. Skipping ten seconds off the front of a twelve
 * second clip and an eleven second one swaps which of the two that is.
 */
export function afterStart(
  probes: readonly VideoInfo[],
  from: number | undefined,
): VideoInfo[] {
  const start = from ?? 0
  if (!Number.isFinite(start) || start < 0) {
    throw new Error(
      `--from must be a number of seconds from the start, got "${String(from)}".`,
    )
  }
  return probes.map((probe) => {
    const left = probe.durationSeconds - start
    if (left <= 0) {
      throw new Error(
        `--from ${String(start)}s is past the end of ${probe.path}, which is ` +
          `${probe.durationSeconds.toFixed(2)}s long. There would be nothing ` +
          'left of that side to compare.',
      )
    }
    return { ...probe, durationSeconds: left }
  })
}

export function buildCompareFilter(
  sides: readonly [CompareSide, CompareSide],
  rawProbes: readonly [VideoInfo, VideoInfo],
  options: CompareOptions = {},
): string {
  const probes = afterStart(rawProbes, options.from) as [VideoInfo, VideoInfo]
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
  const fontSize = labelFontSize(sides, probes, height)
  const margin = Math.round(fontSize * 0.8)
  const band = labelBandHeight(fontSize)

  const chains = sides.map((side, index) => {
    const probe = probes[index]
    if (probe === undefined) throw new Error('A side has no probe')
    const hold = longest - probe.durationSeconds
    const steps = [`[${String(index)}:v]scale=-2:${String(height)}`, 'setsar=1']
    if (hold > 0.001) {
      steps.push(`tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`)
    }
    steps.push(`setpts=${slow.toFixed(4)}*PTS`)
    // The band is added above the picture and the picture is pushed down into
    // what is left, so no frame of either input is under the caption. Both
    // sides get the same band, which is what keeps the two halves flush.
    steps.push(
      `pad=iw:ih+${String(band)}:0:${String(band)}:color=${BAND_COLOUR}`,
    )
    steps.push(
      `drawtext=text='${side.label}':expansion=none` +
        `:x=${String(margin)}:y=(${String(band)}-text_h)/2` +
        `:fontsize=${String(fontSize)}:fontcolor=white`,
    )
    return `${steps.join(',')}[side${String(index)}]`
  })

  return `${chains.join(';')};[side0][side1]hstack=inputs=2[stacked]`
}

/**
 * The size of the finished frame: two sides wide, one band taller than the
 * material.
 *
 * Worth being able to state, rather than only observable after an encode. An
 * output no taller than its inputs is precisely what a caption that has
 * fallen back onto the picture looks like from the outside, and the two are
 * otherwise indistinguishable without opening the file and looking.
 */
export function compareOutputSize(
  sides: readonly [CompareSide, CompareSide],
  rawProbes: readonly [VideoInfo, VideoInfo],
  options: CompareOptions = {},
): { band: number; height: number; width: number } {
  const probes = afterStart(rawProbes, options.from) as [VideoInfo, VideoInfo]
  const height = commonHeight(probes, options.height)
  const band = labelBandHeight(labelFontSize(sides, probes, height))
  return {
    band,
    height: height + band,
    width: probes.reduce(
      (total, probe) => total + scaledWidth(probe, height),
      0,
    ),
  }
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
  // `-ss` before each `-i` rather than once after them: it has to seek both
  // inputs, and the same number twice is the only offset that leaves the two
  // sides comparable.
  const seek = (options.from ?? 0) > 0 ? ['-ss', String(options.from)] : []
  return {
    arguments: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...seek,
      '-i',
      sides[0].path,
      ...seek,
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
  --slow <n>          Slow both sides down by this factor (${String(DEFAULT_SLOW_FACTOR)}, real time).
                      An inspection tool: at a fifth speed a late frame is
                      visible, and a smooth one looks late. Do not publish it.
  --from <s>          Skip this many seconds off the front of both sides
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
      case '--from':
        options.from = readNumber(argument, next)
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
  const left = afterStart(probes, request.options.from)
  const size = compareOutputSize(request.sides, probes, request.options)
  const longest = Math.max(...left.map((one) => one.durationSeconds))
  write(
    `${request.outputPath}\n` +
      `  ${String(size.width)}x${String(size.height)}, of which ` +
      `${String(size.band)} px is caption band above the picture; ` +
      `${slow.toFixed(1)}x slower, ${(longest * slow).toFixed(1)}s long\n`,
  )
  for (const [index, side] of request.sides.entries()) {
    const info = left[index]
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
