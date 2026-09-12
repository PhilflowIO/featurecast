import type { Browser, CDPSession, Page } from 'playwright'

/**
 * The two trace categories the presented-frame count actually needs.
 *
 * Chromium enables an event as soon as *one* of its categories is on, and
 * the events this module reads carry
 * `cat = "cc,benchmark,disabled-by-default-devtools.timeline.frame"`
 * (measured over all 11 152 `PipelineReporter` events of a real 70s run:
 * that exact string, no exceptions), so the frame category alone unlocks
 * them. `blink.user_timing` carries the `fcsync:` clock marks below.
 *
 * The exploratory harness this grew out of recorded seven categories and
 * produced a 125-138 MB raw trace per run; the two kept here account for
 * 13-15% of that volume. Recording categories nobody reads is not free —
 * `recordAsMuchAsPossible` still has a buffer, and a fuller buffer means
 * more dropped events, including the ones we do read.
 */
export const PRESENTED_FRAME_TRACE_CATEGORIES = [
  'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing',
] as const

const CLOCK_SYNC_MARK_PREFIX = 'fcsync:'

/**
 * A compositor frame that actually reached the screen. `STATE_PRESENTED_ALL`
 * alone is not the set: `STATE_PRESENTED_PARTIAL` frames are presented too
 * (only some of their content made the deadline), and leaving them out makes
 * the count too small in exactly the windows that matter. Measured on three
 * real runs, counting only `STATE_PRESENTED_ALL` puts captured-over-presented
 * above 1 in 4, 4 and 12 motion windows respectively, peaking at 2.17 — a
 * denominator that the numerator can double is not a denominator.
 *
 * Including `STATE_PRESENTED_PARTIAL` is nevertheless only safe *because*
 * `extractPresentedFrameTimes` counts instants rather than reports: 669 of
 * the 752 partial reports in a real run share their presentation timestamp
 * with an `ALL` report of the same instant, i.e. they are the same screen
 * update described twice. The 83 that do not are real, separate updates, and
 * that is measured rather than assumed: over the reference trace their
 * distance to the nearest `ALL`-bearing instant is 20.8ms at the median and
 * 4.1ms at the minimum — none is sub-millisecond, 77 of 83 sit a full
 * refresh interval or more away, and their gap to the *previous* instant is
 * 16.6ms at the median, exactly one 60Hz refresh.
 *
 * Damage-free frames are a separate state again (`STATE_NO_UPDATE_DESIRED`,
 * ~1400 per run) and are deliberately not counted: nothing changed on screen,
 * so there was nothing for the capture to miss.
 */
const PRESENTED_STATES = new Set([
  'STATE_PRESENTED_ALL',
  'STATE_PRESENTED_PARTIAL',
])

export type TraceEvent = {
  args?: Record<string, unknown>
  cat?: string
  id2?: { local?: string }
  name?: string
  ph?: string
  pid?: number
  tid?: number
  ts?: number
}

export type PresentedFrameTrace = {
  /** Ends the trace and returns every distinct presentation instant in `Date.now()` ms, ascending. */
  stop: () => Promise<number[]>
}

/**
 * Whether Chromium dropped trace data before we read it.
 *
 * This is the denominator's *lower* bound, and it is the direction that
 * cannot be caught by looking at the ratio. The refresh bound in
 * `src/efficiency.ts` rejects a denominator that is too large; a denominator
 * that is too **small** moves capture efficiency towards the gate instead of
 * away from it — on the `r2a` numbers, 84.2% becomes 88.5% at 5% denominator
 * loss, 93.2% at 10% and 105.4% at 20%. A silently truncated trace therefore
 * reads as a better capture, which is precisely the failure this repository
 * keeps repeating.
 *
 * Chromium reports it itself, so this is read rather than inferred.
 * `Tracing.tracingComplete` carries `dataLossOccurred`
 * (`content/browser/devtools/protocol/tracing_handler.cc:698-706`:
 * `bool data_loss = session_->HasDataLossOccurred(); ... `
 * `frontend_->TracingComplete(data_loss, stream_handle, ...)`), which is set
 * from Perfetto's own buffer statistics — `chunks_overwritten`,
 * `chunks_discarded`, `abi_violations` or `trace_writer_packet_loss` above
 * zero (`services/tracing/public/cpp/perfetto/perfetto_session.cc:39-49`).
 * The final statistics are requested after the last chunk has been streamed
 * and before the completion notification is sent
 * (`tracing_handler.cc:518-529`: "Request stats to check if data loss
 * occurred"), so the flag on the notification covers the whole recording.
 */
