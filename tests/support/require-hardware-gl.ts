import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll } from 'vitest'

import { launchChromium, resolveBrowserRequest } from '../../src/browser.js'
import {
  HARDWARE_GL_LAUNCH_ARGS,
  detectRenderer,
  type RendererInfo,
} from '../../src/renderer.js'

/**
 * The gate in front of the recording tier.
 *
 * Every `*.gpu.test.ts` films, and filming on a software GL renderer runs at
 * ~17fps instead of ~60 while every frame-count and duration check still
 * passes (src/renderer.ts). A tier that quietly runs anyway is worse than no
 * tier: it reports green about a guarantee it never had. So this gate runs
 * once, before the first case, and refuses in both directions —
 *
 *   - the opt-out switch is set, so the per-recording guard would wave
 *     software rendering through, or
 *   - a real Chromium on this host rasterizes in software.
 *
 * It also writes down which renderer it saw, so the receipt this tier
 * produces (docs/evidence/gpu-tier/) names the hardware it was earned on
 * instead of asserting it.
 */

export const RENDERER_PROBE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'artifacts',
  'gpu-tier',
  'renderer.json',
)

export type RendererProbe = {
  renderer: RendererInfo
  browser: { version: string; source: string }
}

export async function probeRenderer(): Promise<RendererProbe> {
  const { browser, provenance } = await launchChromium(
    { args: [...HARDWARE_GL_LAUNCH_ARGS], headless: true },
    resolveBrowserRequest(process.env),
  )
  try {
    const page = await browser.newPage()
    return {
      renderer: await detectRenderer(page, HARDWARE_GL_LAUNCH_ARGS),
      browser: {
        version: provenance.version,
        source: provenance.request.source,
      },
    }
  } finally {
    await browser.close()
  }
}

beforeAll(async () => {
  if (process.env['FEATURECAST_ALLOW_SOFTWARE_RENDERER'] === '1') {
    throw new Error(
      'FEATURECAST_ALLOW_SOFTWARE_RENDERER=1 is set for the recording tier. ' +
        'That switch turns off the very guarantee these tests exist to prove, ' +
        'so the tier refuses to run under it. Run them on a host with a GPU ' +
        '(tools/gpu-box/test.sh), or run only the portable tier: pnpm test.',
    )
  }
  const probe = await probeRenderer()
  const info = probe.renderer
  if (info.softwareRendering) {
    throw new Error(
      `The recording tier needs hardware GL and this host rasterizes in software ("${info.renderer}"). ` +
        'Chromium was launched with ' +
        `${HARDWARE_GL_LAUNCH_ARGS.join(' ')} and still fell back — check GPU/driver availability ` +
        '(glxinfo -B, vulkaninfo), or run the tier on the GPU host: tools/gpu-box/test.sh.',
    )
  }
  await mkdir(dirname(RENDERER_PROBE_FILE), { recursive: true })
  await writeFile(
    RENDERER_PROBE_FILE,
    `${JSON.stringify({ renderer: info.renderer, launchArgs: info.launchArgs, browser: probe.browser }, undefined, 2)}\n`,
  )
}, 120_000)
