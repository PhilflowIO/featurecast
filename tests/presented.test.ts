import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  extractPresentedFrameTimes,
  PRESENTED_FRAME_TRACE_CATEGORIES,
  resolveRefreshHz,
  summarizePresentationCadence,
  type TraceEvent,
} from '../src/presented.js'

/**
 * What Chromium reports on `Tracing.tracingComplete` for a recording whose
 * trace buffer held everything. Spelling it out at every call site is the
 * point: the argument is required rather than defaulted, so a caller that
 * has not thought about trace loss cannot accidentally assert there was
 * none.
 */
const COMPLETE = { dataLossOccurred: false }

/**
 * Every fixture below is shaped after real events pulled out of
 * the trace `arm-sbpat-r1.trace.json.gz`, recorded on the AI box — a
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

/**
 * A verbatim excerpt of a real trace, not a shaped fixture.
 *
 * Provenance: the trace `arm-sbpat-r1.trace.json.gz`, recorded on the AI
 * box — the 69.6s product recording of the benchmark path against the patched
 * Chromium build, the same run the numbers in `docs/CAPTURE-CADENCE.md` come
 * from. The excerpt is the first 400ms stretch of that trace containing both
 * a partial-only presentation instant and at least four twinned ones, taken
 * with every `PipelineReporter` record of the renderer process that closes
 * inside it, two records of the browser's own UI compositor from the same
 * index range, and the run's two real `fcsync:` clock marks. Only fields
 * nothing reads were dropped (`display_trace_id`, `frame_sequence`,
 * `scroll_state`, ...); every `ts`, `pid`, `tid`, `id2.local` and `state`
 * below is the byte Chromium wrote.
 *
 * This exists because the synthetic fixtures above could not fail the way
 * the shipped code failed: none of them contained two presentation records
 * sharing an `e` timestamp, which is the case real recordings hit on roughly
 * every second screen update. A mutation test cannot find a gap that is
 * missing from the input.
 */
const REAL_TRACE_EXCERPT = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/presented-arm-sbpat-r1-excerpt.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as TraceEvent[]

