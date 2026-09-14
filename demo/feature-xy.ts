import type { Demo, RecordPage } from '../src/record.js'

/**
 * The script `MILESTONES.md`'s M6 acceptance line names. It is a recording
 * script in the shape `featurecast run` expects: it exports the *body* of
 * the recording and does not call `record()` itself, because the command
 * owns the browser, the device and the capture that wraps it.
 *
 * The page is a self-contained `data:` URL rather than a real application:
 * this file exists to make the command runnable without an account, a
 * network or a fixture server, and every recipe for recording a real app —
 * signed-in sessions, cookie banners, frozen clocks — is in
 * `docs/RECORDING-SCRIPTS.md`.
 */
const FIXTURE_URL =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><body style="margin:0;height:3000px;font:16px system-ui">' +
      '<header style="height:64px;background:#111;color:#fff;display:flex;align-items:center;padding:0 24px">Feature XY</header>' +
      '<button id="open" style="margin:48px 24px;padding:12px 20px">Open the thing</button>' +
      '<input id="search" style="margin:0 24px;padding:12px;width:320px" placeholder="Search" />' +
      '<div id="row" style="margin:900px 24px;padding:16px;background:#eee">A row far down the page</div>' +
      '</body></html>',
  )

export default async function featureXy(
  page: RecordPage,
  demo: Demo,
): Promise<void> {
  await page.goto(FIXTURE_URL)
  await demo.point('#open')
  await demo.click('#open')
  await demo.type('#search', 'Rechnung 2026')
  await demo.hold(800)
  await demo.scroll(0, 900)
  await demo.hold(600)
}
