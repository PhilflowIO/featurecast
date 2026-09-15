import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DEFAULT_CURSOR_LOOK, type CursorLook } from './cursor.js'
import { parseEventLog, parseEventTimes, toTimedEvents } from './events.js'
import {
  buildDecodePlan,
  buildEncodePlan,
  buildSourceList,
  sourceFrameForOutput,
  type EncoderOptions,
} from './ffmpeg.js'
import type { AspectName } from './format.js'
import {
  planRender,
  serializePlan,
  type PlanOptions,
  type RenderPlan,
} from './plan.js'
import {
  runPipeline,
  type CursorPainter,
  type PipelineSpawn,
} from './pipeline.js'
import { SpriteCache } from './sprite.js'

export type RenderOptions = PlanOptions & {
  encoder?: EncoderOptions
  /** Write the decisions and the frame list, but do not encode. */
  dryRun?: boolean
  /** Test seam: how child processes are started. */
  spawn?: PipelineSpawn
  /**
   * Composition threads. Defaults to what the machine can spare. The picture
   * does not depend on it — any count produces the same bytes — so this is a
   * speed dial and nothing else.
   */
  threads?: number
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
 * Reads the log's clock.
 *
 * A missing file is an error rather than a fallback, and deliberately so: the
 * renderer used to estimate event times from the log's tick counter, and the
 * estimate was wrong by up to 42 s on a one-minute recording without ever
 * saying so. A recording made before #9 cannot be rendered correctly and must
 * be made again; saying that out loud is cheaper than a silently mistimed
 * video. A recording with no events at all is not affected — there is nothing
 * to time.
 */
async function readEventTimes(captureDirectory: string): Promise<string> {
  try {
    return await readFile(join(captureDirectory, 'event-times.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error(
      `${captureDirectory}/event-times.jsonl is missing. The event log carries ` +
        'no time of its own, so this recording cannot be placed on the ' +
        'capture clock — record it again with a current build.',
    )
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
  // One origin for both artifacts: the capture's own start. The frames are
  // already relative to it, and the event times are epoch readings from the
  // same machine's clock, so this subtraction is the whole of #9.
  const timedEvents =
    events.length === 0
      ? []
      : toTimedEvents(
          events,
          parseEventTimes(await readEventTimes(captureDirectory)),
          manifest.session.startedAt,
        )
  const plan = planRender(
    {
      frames: manifest.frames,
      sessionDurationMs: manifest.session.duration,
      sessionStartedAt: manifest.session.startedAt,
      source: manifest.captureSize,
    },
    timedEvents,
    options,
  )

  await mkdir(outDirectory, { recursive: true })
  const decisionsPath = join(outDirectory, 'decisions.json')
  await writeFile(decisionsPath, serializePlan(plan), 'utf8')

  const listPath = join(outDirectory, 'source-frames.ffconcat')
  await writeFile(
    listPath,
    buildSourceList(join(captureDirectory, 'frames'), plan),
    'utf8',
  )

  const cursorLook: Required<CursorLook> = {
    ...DEFAULT_CURSOR_LOOK,
    ...options.cursor,
  }
  const drawsCursor = plan.formats.some((format) =>
    format.frames.some((frame) => frame.cursor !== null),
  )
  let cursor: CursorPainter | null = null
  if (drawsCursor) {
    const sprites = new SpriteCache(cursorLook)
    cursor = { geometry: sprites.geometry, sprites }
  }

  const outputs: RenderOutput[] = plan.formats.map((format) => ({
    aspect: format.aspect,
    clamps: format.clamps,
    height: format.output.height,
    outputPath: join(outDirectory, `${aspectSlug(format.aspect)}.mp4`),
    width: format.output.width,
  }))

  if (options.dryRun !== true) {
    await runPipeline({
      cursor,
      decode: buildDecodePlan(listPath),
      encode: plan.formats.map((format, index) => {
        const output = outputs[index]
        if (output === undefined) {
          throw new Error('unreachable: one output per format')
        }
        return {
          ...buildEncodePlan(
            format.output,
            plan.fps,
            output.outputPath,
            options.encoder,
          ),
          format,
        }
      }),
      plan,
      source: manifest.captureSize,
      sourceForOutput: sourceFrameForOutput(plan),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.threads === undefined ? {} : { threads: options.threads }),
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
