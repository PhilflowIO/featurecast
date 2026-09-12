import { describe, expect, it } from 'vitest'

import {
  extractPresentedFrameTimes,
  PRESENTED_FRAME_TRACE_CATEGORIES,
  type TraceEvent,
} from '../src/presented.js'

/**
 * Every fixture below is shaped after real events pulled out of
 * `~/featurecast-bench/out/arm-sbpat-r1.trace.json.gz` on the AI box — a
 * full 69.6s recording of the product path against the patched Chromium
 * build. A verbatim one, for the record:
 *
 * ```json
 * {"args":{"frame_reporter":{"affects_smoothness":false,
 *  "display_trace_id":-6566863629714865629,"frame_sequence":262,
 *  "frame_source":4294967296,"has_compositor_animation":true,
 *  "has_high_latency":true,"has_main_animation":false,
 *  "has_missing_content":false,"layer_tree_host_id":2,
 *  "scroll_state":"SCROLL_NONE","state":"STATE_PRESENTED_ALL",
 *  "surface_frame_trace_id":-6566863629714865156}},
 *  "cat":"cc,benchmark,disabled-by-default-devtools.timeline.frame",
 *  "id2":{"local":"0x3"},"name":"PipelineReporter","ph":"b","pid":171,
 *  "tid":189,"ts":1028974606036}
 * ```
 *
 * The fields dropped here (`display_trace_id`, `frame_sequence`, ...) are
 * dropped because nothing reads them, not because they were invented away.
 */
const FRAME_CATEGORY =
  'cc,benchmark,disabled-by-default-devtools.timeline.frame'
const RENDERER_PID = 171
const BROWSER_UI_PID = 97

function clockSyncMark(wallClockMs: number, traceMicros: number): TraceEvent {
  return {
    cat: 'blink.user_timing',
    name: `fcsync:${String(wallClockMs)}`,
    ph: 'R',
    pid: RENDERER_PID,
    ts: traceMicros,
  }
}

function reporter(options: {
  beginMicros: number
  endMicros: number
  local?: string
  pid?: number
  state: string
  tid?: number
}): TraceEvent[] {
  const identity = {
    cat: FRAME_CATEGORY,
    id2: { local: options.local ?? '0x3' },
    name: 'PipelineReporter',
    pid: options.pid ?? RENDERER_PID,
    tid: options.tid ?? 189,
  }
  return [
    {
      ...identity,
      args: { frame_reporter: { state: options.state } },
      ph: 'b',
      ts: options.beginMicros,
    },
    { ...identity, ph: 'e', ts: options.endMicros },
  ]
}

describe('PRESENTED_FRAME_TRACE_CATEGORIES', () => {
  it('is the two categories the matching events actually carry', () => {
    // The frame category unlocks `PipelineReporter` (all 11 152 of them in
    // the reference trace carry it), `blink.user_timing` unlocks the
    // `fcsync:` marks. The harness this grew out of recorded seven
    // categories for a 125-138MB raw trace; these two are 13-15% of it.
    expect([...PRESENTED_FRAME_TRACE_CATEGORIES]).toEqual([
      'disabled-by-default-devtools.timeline.frame',
      'blink.user_timing',
    ])
    for (const category of PRESENTED_FRAME_TRACE_CATEGORIES) {
      expect(
        FRAME_CATEGORY.split(',').includes(category) ||
          category === 'blink.user_timing',
      ).toBe(true)
    }
  })
})

