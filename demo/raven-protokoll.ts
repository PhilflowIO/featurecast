import type { Demo, RecordPage } from '../src/record.js'
import {
  FILM_SCROLL_TEMPO,
  RAVEN_ALLOW_FRAMING,
  RAVEN_LOCALE,
  RAVEN_HIDE_SELECTORS,
  RAVEN_STATE,
  RAVEN_URL,
  STEINKAUZ_FIXED_TIME,
  STEINKAUZ_ID,
  inDieMitte,
  jetztSichtbar,
  ruhigKlicken,
  vorbereitenBei,
  warteAuf,
} from './raven-common.js'

/**
 * Product film, scene S2 "Protokoll entsteht": "Neu zusammenfassen" on the
 * Steinkauz status round, the summary streaming in word by word, a rest at
 * its top, and a scroll down to "Offene Punkte".
 *
 * The regenerate button streams over SSE into a typewriter display
 * (`handleSummarize` in `ui/src/app/meetings/[id]/page.tsx`, #2876/#2889).
 * The new summary replaces the old one; it is the product's own output.
 *
 * PRECONDITION, ONE PER TAKE. Since #4707 the server does not regenerate an
 * unchanged input: if transcript, model and prompt match the fingerprint stored
 * with the last summary, the click answers "Zusammenfassung ist bereits
 * aktuell" and nothing streams. This meeting carries such a fingerprint from
 * the moment its first summary was written, and every take writes a new one.
 * So before EACH take the fingerprint row has to go (staging). `settings` is
 * under row-level security: without the tenant set, the DELETE matches
 * nothing and says so only by "0 rows"::
 *
 *     BEGIN;
 *     SELECT set_config('app.current_tenant',
 *                       '4caf12d9-c51f-41a0-9a96-40a18b50cd7b', true);
 *     DELETE FROM settings
 *      WHERE key = 'summary_src:623f6852-b219-5550-899f-1caadb4b2ca5';
 *     COMMIT;
 *
 * Without it the server regenerates, which is what it does for any summary
 * whose source it does not know (`summary_is_current` answers False). That
 * also means one device per `record.sh` call: the first device's take writes
 * the fingerprint the second would stumble on. The script refuses to film the
 * "bereits aktuell" answer rather than record a button that does nothing.
 *
 * THE DELIVERED TAKES START FROM AN EMPTY SUMMARY, on both devices. On a phone
 * the button sits under ~6,000 px of old summary. Raven keeps the old text,
 * dimmed, until the first token; then the card shrinks to the new draft and
 * the reader is left in the transcript, thousands of pixels below the text
 * being written (measured on the GPU host, 2026-09-18, two takes). The summary
 * streams in about four seconds, so no scroll at the shot list's 400 px/s
 * reaches it in time; the phone take showed no typewriter at all. With no
 * summary the card is short, and "Das Modell liest das Transkript …" and the
 * typewriter stand in view. Before each such take (staging; `meetings` needs
 * tenant AND owner under row-level security)::
 *
 *     BEGIN;
 *     SELECT set_config('app.current_tenant',
 *                       '4caf12d9-c51f-41a0-9a96-40a18b50cd7b', true);
 *     SELECT set_config('app.user_id',
 *                       'be6bc3c5-2348-46ea-9875-13bb66e10ce0', true);
 *     UPDATE meetings SET summary = NULL
 *      WHERE id = '623f6852-b219-5550-899f-1caadb4b2ca5';
 *     COMMIT;
 *
 * The take writes the new summary itself. No fingerprint DELETE is needed
 * then: without a summary the server always regenerates. The replace variant
 * above works on a desktop and is kept as an alternative take.
 *
 * INVOCATION (GPU host), once per device, the DELETE above before each::
 *
 *     FEATURECAST_BOX_SYNC_AUTH=1 \
 *         tools/gpu-box/record.sh demo/raven-protokoll.ts --devices desktop-wide
 */

/** The regenerate button. It has no `data-testid`; its label is stable. */
const NEU_ZUSAMMENFASSEN = 'button:has-text("Neu zusammenfassen") >> nth=0'

/** The same button while the job runs. */
const WIRD_ERSTELLT = 'button:has-text("Wird erstellt") >> nth=0'

/**
 * The typewriter's caret, drawn after the text only while tokens arrive
 * (`summaryDraft` branch in the page). The proof that something streams: the
 * button reads "Wird erstellt" for a declined regenerate too, for the length
 * of one request.
 */
const CARET = 'span.animate-pulse.align-text-bottom >> nth=0'

