export const OUTPUT_FRAME_RATE = 60

export type SourceFrameSpan = {
  end: number
  file: string
  index: number
  start: number
}

/**
 * Parses a `timeline.ffconcat` file (as written by `buildCaptureTimeline`)
 * into per-source-frame display spans, in seconds, cumulative from 0.
 */
export function parseTimelineSpans(ffconcat: string): SourceFrameSpan[] {
  const files = [...ffconcat.matchAll(/^file '(.+)'$/gm)].map(
    (match) => match[1]!,
  )
  const durations = [...ffconcat.matchAll(/^duration (.+)$/gm)].map((match) =>
    Number(match[1]),
  )
  const spans: SourceFrameSpan[] = []
  let cursor = 0
  for (let index = 0; index < durations.length; index += 1) {
    const duration = durations[index]!
    const file = files[index]
    if (file === undefined) {
      throw new Error(
        `unreachable: timeline.ffconcat has a duration line without a matching file line at index ${String(index)}`,
      )
    }
    spans.push({ end: cursor + duration, file, index, start: cursor })
    cursor += duration
  }
  return spans
}

/**
 * Maps every 60fps output frame to the source-frame index it displays,
 * sampling the exact same spans ffmpeg's `fps=60` filter samples — this is
 * decode-independent and exact, not a perceptual/pixel-diff approximation,
 * and has no minimum-duration floor. That last property is the whole
 * point: ffmpeg's `freezedetect` filter (the previous version of this
 * gate) requires `d=1` (at least 1s) to register anything as frozen, so a
 * video that changes content once per second — however static the frame
 * is for the other 59/60ths of that second — sails through it. Proven
 * blind on two synthetic counter-examples (see `repeats.test.ts`) built to
 * exploit exactly that floor.
 */
export function mapOutputFramesToSource(
  spans: readonly SourceFrameSpan[],
): number[] {
  const total = spans.at(-1)?.end ?? 0
  const outputFrameCount = Math.round(total * OUTPUT_FRAME_RATE)
  const sourceIndexPerOutputFrame: number[] = []
  let spanIndex = 0
  for (let frame = 0; frame < outputFrameCount; frame += 1) {
    const midpoint = (frame + 0.5) / OUTPUT_FRAME_RATE
    while (spanIndex < spans.length - 1 && midpoint >= spans[spanIndex]!.end) {
      spanIndex += 1
    }
    sourceIndexPerOutputFrame.push(spans[spanIndex]!.index)
  }
  return sourceIndexPerOutputFrame
}

export type MotionWindowSeconds = {
  end: number
  label: string
  start: number
}

export type RepeatedFrameWindowReport = {
  distinctSourceFrames: number
  effectiveFps: number
  label: string
  outputFrames: number
  repeatedOutputFrames: number
  repeatedShare: number
}

export type RepeatedFrameReport = {
  motionWindowRepeatedShare: number
  overallOutputFrames: number
  overallRepeatedShare: number
  scrollWindowRepeatedShare: number
  windows: RepeatedFrameWindowReport[]
}

/**
 * Reports the share of 60fps output frames that are exact repeats of the
 * immediately preceding output frame's source image — overall, per
 * scripted motion window, and across scroll windows specifically. This is
 * the metric M1's acceptance gate judges "no duplicate frames" against;
 * see `mapOutputFramesToSource`'s doc comment for why the previous
 * freezedetect-based version could not see this.
 */
export function computeRepeatedFrameReport(
  sourceIndexPerOutputFrame: readonly number[],
  motionWindows: readonly MotionWindowSeconds[],
): RepeatedFrameReport {
  const outputFrameCount = sourceIndexPerOutputFrame.length
  let overallRepeated = 0
  for (let frame = 1; frame < outputFrameCount; frame += 1) {
    if (
      sourceIndexPerOutputFrame[frame] === sourceIndexPerOutputFrame[frame - 1]
    ) {
      overallRepeated += 1
    }
  }

  const windows = motionWindows.map((window) => {
    const start = Math.max(1, Math.round(window.start * OUTPUT_FRAME_RATE))
    const end = Math.min(
      outputFrameCount - 1,
      Math.round(window.end * OUTPUT_FRAME_RATE),
    )
    let repeated = 0
    let count = 0
    const distinct = new Set<number>()
    for (let frame = start; frame <= end; frame += 1) {
      count += 1
      distinct.add(sourceIndexPerOutputFrame[frame]!)
      if (
        sourceIndexPerOutputFrame[frame] ===
        sourceIndexPerOutputFrame[frame - 1]
      ) {
        repeated += 1
      }
    }
    const seconds = count / OUTPUT_FRAME_RATE
    return {
      distinctSourceFrames: distinct.size,
      effectiveFps: seconds > 0 ? distinct.size / seconds : 0,
      label: window.label,
      outputFrames: count,
      repeatedOutputFrames: repeated,
      repeatedShare: count > 0 ? repeated / count : 0,
    }
  })

  const motionTotals = windows.reduce(
    (totals, window) => ({
      count: totals.count + window.outputFrames,
      repeated: totals.repeated + window.repeatedOutputFrames,
    }),
    { count: 0, repeated: 0 },
  )
  const scrollTotals = windows
    .filter((window) => window.label.includes('scroll'))
    .reduce(
      (totals, window) => ({
        count: totals.count + window.outputFrames,
        repeated: totals.repeated + window.repeatedOutputFrames,
      }),
      { count: 0, repeated: 0 },
    )

  return {
    motionWindowRepeatedShare:
      motionTotals.count > 0 ? motionTotals.repeated / motionTotals.count : 0,
    overallOutputFrames: outputFrameCount,
    overallRepeatedShare:
      outputFrameCount > 1 ? overallRepeated / (outputFrameCount - 1) : 0,
    scrollWindowRepeatedShare:
      scrollTotals.count > 0 ? scrollTotals.repeated / scrollTotals.count : 0,
    windows,
  }
}

/** Above this, scripted motion time is mostly duplicate frames — a scripting or pipeline bug, not load latency. */
const DEFAULT_MAX_MOTION_WINDOW_REPEATED_SHARE = 0.4
/** Above this, the recording as a whole is mostly a slideshow. */
const DEFAULT_MAX_OVERALL_REPEATED_SHARE = 0.5

/** Fails on the exact repeated-output-frame share computed above, not a perceptual approximation of it. */
export function validateRepeatedFrameReport(
  report: RepeatedFrameReport,
  maxMotionWindowRepeatedShare = DEFAULT_MAX_MOTION_WINDOW_REPEATED_SHARE,
  maxOverallRepeatedShare = DEFAULT_MAX_OVERALL_REPEATED_SHARE,
): void {
  if (report.motionWindowRepeatedShare > maxMotionWindowRepeatedShare) {
    throw new Error(
      `${(report.motionWindowRepeatedShare * 100).toFixed(1)}% of output frames inside scripted motion windows are exact repeats of the previous frame (${String(report.windows.reduce((t, w) => t + w.repeatedOutputFrames, 0))} of ${String(report.windows.reduce((t, w) => t + w.outputFrames, 0))}) — exceeds the ${(maxMotionWindowRepeatedShare * 100).toFixed(0)}% limit`,
    )
  }
  if (report.overallRepeatedShare > maxOverallRepeatedShare) {
    throw new Error(
      `${(report.overallRepeatedShare * 100).toFixed(1)}% of the whole output is a repeat of the previous frame — exceeds the ${(maxOverallRepeatedShare * 100).toFixed(0)}% limit`,
    )
  }
}