export type TraceCompleteness = { dataLossOccurred: boolean }

/**
 * Emits a `performance.mark` pairing the page's trace clock with
 * `Date.now()`. Trace timestamps are monotonic microseconds from an
 * arbitrary origin; the capture manifest and the motion windows are
 * `Date.now()` milliseconds. One mark is enough to translate between them,
 * several are better (the mean cancels the sub-millisecond noise of
 * `Date.now()` itself), so this is called on both sides of the recording.
 */
export async function markClockSync(page: Page): Promise<void> {
  await page.evaluate(
    `performance.mark('${CLOCK_SYNC_MARK_PREFIX}' + Date.now())`,
  )
}

/**
 * Counts the frames Chromium itself put on screen, as the denominator for
 * capture efficiency.
 *
 * This exists because the alternative denominator — an in-page
 * `requestAnimationFrame` probe that timestamps a tick whenever the page
 * signalled a visual change (`src/paint-rate.ts`) — is structurally too
 * small during a scroll. That probe runs on the renderer's main thread,
 * while smooth scrolling is driven by the compositor thread and keeps
 * presenting frames whether or not the main thread gets a slice. Measured
 * over one motion window of a real run: 66 frames presented, 51 ticks
 * counted. A ratio whose denominator undercounts reads *better* the worse
 * the machine behaves, and on the patched-Chromium arm it reported 100.9%
 * capture efficiency — an impossible number that an acceptance gate passed.
 *
 * The trace runs for the whole recording but is only read at the end, so
 * nothing competes with the screencast on the CDP channel while frames are
 * flowing. Parsing a full 70s trace costs ~2.4s.
 */
export async function startPresentedFrameTrace(
  browser: Browser,
  page: Page,
): Promise<PresentedFrameTrace> {
  const cdp = await browser.newBrowserCDPSession()
  await cdp.send(
    'Tracing.start' as never,
    {
      traceConfig: {
        includedCategories: [...PRESENTED_FRAME_TRACE_CATEGORIES],
        recordMode: 'recordAsMuchAsPossible',
      },
      transferMode: 'ReturnAsStream',
    } as never,
  )
  await markClockSync(page)

  return {
    async stop(): Promise<number[]> {
      await markClockSync(page)
      const { completeness, events } = await endTraceAndReadEvents(cdp)
      return extractPresentedFrameTimes(events, completeness)
    },
  }
}

async function endTraceAndReadEvents(
  cdp: CDPSession,
): Promise<{ completeness: TraceCompleteness; events: TraceEvent[] }> {
  const completed = new Promise<{
    dataLossOccurred?: boolean
    stream?: string
  }>((resolve) => {
    cdp.on(
      'Tracing.tracingComplete' as never,
      ((event: { dataLossOccurred?: boolean; stream?: string }) => {
        resolve(event)
      }) as never,
    )
  })
  await cdp.send('Tracing.end' as never)
  const completion = await completed
  const handle = completion.stream ?? ''
  if (handle === '') {
    throw new Error('Tracing.tracingComplete arrived without a stream handle')
  }

  const chunks: Buffer[] = []
  for (;;) {
    const read = (await cdp.send(
      'IO.read' as never,
      {
        handle,
        size: 8 * 1024 * 1024,
      } as never,
    )) as { base64Encoded?: boolean; data: string; eof: boolean }
    chunks.push(
      read.base64Encoded === true
        ? Buffer.from(read.data, 'base64')
        : Buffer.from(read.data, 'utf8'),
    )
    if (read.eof) break
  }
  await cdp.send('IO.close' as never, { handle } as never)

  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as
    TraceEvent[] | { traceEvents?: TraceEvent[] }
  return {
    completeness: { dataLossOccurred: completion.dataLossOccurred === true },
    events: Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []),
  }
}

