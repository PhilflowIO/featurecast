import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { readVideoInfo, type VideoInfo } from '../probe.js'

import {
  DEFAULT_BACKGROUND,
  DEFAULT_FPS,
  DEFAULT_HEIGHT,
  DEFAULT_MARGIN,
  DEFAULT_OVERLAP,
  buildMontagePlan,
  checkPieceCount,
  montageLayout,
  type MontageOptions,
  type MontagePiece,
} from './montage.js'
import { SHELL_KINDS, drawShell, isShellKind } from './shell.js'

const USAGE = `featurecast montage — one picture of the same app on every device.

  pnpm montage <a.mp4> <b.mp4> [c.mp4] [d.mp4] --out <clip.mp4> \\
    --device monitor --device tablet --device phone [options]

  The recordings are laid into drawn device shells, standing on one line,
  overlapping, playing together. Each keeps its own shape: a phone take stays
  a phone take, and nothing is cropped out of a desktop picture.

  There is one --device per video, in the same order. Kinds: ${SHELL_KINDS.join(', ')}.

Options
  --out <path>          where the montage is written (required)
  --device <kind>       one per video, in order (required)
  --height <px>         picture height, default ${String(DEFAULT_HEIGHT)}
  --overlap <fraction>  how far each device overlaps the one before,
                        default ${String(DEFAULT_OVERLAP)}
  --margin <fraction>   space around the picture, as a fraction of its
                        height, default ${String(DEFAULT_MARGIN)}
  --background <colour> ffmpeg colour name, or "transparent" for an alpha
                        movie, default ${DEFAULT_BACKGROUND}
  --fps <n>             output frame rate, default ${String(DEFAULT_FPS)}
  --still <path.png>    also write one frame as a still
  --still-at <seconds>  which second the still is taken from, default 1
`

export type MontageRequest = {
  options: MontageOptions
  outputPath: string
  pieces: readonly MontagePiece[]
  still?: { at: number; path: string }
}

function readNumber(name: string, value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} needs a number, got "${String(value)}".`)
  }
  return parsed
}

export function parseMontageArguments(argv: readonly string[]): MontageRequest {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...argv],
    options: {
      background: { type: 'string' },
      device: { multiple: true, type: 'string' },
      fps: { type: 'string' },
      height: { type: 'string' },
      margin: { type: 'string' },
      out: { type: 'string' },
      overlap: { type: 'string' },
      still: { type: 'string' },
      'still-at': { type: 'string' },
    },
  })
  if (values.out === undefined || values.out.trim() === '') {
    throw new Error('--out names the file the montage is written to.')
  }
  checkPieceCount(positionals.length)
  const kinds = values.device ?? []
  if (kinds.length !== positionals.length) {
    throw new Error(
      `Give one --device per video: ${String(positionals.length)} videos, ${String(kinds.length)} devices.`,
    )
  }
  const pieces = positionals.map((path, index) => {
    const kind = kinds[index]
    if (kind === undefined || !isShellKind(kind)) {
      throw new Error(
        `"${String(kind)}" is not a device kind. Use one of: ${SHELL_KINDS.join(', ')}.`,
      )
    }
    return { kind, path }
  })
  const options: MontageOptions = {}
  if (values.background !== undefined) options.background = values.background
  if (values.fps !== undefined) options.fps = readNumber('--fps', values.fps)
  if (values.height !== undefined) {
    options.height = readNumber('--height', values.height)
  }
  if (values.margin !== undefined) {
    options.margin = readNumber('--margin', values.margin)
  }
  if (values.overlap !== undefined) {
    options.overlap = readNumber('--overlap', values.overlap)
  }
  const request: MontageRequest = {
    options,
    outputPath: values.out,
    pieces,
  }
  if (values.still !== undefined) {
    request.still = {
      at:
        values['still-at'] === undefined
          ? 1
          : readNumber('--still-at', values['still-at']),
      path: values.still,
    }
  }
  return request
}

export type MontageDependencies = {
  probe: (path: string) => Promise<VideoInfo>
  run: (command: string, arguments_: readonly string[]) => Promise<void>
  write: (text: string) => void
}

export async function runMontage(
  request: MontageRequest,
  dependencies: Partial<MontageDependencies> = {},
): Promise<void> {
  const probe = dependencies.probe ?? readVideoInfo
  const run = dependencies.run ?? runCommand
  const write = dependencies.write ?? ((text) => process.stdout.write(text))

  const probes: VideoInfo[] = []
  for (const piece of request.pieces) {
    probes.push(await probe(piece.path))
  }
  const layout = montageLayout(request.pieces, probes, request.options)

  const scratch = await mkdtemp(join(tmpdir(), 'featurecast-montage-'))
  try {
    const shellPaths: string[] = []
    for (const [index, piece] of layout.pieces.entries()) {
      const path = join(scratch, `shell-${String(index)}-${piece.kind}.png`)
      await writeFile(path, drawShell(piece.shell).toPng())
      shellPaths.push(path)
    }
    const plan = buildMontagePlan(
      layout,
      shellPaths,
      request.outputPath,
      request.options,
    )
    await run(plan.command, plan.arguments)
    if (request.still !== undefined) {
      await run('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(Math.min(request.still.at, layout.seconds)),
        '-i',
        request.outputPath,
        '-frames:v',
        '1',
        request.still.path,
      ])
    }
  } finally {
    await rm(scratch, { force: true, recursive: true })
  }

  write(
    `${request.outputPath}\n` +
      `  ${String(layout.width)}x${String(layout.height)}, ${layout.seconds.toFixed(2)}s\n`,
  )
  for (const [index, piece] of layout.pieces.entries()) {
    const info = probes[index]
    if (info === undefined) continue
    // Three recordings of one script are three browser runs and never the
    // same length. Saying by how much each was cut is the difference between
    // a montage and a montage with one device quietly frozen at the end.
    const cut = info.durationSeconds - layout.seconds
    write(
      `  ${piece.kind.padEnd(7)}  ${piece.path} ` +
        `(${String(piece.shell.screen.width)}x${String(piece.shell.screen.height)}` +
        `${cut > 0.001 ? `, ${cut.toFixed(2)}s cut off the end` : ''})\n`,
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
  let request: MontageRequest
  try {
    request = parseMontageArguments(argv)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    )
    return 2
  }
  try {
    await runMontage(request)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }
  return 0
}

// Compared by resolved path, not by filename: `endsWith('cli.ts')` once made
// `tsx src/cli.ts` start a second CLI as soon as anything imported from it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    })
}