/** Independent of `src/presented.ts`: pairs by `id2.local`+`tid`, LIFO, in this file. */
function presentedEndMicrosOfExcerpt(pid: number): number[] {
  const open = new Map<string, TraceEvent[]>()
  const ends: number[] = []
  for (const event of REAL_TRACE_EXCERPT) {
    if (event.name !== 'PipelineReporter' || event.pid !== pid) continue
    const key = `${event.id2?.local ?? ''}|${String(event.tid ?? '')}`
    if (event.ph === 'b') {
      open.set(key, [...(open.get(key) ?? []), event])
      continue
    }
    const stack = open.get(key)
    const begin = stack?.pop()
    if (begin === undefined || event.ts === undefined) continue
    const reporter = begin.args?.['frame_reporter'] as
      { state?: string } | undefined
    if (
      reporter?.state === 'STATE_PRESENTED_ALL' ||
      reporter?.state === 'STATE_PRESENTED_PARTIAL'
    ) {
      ends.push(event.ts)
    }
  }
  return ends
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
    expect(extractPresentedFrameTimes(events, COMPLETE)).toEqual([5_025])
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

    expect(extractPresentedFrameTimes(events, COMPLETE)).toEqual([2, 4])
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

    expect(extractPresentedFrameTimes(events, COMPLETE)).toEqual([])
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

    expect(extractPresentedFrameTimes(events, COMPLETE)).toEqual([2])
  })

  it('pairs overlapping reporters without crossing them', () => {
    // PipelineReporter is an async event and several are open at once; the
    // pairing keys on `id2.local`, so a concurrent reporter cannot steal
    // another one's end timestamp.
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

    expect(extractPresentedFrameTimes(events, COMPLETE)).toEqual([5, 9])
  })

  it('refuses a reporter id that is opened twice instead of dropping one', () => {
    // No real trace produces this: over 24 recordings, in all four shapes
    // checked, no `id2.local` is ever open twice at once. Round two removed
    // the LIFO stack that handled it, which was right — but what replaced it
    // kept the newer record and silently discarded the older one's
    // presentation instant, one lost instant per overlapping pair. The
    // counterexample below is the size of that: 20 pairs, 40 real
    // presentations, and the silent version scores 20 — half a denominator,
    // which doubles the capture efficiency built on it. An input shape
    // nothing has ever produced is exactly the one that must not be guessed
    // at quietly.
    const identity = {
      cat: FRAME_CATEGORY,
      id2: { local: '0x3' },
      name: 'PipelineReporter',
      pid: RENDERER_PID,
      tid: 189,
    }
    const events: TraceEvent[] = [clockSyncMark(0, 0)]
    for (let pair = 0; pair < 20; pair += 1) {
      const base = 1_000 + pair * 100_000
      events.push(
        {
          ...identity,
          args: { frame_reporter: { state: 'STATE_PRESENTED_ALL' } },
          ph: 'b',
          ts: base,
        },
        {
          ...identity,
          args: { frame_reporter: { state: 'STATE_PRESENTED_ALL' } },
          ph: 'b',
          ts: base + 10_000,
        },
        { ...identity, ph: 'e', ts: base + 20_000 },
        { ...identity, ph: 'e', ts: base + 30_000 },
      )
    }

    expect(() => extractPresentedFrameTimes(events, COMPLETE)).toThrow(
      /two overlapping PipelineReporter records for id2\.local=0x3/,
    )
  })

  it('does not let one begin record close twice', () => {
    // The mirror image of the case above: the `b` of a second reporter was
    // dropped from the trace buffer, so its `e` arrives alone. Reusing the
    // already-closed record would invent a presentation at that timestamp —
    // a phantom frame in the denominator, which reads as capture *loss*.
    const identity = {
      cat: FRAME_CATEGORY,
      id2: { local: '0x3' },
      name: 'PipelineReporter',
      pid: RENDERER_PID,
      tid: 189,
    }
    const events: TraceEvent[] = [
      clockSyncMark(0, 0),
      {
        ...identity,
        args: { frame_reporter: { state: 'STATE_PRESENTED_ALL' } },
        ph: 'b',
        ts: 1_000,
      },
      { ...identity, ph: 'e', ts: 2_000 },
      { ...identity, ph: 'e', ts: 18_667 },
    ]

    expect(extractPresentedFrameTimes(events, COMPLETE)).toEqual([2])
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

    expect(extractPresentedFrameTimes(events, COMPLETE)).toEqual([1_501])
  })

  it('counts one presented frame per presentation instant, not per report', () => {
    // Chromium files several PipelineReporter records for one screen update,
    // all carrying the same `e` timestamp. Summing records inflated a real
    // run's denominator from 1510 to 2238 and a single window's presented
    // rate to 89.8fps on a 60Hz compositor.
    const sameInstant = 4_000
    const events: TraceEvent[] = [
      clockSyncMark(0, 0),
      ...reporter({
        beginMicros: 1_000,
        endMicros: sameInstant,
        local: '0x3',
        state: 'STATE_PRESENTED_ALL',
      }),
      ...reporter({
        beginMicros: 2_000,
        endMicros: sameInstant,
        local: '0x156',
        state: 'STATE_PRESENTED_PARTIAL',
      }),
      ...reporter({
        beginMicros: 20_000,
        endMicros: 20_667,
        local: '0x4',
        state: 'STATE_PRESENTED_PARTIAL',
      }),
    ]

    // Three reports, two instants — and the partial-only one at 20.667ms is
    // kept, because a partial presentation that has no `ALL` twin is a real,
    // separate screen update (measured: 83 of them per run, 16.6ms after
    // their predecessor at the median).
    expect(extractPresentedFrameTimes(events, COMPLETE)).toEqual([4, 20.667])
  })

  describe('against a verbatim excerpt of a real recording', () => {
    it('has inputs that actually reach the twinned-report case', () => {
      // Reachability, asserted before anything is concluded from the
      // fixture: without twins in the input, every assertion below passes
      // just as happily on code that counts reports.
      const ends = presentedEndMicrosOfExcerpt(RENDERER_PID)
      const distinct = new Set(ends)
      expect(ends.length).toBe(51)
      expect(distinct.size).toBe(26)
      expect(ends.length - distinct.size).toBe(25)
    })

    it('returns one time per presentation instant', () => {
      // 26 is not read back out of `src/presented.ts`: it is what the
      // pairing re-implemented in this file finds, and what the independent
      // Python extraction on the box reports for the same excerpt.
      const times = extractPresentedFrameTimes(REAL_TRACE_EXCERPT, COMPLETE)
      expect(times.length).toBe(26)
      expect(new Set(times).size).toBe(26)
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index]).toBeGreaterThan(times[index - 1] as number)
      }
    })

    it('stays under the refreshes the excerpt spans', () => {
      // The outer anchor: this bound comes from the display refresh rate,
      // not from the code under test. A stretch from the first instant to
      // the last spans `floor(span / refresh) + 1` refreshes — the fencepost
      // matters, and getting it wrong is what made this bound decorative in
      // round two. Over twelve full runs the distinct instants exceed it by
      // at most 2 and the raw report count by 35-51, so this still separates
      // the two by an order of magnitude.
      const times = extractPresentedFrameTimes(REAL_TRACE_EXCERPT, COMPLETE)
      const first = times[0] as number
      const last = times[times.length - 1] as number
      const spanSeconds = (last - first) / 1000
      expect(times.length).toBeLessThanOrEqual(
        Math.floor(spanSeconds * 60) + 1 + 3,
      )
    })

    it('is too short an excerpt to state the display rate, and says so', () => {
      // Worth pinning because it is tempting to read one off anyway. These
      // 26 instants are a verbatim slice of a 69.6s recording on a 60.0Hz
      // box, and the median of their 25 gaps reads 61.5Hz — 2.5% high, which
      // on a three-second window is two frames of ceiling. The whole run
      // supplies 782-888 in-band gaps and lands inside 0.5Hz of the truth;
      // an excerpt is for testing the pairing, not the display.
      const times = extractPresentedFrameTimes(REAL_TRACE_EXCERPT, COMPLETE)
      expect(times.length).toBe(26)
      expect(() => resolveRefreshHz(times)).toThrow(
        /Cannot read a refresh interval/,
      )
    })

    it("still drops the browser UI compositor's own presentations", () => {
      // The excerpt carries two of them; without the process filter the
      // count would not be 26.
      expect(presentedEndMicrosOfExcerpt(BROWSER_UI_PID).length).toBe(2)
    })
  })

  it('refuses a trace Chromium says it lost events from', () => {
    // The denominator's lower bound, and the only direction no ratio can
    // see. A short denominator moves capture efficiency *towards* the gate:
    // on the `r2a` numbers 84.2% becomes 88.5% at 5% denominator loss, 93.2%
    // at 10% and 105.4% at 20%. The counterexample is the pair — the very
    // same events score 26 instants when Chromium says the buffer held, and
    // are refused outright when it says it did not. A better number out of a
    // worse recording is the failure this pipeline keeps shipping.
    expect(
      extractPresentedFrameTimes(REAL_TRACE_EXCERPT, {
        dataLossOccurred: false,
      }).length,
    ).toBe(26)
    expect(() =>
      extractPresentedFrameTimes(REAL_TRACE_EXCERPT, {
        dataLossOccurred: true,
      }),
    ).toThrow(/dataLossOccurred/)
  })

  it('refuses a recording whose page ran in two renderers', () => {
    // The clock marks identify the renderer the recorded page lives in, and
    // the presented frames of every other process are dropped. With marks
    // from two processes that identification is a coin toss, and whichever
    // way it lands the presentations of the other renderer are gone — a
    // denominator missing roughly half its frames, which reads as roughly
    // twice the capture efficiency. Round two picked the first mark's
    // process; picking the last was a mutation no test could see, because
    // nothing said the choice was wrong in the first place.
    const events: TraceEvent[] = [
      clockSyncMark(0, 0),
      { ...clockSyncMark(0, 0), pid: BROWSER_UI_PID },
      ...reporter({
        beginMicros: 1_000,
        endMicros: 2_000,
        state: 'STATE_PRESENTED_ALL',
      }),
    ]

    expect(() => extractPresentedFrameTimes(events, COMPLETE)).toThrow(
      /clock marks from 2 processes/,
    )
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
        COMPLETE,
      ),
    ).toThrow(/no fcsync: clock marks/)
  })
})