/**
 * Turns a raw trace into presented-frame times in the `Date.now()` domain.
 *
 * Split out from the CDP plumbing above so it can be tested without a
 * browser, and because every non-obvious decision lives here:
 *
 * - **Process.** Two processes emit `PipelineReporter`: the renderer hosting
 *   the recorded page and the browser's own UI compositor. Counting both
 *   inflates the denominator by 47-52 frames per run on some arms and by 0
 *   on others, which silently reshuffles any comparison between them. The
 *   renderer is identified by the process that carries the `fcsync:` marks,
 *   i.e. the one the recorded page runs in — no name matching, no guessing.
 * - **Time.** `PipelineReporter` is an async event: the `b` phase carries
 *   the state, the `e` phase carries the moment the frame was presented.
 *   The frame is bucketed by its `e` timestamp, because that is when the
 *   pixels existed and therefore when the capture could have taken them.
 *   The two are 15-31ms apart at the median.
 * - **Instants, not reports.** Chromium files *several* `PipelineReporter`
 *   records for one screen update — one per reporting pipeline in the
 *   renderer, seven distinct `id2.local` identities over a real run — and
 *   they all carry the same `e` timestamp, because they describe the same
 *   presentation. Summing the records inflates the denominator by about
 *   half: measured on a real product run, 2238 records against 1510 distinct
 *   presentation instants, with 728 instants reported exactly twice and none
 *   reported more than twice. So identical `e` timestamps collapse to one
 *   entry here.
 *
 *   The outer check that settles this without reading any of the above: the
 *   compositor cannot put more frames on screen than it refreshes, so no
 *   stretch of a run can contain more presentation instants than its own
 *   length divided by the refresh interval, plus the one that can sit on the
 *   opening edge. Over twelve full runs and every sliding 0.3-3.0s stretch of
 *   each, the distinct instants exceed that line by at most **2 frames**,
 *   while the raw record count exceeds it by **35 to 51** — a window
 *   reporting 89.8 presented frames per second, as the un-deduplicated count
 *   did, is not a measurement, it is double-counting.
 *   `validateCaptureEfficiencyReport` enforces exactly that bound, so this
 *   collapse cannot silently regress.
 *
 * - **Completeness.** `completeness.dataLossOccurred` is a required argument,
 *   not an option with a default, for the same reason the efficiency
 *   denominator is: a denominator whose trustworthiness can be omitted will
 *   be omitted. A trace that lost events yields a denominator that is too
 *   small, and too small is the direction that makes the capture look
 *   *better* — see `TraceCompleteness`.
 */
export function extractPresentedFrameTimes(
  events: readonly TraceEvent[],
  completeness: TraceCompleteness,
): number[] {
  if (completeness.dataLossOccurred) {
    throw new Error(
      'Chromium reported dataLossOccurred on Tracing.tracingComplete: the trace buffer dropped events, so an unknown number of presentations is missing from the denominator. A short denominator raises capture efficiency instead of lowering it, so this run cannot be scored — re-record with a larger trace buffer or fewer categories.',
    )
  }
  const clock = resolveClockSync(events)
  const openReporters = new Map<string, TraceEvent>()
  const presentedMicros = new Set<number>()

  for (const event of events) {
    if (event.name !== 'PipelineReporter' || event.pid !== clock.pid) continue
    // `id2.local` alone, and one open record per key rather than a stack.
    // Both are measured rather than assumed: over nine full runs (three
    // arms x three repeats, 8856-10482 renderer `PipelineReporter` events
    // each) every renderer record sits on a single thread, no `id2.local`
    // ever appears on two threads, and no `id2.local` is ever open twice at
    // once.
    //
    // So a second `b` for a still-open key is not a case this module knows
    // how to score, and it is not allowed to guess: keeping the newer record
    // silently drops the older one's presentation instant, which shrinks the
    // denominator by one per overlapping pair — linear, and in the direction
    // that flatters the capture (a synthetic 40-instant trace built entirely
    // of overlapping pairs counts as 20). Round two removed the LIFO stack
    // that no real input exercised, which was right; leaving a silent
    // halving in its place was not. Loud is the only safe answer for an
    // input shape nothing has ever produced.
    const key = event.id2?.local ?? ''
    if (event.ph === 'b') {
      const alreadyOpen = openReporters.get(key)
      if (alreadyOpen !== undefined) {
        throw new Error(
          `Trace has two overlapping PipelineReporter records for id2.local=${key} (opened at ${String(alreadyOpen.ts)}us and again at ${String(event.ts)}us) with no end in between. Every presentation instant this module has ever seen closes before its identity is reused; scoring this trace would silently drop one instant per overlapping pair and make the capture look better than it was.`,
        )
      }
      openReporters.set(key, event)
      continue
    }
    if (event.ph !== 'e') continue
    const begin = openReporters.get(key)
    openReporters.delete(key)
    if (begin === undefined || event.ts === undefined) continue
    const reporter = begin.args?.['frame_reporter']
    const state =
      typeof reporter === 'object' && reporter !== null
        ? (reporter as { state?: unknown }).state
        : undefined
    if (typeof state !== 'string' || !PRESENTED_STATES.has(state)) continue
    presentedMicros.add(event.ts)
  }

  return [...presentedMicros]
    .sort((a, b) => a - b)
    .map((micros) => micros / 1000 + clock.offsetMs)
}

