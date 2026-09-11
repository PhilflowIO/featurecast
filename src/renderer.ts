import type { Page } from 'playwright'

/**
 * Headless Chromium defaults to ANGLE-over-SwiftShader (software
 * rasterization) even when a real GPU is present. Measured on this
 * workstation (AMD Radeon 860M, `glxinfo -B` confirms `direct rendering:
 * Yes`): default headless launch reports
 * `UNMASKED_RENDERER_WEBGL = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader
 * Device...), SwiftShader driver)"`, and a dense-page capture at
 * 2560x1600/q100 ran at ~26-31fps. `--use-gl=angle --use-angle=gl-egl`
 * switches ANGLE onto the real GPU (`ANGLE (AMD, AMD Radeon 860M
 * Graphics...)`) and the same capture reaches 60-70fps. This is the
 * dominant lever on capture cadence — see docs/CAPTURE-CADENCE.md.
 */
export const HARDWARE_GL_LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=gl-egl',
] as const

const SOFTWARE_RENDERER_PATTERN = /swiftshader|software|llvmpipe|softpipe/i

export type RendererInfo = {
  launchArgs: readonly string[]
  renderer: string
  softwareRendering: boolean
}

/** Reads the active WebGL renderer string from a live page. */
export async function detectRenderer(
  page: Page,
  launchArgs: readonly string[] = HARDWARE_GL_LAUNCH_ARGS,
): Promise<RendererInfo> {
  const renderer = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!gl) {
      return 'no-webgl-context'
    }
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (!debugInfo) {
      return String(gl.getParameter(gl.RENDERER))
    }
    return String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
  })
  return {
    launchArgs,
    renderer,
    softwareRendering: SOFTWARE_RENDERER_PATTERN.test(renderer),
  }
}

/**
 * Fails loudly on software rendering instead of silently accepting a
 * capture that will run at a fraction of its achievable frame rate while
 * every existing frame-count/duration check still passes. Set
 * `FEATURECAST_ALLOW_SOFTWARE_RENDERER=1` to proceed anyway (e.g. a
 * GPU-less CI runner) — this is an explicit opt-in, not a fallback.
 *
 * The remedy in the thrown message depends on `info.launchArgs` (what was
 * actually passed to `chromium.launch`, recorded by the caller — not
 * necessarily `HARDWARE_GL_LAUNCH_ARGS`): if it's empty, the fix is to add
 * those flags; if hardware-GL flags were already there and rendering is
 * still software, repeating the same flags back is not actionable — the
 * real problem is environment/driver availability (e.g. no GPU, or one not
 * reachable from inside a container), so the message says that instead.
 */
export function assertHardwareRenderer(info: RendererInfo): void {
  if (!info.softwareRendering) {
    return
  }
  if (process.env['FEATURECAST_ALLOW_SOFTWARE_RENDERER'] === '1') {
    return
  }
  const remedy =
    info.launchArgs.length > 0
      ? `Chromium was already launched with hardware-GL flags (${info.launchArgs.join(' ')}) and still fell back to software rendering — check GPU/driver availability in this environment (glxinfo -B, vulkaninfo).`
      : `Launch Chromium with hardware GL (${HARDWARE_GL_LAUNCH_ARGS.join(' ')}).`
  throw new Error(
    `Capture is running on a software GL renderer ("${info.renderer}") ` +
      'instead of hardware acceleration. This silently produces a much ' +
      'lower frame rate (measured ~17fps on a real dense UI vs ~60fps with ' +
      `hardware GL) that ffprobe and duration checks still accept. ${remedy} ` +
      'Or set FEATURECAST_ALLOW_SOFTWARE_RENDERER=1 to proceed anyway.',
  )
}