describe('resolveRefreshHz', () => {
  /** `count` instants exactly one refresh apart at `hz`. */
  function atRate(hz: number, count: number): number[] {
    return Array.from({ length: count }, (_, index) => (index * 1000) / hz)
  }

  it('reads the display rate out of the instants rather than assuming 60', () => {
    // The bound in `src/efficiency.ts` used to have 60 compiled into it. On
    // a 120Hz display that rejects every window longer than 67ms; at 144Hz
    // it rejected all 38 motion windows of a real run; below about 40Hz it
    // stops binding at all. A constant that is only true of one machine is a
    // second assumption, not an outer anchor.
    expect(resolveRefreshHz(atRate(60, 200))).toBeCloseTo(60, 6)
    expect(resolveRefreshHz(atRate(120, 200))).toBeCloseTo(120, 6)
    expect(resolveRefreshHz(atRate(144, 200))).toBeCloseTo(144, 6)
  })

  it('is not thrown off by skipped refreshes or sub-refresh instants', () => {
    // Real runs contain both: gaps of two and three refreshes where the
    // compositor missed a deadline, and gaps under half a refresh where a
    // partially presented frame reached the screen between them. The
    // estimator takes the median of the gaps a single refresh can occupy, so
    // neither kind moves it.
    const instants = atRate(60, 200)
    const withNoise = [
      ...instants,
      ...instants.slice(0, 20).map((time) => time + 3),
      ...atRate(60, 20).map((time) => time * 3 + 50_000),
    ].sort((a, b) => a - b)

    expect(resolveRefreshHz(withNoise)).toBeCloseTo(60, 1)
  })

  it('refuses to invent a rate it cannot read', () => {
    // A handful of instants cannot establish a refresh interval, and a
    // fabricated one silently widens or closes the ceiling built on it.
    expect(() => resolveRefreshHz([0, 16.7, 33.3])).toThrow(
      /Cannot read a refresh interval/,
    )
  })
})