/**
 * Finds the recorded page's renderer process and the offset between the
 * trace's monotonic clock and `Date.now()`.
 *
 * The process is not guessed by name: it is the one the `fcsync:` marks were
 * emitted in, i.e. the one the recorded page runs in. Which is exactly why
 * **more than one such process is an error rather than a choice.** The
 * previous version took whichever process the first mark happened to be in
 * (`pid ??= event.pid`), so a recording whose page lived in two renderers —
 * an out-of-process iframe, a same-site navigation that swapped the
 * RenderFrameHost — would have counted the presentations of one of them and
 * silently halved the denominator. Halving the denominator makes capture
 * efficiency read roughly twice as good, so the failure mode was a passing
 * gate. Picking the *last* mark instead of the first was likewise a mutation
 * no test could catch, because nothing distinguished the two: the arbitrary
 * choice itself was the defect, and it is gone rather than tested.
 */
function resolveClockSync(events: readonly TraceEvent[]): {
  offsetMs: number
  pid: number
} {
  const offsets: number[] = []
  const pids = new Set<number>()
  for (const event of events) {
    if (
      event.name === undefined ||
      !event.name.startsWith(CLOCK_SYNC_MARK_PREFIX) ||
      event.ts === undefined
    ) {
      continue
    }
    const wallClockMs = Number(event.name.slice(CLOCK_SYNC_MARK_PREFIX.length))
    if (!Number.isFinite(wallClockMs)) continue
    offsets.push(wallClockMs - event.ts / 1000)
    if (event.pid !== undefined) pids.add(event.pid)
  }
  if (offsets.length === 0 || pids.size === 0) {
    throw new Error(
      `Trace carries no ${CLOCK_SYNC_MARK_PREFIX} clock marks, so presented frames cannot be placed on the capture's clock; call markClockSync before and after the recording`,
    )
  }
  if (pids.size > 1) {
    throw new Error(
      `Trace carries ${CLOCK_SYNC_MARK_PREFIX} clock marks from ${String(pids.size)} processes (${[...pids].join(', ')}), so the recorded page did not stay in one renderer. Counting the presentations of only one of them would shrink the denominator and make capture efficiency read better than it was.`,
    )
  }
  const [pid] = [...pids]
  return {
    offsetMs: offsets.reduce((sum, value) => sum + value, 0) / offsets.length,
    pid: pid ?? 0,
  }
}

