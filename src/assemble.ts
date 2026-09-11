import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { validateCaptureManifest, type TimestampManifest } from './capture.js'

const OUTPUT_SIZE = { height: 1080, width: 1920 }
export const FRAME_RATE = 60

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
) => Promise<void>

export type AssembleResult = {
  durationSeconds: number
}

function frameDurationsSeconds(frames: TimestampManifest['frames']): number[] {
  const durations: number[] = []
  for (let index = 1; index < frames.length; index += 1) {
    const current = frames[index]
    const previous = frames[index - 1]
    if (current === undefined || previous === undefined) {
      throw new Error('unreachable: manifest frame array index out of bounds')
    }
    durations.push((current.timestamp - previous.timestamp) / 1000)
  }
  return durations
}

/**
 * Creates an ffconcat input that retains the screencast's uneven source
 * timing. ffmpeg then samples it into a constant 60-fps output timeline.
 *
 * Frame paths are written as absolute paths. ffmpeg's concat demuxer
 * resolves relative entries against the *list file's own directory*, not
 * the process cwd — a relative `framesDirectory` (as used for a relative
 * `--out`) would otherwise get prefixed twice, e.g. `capture/frames/x.jpg`
 * listed from inside `capture/timeline.ffconcat` resolves to
 * `capture/capture/frames/x.jpg` and ffmpeg fails to open it.
 */
export function buildCaptureTimeline(
  framesDirectory: string,
  manifest: TimestampManifest,
): string {
  validateCaptureManifest(manifest)
  const durations = frameDurationsSeconds(manifest.frames)
  const elapsed = durations.reduce((total, duration) => total + duration, 0)
  const finalDuration = Math.max(0, manifest.session.duration / 1000 - elapsed)
  const lines = ['ffconcat version 1.0']
  const lastFrame = manifest.frames.at(-1)
  if (lastFrame === undefined) {
    throw new Error('unreachable: validateCaptureManifest requires frames')
  }
  const framePath = (file: string): string =>
    resolve(join(framesDirectory, file)).replaceAll("'", "'\\\\''")

  for (const [index, frame] of manifest.frames.entries()) {
    lines.push(`file '${framePath(frame.file)}'`)
    const duration = durations[index] ?? finalDuration
    if (duration > 0) {
      lines.push(`duration ${duration}`)
    }
  }
  // The concat demuxer uses the final file's duration only when it is repeated.
  lines.push(`file '${framePath(lastFrame.file)}'`)
  return `${lines.join('\n')}\n`
}

export function buildFfmpegArguments(
  timelinePath: string,
  outputPath: string,
): string[] {
  return [
    '-hide_banner',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    timelinePath,
    '-vf',
    `crop=2560:1440:0:80,scale=${OUTPUT_SIZE.width}:${OUTPUT_SIZE.height}:flags=lanczos,fps=${FRAME_RATE}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(FRAME_RATE),
    outputPath,
  ]
}

export async function assembleScreencast(
  captureDirectory: string,
  outputPath: string,
  runner: CommandRunner = runCommand,
): Promise<AssembleResult> {
  const manifest = JSON.parse(
    await readFile(join(captureDirectory, 'timestamps.json'), 'utf8'),
  ) as TimestampManifest
  validateCaptureManifest(manifest)
  const timelinePath = join(captureDirectory, 'timeline.ffconcat')
  await writeFile(
    timelinePath,
    buildCaptureTimeline(join(captureDirectory, 'frames'), manifest),
    { flag: 'wx' },
  )
  await runner('ffmpeg', buildFfmpegArguments(timelinePath, outputPath))
  return { durationSeconds: manifest.session.duration / 1000 }
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
