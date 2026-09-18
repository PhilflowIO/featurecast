import { parseArgs } from 'node:util'

import { resolveDevice } from '../src/devices.js'
import { formatsFor, importScript, prepareCapture } from '../src/pipeline.js'
import { recordSession, requireAppUrl } from '../src/session.js'
import { renderRecording } from '../src/render/render.js'

/**
 * Records a phone journey at a **deliberately too small** capture area.
 *
 * This exists to produce one half of a comparison, and it is the half that
 * cannot be produced any other way. `featurecast run --devices iphone` takes
 * its capture area from the preset — 1620x2880, 1.5 times the output — and
 * the command line can lower that to the output size (`--reserve 1`) but not
 * below it, on purpose: nobody wants to ship a soft video by typo. The device layer does take the override
 * (`resolveDevice({ extends: 'iphone', capture: { … } })`, documented there),
 * so the small capture is expressible in code and nowhere else.
 *
 * What it demonstrates: a recording made at 540x960 has half the linear
 * resolution of the delivery, and the only way to reach 1080x1920 from it is
 * to invent the missing pixels. The render stage refuses to do that — it
 * clamps and says so — so the enlargement happens later, in `pnpm compare`,
 * where it is labelled as what it is.
 *
 * ```
 * tsx demo/small-capture-phone.ts demo/fixture-tour.ts \
 *   --device iphone --capture 540x960 --out artifacts/small-capture
 * ```
 */

const { positionals, values } = parseArgs({
  allowPositionals: true,
  args: process.argv.slice(2),
  options: {
    capture: { type: 'string' },
    device: { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
})

const scriptPath = positionals[0]
if (scriptPath === undefined) {
  throw new Error('Name the recording script, e.g. demo/fixture-tour.ts')
}
const outRoot = values.out ?? 'artifacts/small-capture'
const [width, height] = (values.capture ?? '540x960').split('x').map(Number)
if (!Number.isInteger(width) || !Number.isInteger(height)) {
  throw new Error(`--capture wants WIDTHxHEIGHT, got "${values.capture ?? ''}"`)
}

const device = resolveDevice({
  capture: { height: height as number, width: width as number },
  extends: values.device ?? 'iphone',
})
const capture = prepareCapture(device)
const script = await importScript(scriptPath)
requireAppUrl(device, script.url)

const session = await recordSession({
  capture,
  device,
  outputDirectory: `${outRoot}/capture`,
  recording: script.recording,
  seed: 1,
  ...(script.prepare === undefined ? {} : { prepare: script.prepare }),
  ...(script.url === undefined ? {} : { appUrl: script.url }),
})

// The output is asked for at the capture's own size, not at the phone's.
// Asking for 1080x1920 here would only earn the render stage's clamp message;
// the enlargement belongs in the comparison, where it carries a label.
const result = await renderRecording(
  session.captureDirectory,
  `${outRoot}/video`,
  {
    formats: formatsFor(
      { ...device.output, height: height as number, width: width as number },
      false,
    ),
    encoder: device.output.quality,
  },
)

for (const output of result.outputs) {
  process.stdout.write(
    `${output.label}  ${String(output.width)}x${String(output.height)}  ${output.outputPath}\n`,
  )
  for (const clamp of output.clamps) process.stdout.write(`  ! ${clamp}\n`)
}
process.exit(0)