/**
 * The note under the OLD summary, which stays on screen dimmed until the first
 * token arrives (#2889: never blank out what the user has). Only when it is
 * gone has the draft replaced the old text and the card shrunk to it.
 */
const ALTE_FASSUNG = 'text=Neue Zusammenfassung wird erstellt >> nth=0'

/** The toast of a declined regenerate (#4707). */
const BEREITS_AKTUELL = 'text=Zusammenfassung ist bereits aktuell >> nth=0'

/** The heading of the summary card: "the top" of the protocol. */
const KOPF = 'h2:has-text("Zusammenfassung") >> nth=0'

/**
 * The open points heading, however the model marks it up (a `####` heading
 * wrapping bold text on the takes read so far): the innermost node whose
 * whole text is the phrase.
 */
const OFFENE_PUNKTE = 'text=/^\\s*Offene Punkte\\s*:?\\s*$/ >> nth=0'

/** A summary is one model call over the whole transcript; generous on purpose. */
const STREAM_FRIST_MS = 180_000

/** The shot list's rests at the top and at "Offene Punkte". */
const RUHE_MS = 4000

/**
 * Waits for the stream to start, and refuses the declined regenerate.
 */
async function warteAufStreamStart(page: RecordPage): Promise<void> {
  const ende = Date.now() + 90_000
  for (;;) {
    if (await jetztSichtbar(page, BEREITS_AKTUELL)) {
      throw new Error(
        'Raven answered "Zusammenfassung ist bereits aktuell": the summary ' +
          'fingerprint of this meeting is still stored, so nothing streams. ' +
          'Delete the settings row summary_src:' +
          STEINKAUZ_ID +
          ' on staging and record again (see the header of this script).',
      )
    }
    // Streaming, and the old text gone. Moving before that is what the first
    // phone take did: it scrolled up through 6,000 px of the dimmed old
    // summary, and the card then collapsed under the moving picture.
    if (
      (await jetztSichtbar(page, CARET)) &&
      !(await jetztSichtbar(page, ALTE_FASSUNG))
    ) {
      return
    }
    if (Date.now() > ende) {
      throw new Error('The regenerate did not start streaming within 90 s')
    }
    await new Promise((fertig) => setTimeout(fertig, 200))
  }
}

/** Waits until the job is done and the button is back. */
async function warteAufStreamEnde(page: RecordPage): Promise<void> {
  const ende = Date.now() + STREAM_FRIST_MS
  for (;;) {
    const laeuft =
      (await jetztSichtbar(page, WIRD_ERSTELLT)) ||
      (await jetztSichtbar(page, CARET))
    if (!laeuft) return
    if (Date.now() > ende) {
      throw new Error(
        `The summary did not finish within ${String(STREAM_FRIST_MS)} ms`,
      )
    }
    await new Promise((fertig) => setTimeout(fertig, 250))
  }
}

export const url = RAVEN_URL
export const devices = ['desktop-wide', 'iphone']
export const storageStatePath = RAVEN_STATE
export const hideSelectors = RAVEN_HIDE_SELECTORS
export const fixedTime = STEINKAUZ_FIXED_TIME
export const allowFramingOfApp = RAVEN_ALLOW_FRAMING
export const locale = RAVEN_LOCALE

/**
 * Opens the meeting with the summary card's head near the top. The takes start
 * from an empty summary, so the card is short and its button stands in the
 * same frame; the new text then grows downward in view, and nothing scrolls
 * while it streams (about four seconds). The first phone takes opened on the
 * button instead and scrolled up to the head after the first token, and the
 * video team could not read the writing (featurecast#168). The replace
 * variant, with a full old summary above the button, does not fit this frame.
 */
export const prepare = vorbereitenBei(`/meetings/${STEINKAUZ_ID}`, KOPF, 0.15)

export default async function protokoll(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await demo.hold(1000)
  await ruhigKlicken(demo, NEU_ZUSAMMENFASSEN)
  await warteAufStreamStart(page)

  // The new text grows below the card's head, which is already in frame: no
  // scroll now, only the pointer off the words.
  await demo.point(KOPF)

  await warteAufStreamEnde(page)
  await demo.hold(RUHE_MS)

  await warteAuf(page, OFFENE_PUNKTE)
  await inDieMitte(page, demo, OFFENE_PUNKTE, {
    anteil: 0.3,
    tempo: FILM_SCROLL_TEMPO,
  })
  await demo.point(OFFENE_PUNKTE)
  await demo.hold(RUHE_MS)
}
