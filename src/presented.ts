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
 * denominator that the numerator can double is not a denominator. With both
 * states included, no window of the two self-built arms exceeds 1 at all.
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
  /** Ends the trace and returns every presented-frame time in `Date.now()` ms, ascending. */
  stop: () => Promise<number[]>
}

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
      const events = await endTraceAndReadEvents(cdp)
      return extractPresentedFrameTimes(events)
    },
  }
}

async function endTraceAndReadEvents(cdp: CDPSession): Promise<TraceEvent[]> {
  const completed = new Promise<string>((resolve) => {
    cdp.on(
      'Tracing.tracingComplete' as never,
      ((event: { stream?: string }) => {
        resolve(event.stream ?? '')
      }) as never,
    )
  })
  await cdp.send('Tracing.end' as never)
  const handle = await completed
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
  return Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? [])
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
 */
export function extractPresentedFrameTimes(
  events: readonly TraceEvent[],
): number[] {
  const clock = resolveClockSync(events)
  const openReporters = new Map<string, TraceEvent[]>()
  const presented: number[] = []

  for (const event of events) {
    if (event.name !== 'PipelineReporter' || event.pid !== clock.pid) continue
    // `id2.local` is unique per compositor, `tid` per thread; neither alone
    // is unique across a whole trace, so pairing keys on both.
    const key = `${event.id2?.local ?? ''}|${String(event.tid ?? '')}`
    if (event.ph === 'b') {
      const open = openReporters.get(key) ?? []
      open.push(event)
      openReporters.set(key, open)
      continue
    }
    if (event.ph !== 'e') continue
    const begin = openReporters.get(key)?.pop()
    if (begin === undefined || event.ts === undefined) continue
    const reporter = begin.args?.['frame_reporter']
    const state =
      typeof reporter === 'object' && reporter !== null
        ? (reporter as { state?: unknown }).state
        : undefined
    if (typeof state !== 'string' || !PRESENTED_STATES.has(state)) continue
    presented.push(event.ts / 1000 + clock.offsetMs)
  }

  return presented.sort((a, b) => a - b)
}

function resolveClockSync(events: readonly TraceEvent[]): {
  offsetMs: number
  pid: number
} {
  const offsets: number[] = []
  let pid: number | undefined
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
    pid ??= event.pid
  }
  if (offsets.length === 0 || pid === undefined) {
    throw new Error(
      `Trace carries no ${CLOCK_SYNC_MARK_PREFIX} clock marks, so presented frames cannot be placed on the capture's clock; call markClockSync before and after the recording`,
    )
  }
  return {
    offsetMs: offsets.reduce((sum, value) => sum + value, 0) / offsets.length,
    pid,
  }
}
