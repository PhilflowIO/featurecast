import { fileURLToPath } from 'node:url'

import { record } from '../src/record.js'

/**
 * Records the two touch fixtures `tests/render/zoom.test.ts` frames against.
 *
 * It exists so the answer to "which real run produces this input?" is a file
 * rather than a memory. Round four deleted `run-type-then-click` because its
 * comment claimed a provenance no recorder could deliver; round five shipped
 * two more of the same kind — `run-interior-taps`, whose pointer jumps 193.1px
 * between two consecutive samples against the hard 20px cap in
 * `src/motion.ts:57`, and `run-close-taps`, which puts 1116px between two taps
 * with no pointer path at all while `tap()` unconditionally travels
 * (`src/record.ts:344-348`). Both are replaced by the logs this file writes.
 *
 * The geometry is not arbitrary. `travelDuration` floors a pointer journey at
 * 220ms and `minimumJerkBoundSamples` needs about 0.127 samples per pixel
 * (`src/motion.ts:167-172`, `src/motion.ts:305-307`), so the gap two taps can
 * have is a function of how far apart they are: about 250 viewport pixels is
 * the furthest two elements measured to still crowd each other inside the
 * default 700ms lead — the curved, overshooting path the recorder actually
 * walks is about 1.3x the straight-line distance, so the sample count is
 * counted from a recording rather than from the straight line. `crowded` sits just under that line; `far` sits well
 * over it, which is why it is the one that cannot crowd however fast the
 * script runs.
 *
 * Both `crowded` elements sit inside the middle of the viewport so that their
 * framings are free of the raster edge on both axes — a crop pinned against
 * the raster is centred by the pin rather than by `frameBoundingBox`, and a
 * centring assertion that only ever sees pinned crops tests nothing.
 */
function page(elements: string): string {
  return (
    'data:text/html,' +
    encodeURIComponent(
      '<!doctype html><html><body style="margin:0;height:800px;' +
        'overflow:hidden;font:16px sans-serif">' +
        elements +
        '</body></html>',
    )
  )
}

function button(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
): string {
  return (
    `<button id="${id}" style="position:absolute;left:${left}px;` +
    `top:${top}px;width:${width}px;height:${height}px;">${id}</button>`
  )
}

/**
 * Two taps 238 viewport pixels apart, both framed clear of the raster edge.
 * The travel between them is the shortest the recorder will spend on that
 * distance, which puts the two events inside one `zoomLeadMs` of each other:
 * this is the log the crowded branch is judged on.
 */
const CROWDED_URL = page(
  button('near', 460, 276, 120, 48) + button('over', 660, 362, 160, 56),
)

/**
 * Two taps at opposite ends of the viewport. The finger does not lift in the
 * log — `tap()` travels to its target like every other interaction — and the
 * travel is long enough that no script can bring the two events within a lead
 * of each other.
 */
const FAR_URL = page(
  button('corner', 120, 100, 140, 52) + button('opposite', 1000, 640, 180, 60),
)

export async function recordM4Fixtures(outRoot: string): Promise<void> {
  await record(
    {
      device: 'Nexus 10 landscape',
      out: `${outRoot}/run-crowded-taps`,
      seed: 13,
    },
    async (browserPage, demo) => {
      await browserPage.goto(CROWDED_URL)
      await demo.tap('#near')
      await demo.tap('#over')
    },
  )
  await record(
    { device: 'Nexus 10 landscape', out: `${outRoot}/run-far-taps`, seed: 7 },
    async (browserPage, demo) => {
      await browserPage.goto(FAR_URL)
      await demo.tap('#corner')
      await demo.tap('#opposite')
    },
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await recordM4Fixtures(process.argv[2] ?? 'artifacts/m4-fixtures')
}