describe('extractPresentedFrameTimes', () => {
  it('places presented frames on the capture clock using the fcsync marks', () => {
    // Trace clock is 1 000 000µs ahead of nothing in particular; the marks
    // say trace 1 000 000µs == wall 5 000ms, so offset is +4 000ms.
    const events: TraceEvent[] = [
      clockSyncMark(5_000, 1_000_000),
      ...reporter({
        beginMicros: 1_010_000,
        endMicros: 1_025_000,
        state: 'STATE_PRESENTED_ALL',
      }),
      clockSyncMark(6_000, 2_000_000),
    ]

    // Bucketed at the `e` timestamp — the moment the frame was presented,
    // not the moment its pipeline began, which is 15ms earlier at the
    // measured median.
    expect(extractPresentedFrameTimes(events)).toEqual([5_025])
  })

  it('counts partially presented frames, which are presented frames too', () => {
    // Counting only STATE_PRESENTED_ALL put captured-over-presented above 1
    // in 4, 4 and 12 motion windows of the three reference runs, peaking at
    // 2.17. A denominator the numerator can double is not a denominator.
    const events: TraceEvent[] = [
      clockSyncMark(0, 0),
      ...reporter({
        beginMicros: 1_000,
        endMicros: 2_000,
        state: 'STATE_PRESENTED_ALL',
      }),
      ...reporter({
        beginMicros: 3_000,
        endMicros: 4_000,
        state: 'STATE_PRESENTED_PARTIAL',
      }),
    ]

    expect(extractPresentedFrameTimes(events)).toEqual([2, 4])
  })

  it('ignores frames the compositor decided needed no update', () => {
    // ~1 400 of these per run. Nothing changed on screen, so there was
    // nothing for the capture to miss and nothing to divide by.
    const events: TraceEvent[] = [
      clockSyncMark(0, 0),
      ...reporter({
        beginMicros: 1_000,
        endMicros: 2_000,
        state: 'STATE_NO_UPDATE_DESIRED',
      }),
      ...reporter({
        beginMicros: 3_000,
        endMicros: 4_000,
        state: 'STATE_DROPPED',
      }),
    ]

    expect(extractPresentedFrameTimes(events)).toEqual([])
  })

  it("ignores the browser UI compositor's own presented frames", () => {
    // Two processes emit PipelineReporter: the renderer hosting the recorded
    // page and the browser's own UI compositor. Measured over the scroll
    // windows of the reference runs, the browser process contributed 0
    // frames on one arm and 47-52 on the others — so counting both does not
    // merely inflate the denominator, it inflates it unevenly and silently
    // reorders any comparison between arms. The renderer is identified as
    // the process carrying the fcsync marks, i.e. the one the page runs in.
    const events: TraceEvent[] = [
      clockSyncMark(0, 0),
      ...reporter({
        beginMicros: 1_000,
        endMicros: 2_000,
        state: 'STATE_PRESENTED_ALL',
      }),
      ...reporter({
        beginMicros: 3_000,
        endMicros: 4_000,
        pid: BROWSER_UI_PID,
        state: 'STATE_PRESENTED_ALL',
      }),
    ]

    expect(extractPresentedFrameTimes(events)).toEqual([2])
  })

  it('pairs overlapping reporters on the same thread without crossing them', () => {
    // PipelineReporter is an async event and several are open at once; the
    // pairing keys on `id2.local` plus `tid` and is last-in-first-out within
    // a key, so a nested pair cannot steal the outer pair's end timestamp.
    const events: TraceEvent[] = [
      clockSyncMark(0, 0),
      ...reporter({
        beginMicros: 1_000,
        endMicros: 9_000,
        local: '0x3',
        state: 'STATE_PRESENTED_ALL',
      }),
      ...reporter({
        beginMicros: 2_000,
        endMicros: 5_000,
        local: '0x4',
        state: 'STATE_PRESENTED_ALL',
      }),
    ]

    expect(extractPresentedFrameTimes(events)).toEqual([5, 9])
  })

  it('averages several clock marks rather than trusting one', () => {
    // Date.now() itself has sub-millisecond noise; two marks taken either
    // side of the recording cancel most of it.
    const events: TraceEvent[] = [
      clockSyncMark(1_000, 0), // offset +1000
      clockSyncMark(2_002, 1_000_000), // offset +1002
      ...reporter({
        beginMicros: 500_000,
        endMicros: 500_000,
        state: 'STATE_PRESENTED_ALL',
      }),
    ]

    expect(extractPresentedFrameTimes(events)).toEqual([1_501])
  })

  it('refuses a trace with no clock marks instead of inventing an origin', () => {
    // Without the marks the trace's microsecond origin is arbitrary, every
    // presented frame would land outside every motion window, and the
    // denominator would read zero — which `computeCaptureEfficiencyReport`
    // scores as 100% efficient. Silence here is the worst possible failure.
    expect(() =>
      extractPresentedFrameTimes(
        reporter({
          beginMicros: 1_000,
          endMicros: 2_000,
          state: 'STATE_PRESENTED_ALL',
        }),
      ),
    ).toThrow(/no fcsync: clock marks/)
  })
})
