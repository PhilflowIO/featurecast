import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DEFAULT_CURSOR_LOOK, type CursorLook } from './cursor.js'
import { parseEventLog } from './events.js'
import {
  buildFfmpegPlan,
  buildGeometryCommands,
  buildRenderTimeline,
  type EncoderOptions,
} from './ffmpeg.js'
import type { AspectName } from './format.js'
import {
  planRender,
  serializePlan,
  type PlanOptions,
  type RenderPlan,
} from './plan.js'
import { SpriteCache } from './sprite.js'

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
) => Promise<void>

export type RenderOptions = PlanOptions & {
  encoder?: EncoderOptions
  /** Write every decision and every command, but do not encode. */
  dryRun?: boolean
  runner?: CommandRunner
}

export type RenderOutput = {
  aspect: AspectName
  clamps: readonly string[]
  outputPath: string
  height: number
  width: number
}

export type RenderResult = {
  decisionsPath: string
  durationSeconds: number
  outputs: readonly RenderOutput[]
  plan: RenderPlan
  removedIdleSeconds: number
}

/** `16:9` is not a file name on every filesystem worth supporting. */
export function aspectSlug(aspect: AspectName): string {
  return aspect.replace(':', '-')
}

type CaptureManifest = {
  captureSize: { height: number; width: number }
  frames: ReadonlyArray<{ file: string; timestamp: number }>
  session: { duration: number; startedAt: number }
}

async function readManifest(
  captureDirectory: string,
): Promise<CaptureManifest> {
  const text = await readFile(join(captureDirectory, 'timestamps.json'), 'utf8')
  const manifest = JSON.parse(text) as CaptureManifest
  if (
    manifest.frames === undefined ||
    manifest.frames.length === 0 ||
    manifest.session === undefined ||
    manifest.captureSize === undefined
  ) {
    throw new Error(
      `${captureDirectory}/timestamps.json is not a capture manifest ` +
        '(expected captureSize, frames and session)',
    )
  }
  return manifest
}

async function readEvents(captureDirectory: string): Promise<string> {
  try {
    return await readFile(join(captureDirectory, 'events.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Renders one raw recording into every requested format.
 *
 * No browser is involved and none can be: the inputs are the frames the
 * capture already wrote and the event log beside them. That is the whole point
 * of the two-artifact design — a different pointer size, a different zoom, a
 * different aspect ratio is a re-run of this function, not a re-run of the
 * script.
 */
export async function renderRecording(
  captureDirectory: string,
  outDirectory: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const manifest = await readManifest(captureDirectory)
  const events = parseEventLog(await readEvents(captureDirectory))
  const plan = planRender(
    {
      frames: manifest.frames,
      sessionDurationMs: manifest.session.duration,
      sessionStartedAt: manifest.session.startedAt,
      source: manifest.captureSize,
    },
    events,
    options,
  )

  await mkdir(outDirectory, { recursive: true })
  const decisionsPath = join(outDirectory, 'decisions.json')
  await writeFile(decisionsPath, serializePlan(plan), 'utf8')

  const timelinePath = join(outDirectory, 'render-timeline.ffconcat')
  await writeFile(
    timelinePath,
    buildRenderTimeline(join(captureDirectory, 'frames'), plan),
    'utf8',
  )

  const cursorLook: Required<CursorLook> = {
    ...DEFAULT_CURSOR_LOOK,
    ...options.cursor,
  }
  const reference = plan.formats[0]
  const drawsCursor =
    reference !== undefined &&
    reference.frames.some((frame) => frame.cursor !== null)
  let cursorPattern: string | null = null
  let spriteGeometry = null
  if (drawsCursor && reference !== undefined) {
    const cache = new SpriteCache(cursorLook)
    spriteGeometry = cache.geometry
    const cursorDirectory = join(outDirectory, 'cursor')
    await mkdir(cursorDirectory, { recursive: true })
    for (const frame of reference.frames) {
      const png =
        frame.cursor === null
          ? cache.png(cursorLook.kind, null)
          : cache.png(frame.cursor.kind, frame.cursor.ripplePhase)
      await writeFile(
        join(cursorDirectory, `${String(frame.n).padStart(6, '0')}.png`),
        png,
      )
    }
    cursorPattern = join(cursorDirectory, '%06d.png')
  }

  const runner = options.runner ?? runCommand
  const outputs: RenderOutput[] = []
  for (const format of plan.formats) {
    const slug = aspectSlug(format.aspect)
    const commandsPath = join(outDirectory, `geometry-${slug}.cmds`)
    await writeFile(
      commandsPath,
      buildGeometryCommands(format, plan.fps, spriteGeometry),
      'utf8',
    )
    const outputPath = join(outDirectory, `${slug}.mp4`)
    const ffmpeg = buildFfmpegPlan(
      format,
      plan,
      {
        commands: commandsPath,
        cursorPattern,
        outputPath,
        timeline: timelinePath,
      },
      options.encoder,
    )
    if (options.dryRun !== true) {
      await runner(ffmpeg.command, ffmpeg.arguments)
    }
    outputs.push({
      aspect: format.aspect,
      clamps: format.clamps,
      height: format.output.height,
      outputPath,
      width: format.output.width,
    })
  }

  return {
    decisionsPath,
    durationSeconds: plan.idle.outputDurationMs / 1000,
    outputs,
    plan,
    removedIdleSeconds: plan.idle.removedMs / 1000,
  }
}

function runCommand(
  command: string,
  arguments_: readonly string[],
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} exited with code ${String(code)}`))
    })
  })
}