/**
 * The display's refresh rate, read out of the presentation instants
 * themselves rather than assumed.
 *
 * The refresh rate is the outer anchor the capture-efficiency denominator is
 * bounded against (`src/efficiency.ts`), and it was a hard-wired 60 — true
 * of the machine it was written on and of nothing else. On a 120Hz display
 * that constant rejects every window longer than 67ms; on 144Hz it rejected
 * all 38 motion windows of a real run; below about 40Hz it stops binding at
 * all. A bound that is only correct on one machine is not an outer anchor,
 * it is a second assumption.
 *
 * The rate is in the data: consecutive presentation instants are one refresh
 * apart whenever the compositor keeps up, so the interval is the median of
 * the gaps that are plausibly a single refresh. The band spans 33Hz to
 * 200Hz, which is every display this could plausibly run against, and the
 * estimator is the median rather than the mode, because the mode of
 * millisecond-rounded gaps reads 17ms on this hardware — 58.8Hz, 2% low,
 * enough to make a 0.93s window look like it overran its ceiling. The median
 * is what makes the wide band safe: real runs carry 25-64 sub-refresh gaps
 * and 10-43 gaps just above one refresh, and taking them in moves the
 * estimate by at most 0.03ms. Measured across twelve full runs on the
 * reference box the median lands between 16.600 and 16.716ms, i.e.
 * 59.82-60.24Hz, against a nominal 60.
 *
 * Refuses rather than guesses when there is too little to read: a handful of
 * instants cannot establish a refresh interval, and a fabricated one would
 * silently widen or close the bound built on it.
 */
export function resolveRefreshHz(
  presentedTimestamps: readonly number[],
): number {
  const singleRefreshGaps: number[] = []
  const sorted = [...presentedTimestamps].sort((a, b) => a - b)
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = (sorted[index] ?? 0) - (sorted[index - 1] ?? 0)
    if (
      gap >= MIN_PLAUSIBLE_REFRESH_GAP_MS &&
      gap <= MAX_PLAUSIBLE_REFRESH_GAP_MS
    ) {
      singleRefreshGaps.push(gap)
    }
  }
  if (singleRefreshGaps.length < MIN_GAPS_FOR_REFRESH_ESTIMATE) {
    throw new Error(
      `Cannot read a refresh interval from ${String(presentedTimestamps.length)} presentation instants: only ${String(singleRefreshGaps.length)} of the gaps between them fall in the ${String(MIN_PLAUSIBLE_REFRESH_GAP_MS)}-${String(MAX_PLAUSIBLE_REFRESH_GAP_MS)}ms band a single refresh can occupy, and ${String(MIN_GAPS_FOR_REFRESH_ESTIMATE)} are needed. Without the display's own rate there is no outer bound on the capture-efficiency denominator.`,
    )
  }
  singleRefreshGaps.sort((a, b) => a - b)
  const middle = Math.floor(singleRefreshGaps.length / 2)
  const intervalMs =
    singleRefreshGaps.length % 2 === 1
      ? (singleRefreshGaps[middle] ?? 0)
      : ((singleRefreshGaps[middle - 1] ?? 0) +
          (singleRefreshGaps[middle] ?? 0)) /
        2
  return 1000 / intervalMs
}

/** 200Hz; below this gap a pair of instants is a sub-refresh partial presentation, not a refresh interval. */
const MIN_PLAUSIBLE_REFRESH_GAP_MS = 5
/** 33Hz; above this gap the compositor skipped at least one refresh, so the gap is a multiple. */
const MAX_PLAUSIBLE_REFRESH_GAP_MS = 30
/**
 * Below this many single-refresh gaps the median is noise, and noise here
 * widens or closes the ceiling built on it.
 *
 * Measured rather than guessed: over twelve full runs, taking every
 * contiguous slice of 30 to 900 instants and comparing the slice's estimate
 * against the whole run's, the worst error is 4.40Hz once 50 in-band gaps
 * are present, 1.70Hz at 100, **0.84Hz at 150** and 0.54Hz at 200. At 150
 * the worst case moves a one-second window's ceiling by less than one frame,
 * which is inside the sub-refresh allowance it is added to. Real recordings
 * supply 782-888 in-band gaps per 70-second run, so this only rejects inputs
 * that genuinely cannot answer the question — a 26-instant trace excerpt,
 * for instance, reads 61.5Hz on hardware that runs at 60.0.
 */
const MIN_GAPS_FOR_REFRESH_ESTIMATE = 150