describe('summarizePresentationCadence', () => {
  /** Instants `every` refreshes apart on a display running at `hz`. */
  function everyNth(hz: number, every: number, count: number): number[] {
    return Array.from(
      { length: count },
      (_, index) => (index * every * 1000) / hz,
    )
  }

  it('tells a page that moves every refresh from one that moves every second', () => {
    // Issue #116: both of these clear a 95 % yield gate, and only the
    // cadence tells them apart.
    const full = summarizePresentationCadence(everyNth(60, 1, 200), 60)
    expect(full.medianGapMs).toBeCloseTo(16.67, 2)
    expect(full.singleRefreshShare).toBe(1)
    expect(full.doubledRefreshShare).toBe(0)

    const halved = summarizePresentationCadence(everyNth(60, 2, 200), 60)
    expect(halved.medianGapMs).toBeCloseTo(33.33, 2)
    expect(halved.singleRefreshShare).toBe(0)
    expect(halved.doubledRefreshShare).toBe(1)
  })

  it('measures against the display it ran on, not against 60', () => {
    // Every second refresh on a 120Hz display is 60 a second - halved
    // relative to what that display could show, which is what matters.
    const halved = summarizePresentationCadence(everyNth(120, 2, 200), 120)
    expect(halved.doubledRefreshShare).toBe(1)
    expect(halved.singleRefreshShare).toBe(0)
  })

  it('counts every gap, so stalls and partial presentations lower both shares', () => {
    const instants = [0, 16.7, 33.4, 35, 51.7, 151.7]
    const cadence = summarizePresentationCadence(instants, 60)
    expect(cadence.gapCount).toBe(5)
    expect(cadence.singleRefreshShare).toBeCloseTo(3 / 5, 6)
    expect(cadence.doubledRefreshShare).toBe(0)
  })

  it('refuses when there is no gap to read', () => {
    expect(() => summarizePresentationCadence([5], 60)).toThrow(
      'at least two presentation instants',
    )
  })
})
