import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/cli.js'
import type { PipelineDependencies } from '../src/pipeline.js'

/** What src/capture.ts actually records; the browser leg is stubbed out. */
const RECORDED_CAPTURE = {
  fps: 60,
  height: 1600,
  quality: 90,
  status: 'decided',
  strategy: 'screencast',
  width: 2560,
} as const

type Harness = {
  render: ReturnType<typeof vi.fn>
  pipeline: Partial<PipelineDependencies>
  record: ReturnType<typeof vi.fn>
  text: { err: string; out: string }
  upload: ReturnType<typeof vi.fn>
}

function harness(overrides: Partial<PipelineDependencies> = {}): Harness {
  const render = vi.fn(
    async (
      _captureDirectory: string,
      outDirectory: string,
      request: { formats: readonly { label: string }[] },
    ) => ({
      decisionsPath: `${outDirectory}/decisions.json`,
      outputs: request.formats.map((format) => ({
        label: format.label,
        outputPath: `${outDirectory}/${format.label.replace(':', '-')}.mp4`,
      })),
    }),
  )
  const record = vi.fn(async (_device: unknown, outputDirectory: string) => ({
    capture: RECORDED_CAPTURE,
    captureDirectory: outputDirectory,
  }))
  const upload = vi.fn(
    async (_path: string, key: string) => `https://store.example/${key}`,
  )
  return {
    render,
    pipeline: {
      checkUploadConfigured: vi.fn(),
      loadScript: vi.fn(async () => async () => undefined),
      record,
      render,
      upload,
      ...overrides,
    } as Partial<PipelineDependencies>,
    record,
    text: { err: '', out: '' },
    upload,
  }
}

async function run(
  argv: string[],
  overrides: Partial<PipelineDependencies> = {},
): Promise<{ code: number; harness: Harness }> {
  const context = harness(overrides)
  const code = await runCli(argv, {
    pipeline: context.pipeline,
    write: (text) => {
      context.text.out += text
    },
    writeError: (text) => {
      context.text.err += text
    },
  })
  return { code, harness: context }
}

describe('featurecast run', () => {
  it('runs the chain for every named device and prints a URL each', async () => {
    const { code, harness: context } = await run([
      'run',
      'demo/feature-xy.ts',
      '--devices',
      'desktop-wide,Desktop Chrome',
      '--upload',
    ])

    expect(code).toBe(0)
    expect(context.record).toHaveBeenCalledTimes(2)
    expect(context.text.out).toContain(
      'https://store.example/feature-xy/desktop-wide-1920x1200.mp4',
    )
    expect(context.text.out).toContain(
      'https://store.example/feature-xy/desktop-chrome-16-9.mp4',
    )
  })

  it('names the run after the script when no --out is given', async () => {
    const { harness: context } = await run([
      'run',
      'demo/feature-xy.ts',
      '--devices',
      'desktop-wide',
    ])
    expect(context.record.mock.calls[0]?.[1]).toContain(
      ['artifacts', 'feature-xy', 'desktop-wide'].join('/'),
    )
  })

  it('exits non-zero when a device was refused', async () => {
    // The report keeps the other devices' results, so the exit code is the
    // only thing a script can check. It has to turn.
    const { code, harness: context } = await run(
      ['run', 'demo/feature-xy.ts', '--devices', 'desktop-wide'],
      {
        record: vi.fn().mockRejectedValue(new Error('capture area undecided')),
      },
    )
    expect(code).toBe(1)
    expect(context.text.out).toContain('capture area undecided')
  })

  it('does not upload unless asked', async () => {
    const { code, harness: context } = await run([
      'run',
      'demo/feature-xy.ts',
      '--devices',
      'desktop-wide',
    ])
    expect(code).toBe(0)
    expect(context.upload).not.toHaveBeenCalled()
  })

  it('prints the upload module’s own message, not a stack trace', async () => {
    // A stack trace above the one line that says which variable is missing
    // buries it.
    const { code, harness: context } = await run(
      ['run', 'demo/feature-xy.ts', '--devices', 'desktop-wide', '--upload'],
      {
        checkUploadConfigured: () => {
          throw new Error(
            'Upload is not configured: FEATURECAST_S3_BUCKET is missing or empty. Fix it in the environment; featurecast never reads credentials from the repository.',
          )
        },
      },
    )
    expect(code).toBe(1)
    expect(context.text.err).toBe(
      'Upload is not configured: FEATURECAST_S3_BUCKET is missing or empty. Fix it in the environment; featurecast never reads credentials from the repository.\n',
    )
    expect(context.text.err).not.toContain('    at ')
  })

  it('passes a chosen encoder down to the render', async () => {
    const { code, harness: context } = await run([
      'run',
      'demo/feature-xy.ts',
      '--devices',
      'desktop-wide',
      '--encoder',
      'nvenc-h264',
    ])
    expect(code).toBe(0)
    expect(context.render.mock.calls[0]?.[2]).toMatchObject({
      quality: { cq: 23, encoder: 'nvenc-h264' },
    })
  })

  it('delivers all three formats only when asked for them', async () => {
    const { code, harness: context } = await run([
      'run',
      'demo/feature-xy.ts',
      '--devices',
      'desktop-wide',
      '--all-formats',
    ])
    expect(code).toBe(0)
    expect(context.record).toHaveBeenCalledTimes(1)
    const request = context.render.mock.calls[0]?.[2] as {
      formats: readonly { label: string }[]
    }
    expect(request.formats.map((format) => format.label)).toEqual([
      '16:9',
      '9:16',
      '1:1',
    ])
  })
})

describe('featurecast argument handling', () => {
  it('refuses an unknown encoder by naming the ones that exist', async () => {
    const { code, harness: context } = await run([
      'run',
      'demo/feature-xy.ts',
      '--devices',
      'desktop-wide',
      '--encoder',
      'libx264',
    ])
    expect(code).toBe(2)
    expect(context.text.err).toContain('Unknown encoder "libx264"')
    expect(context.text.err).toContain('nvenc-h264, nvenc-hevc, x264')
    expect(context.record).not.toHaveBeenCalled()
  })

  it('refuses a run without --devices, and lists the presets', async () => {
    const { code, harness: context } = await run(['run', 'demo/feature-xy.ts'])
    expect(code).toBe(2)
    expect(context.text.err).toContain('--devices is required')
    expect(context.text.err).toContain('desktop-wide')
  })

  it('treats an empty --devices list as no list at all', async () => {
    // `--devices ,,` parses to three empty names; recording nothing and
    // exiting 0 would look like success.
    const { code } = await run([
      'run',
      'demo/feature-xy.ts',
      '--devices',
      ',, ',
    ])
    expect(code).toBe(2)
  })

  it('trims whitespace around device names', async () => {
    const { code, harness: context } = await run([
      'run',
      'demo/feature-xy.ts',
      '--devices',
      ' desktop-wide , Desktop Chrome ',
    ])
    expect(code).toBe(0)
    expect(context.record).toHaveBeenCalledTimes(2)
  })

  it('refuses a second script rather than silently ignoring it', async () => {
    const { code, harness: context } = await run([
      'run',
      'a.ts',
      'b.ts',
      '--devices',
      'desktop-wide',
    ])
    expect(code).toBe(2)
    expect(context.text.err).toContain('takes one script')
  })

  it('refuses an unknown command', async () => {
    const { code, harness: context } = await run(['render', 'a.ts'])
    expect(code).toBe(2)
    expect(context.text.err).toContain('Unknown command "render"')
  })

  it('refuses an unknown flag instead of ignoring it', async () => {
    // A typo'd --uplaod that silently did not upload would be found only by
    // the missing URL.
    const { code, harness: context } = await run([
      'run',
      'a.ts',
      '--devices',
      'desktop-wide',
      '--uplaod',
    ])
    expect(code).toBe(2)
    expect(context.record).not.toHaveBeenCalled()
  })

  it('refuses a seed that is not a non-negative integer', async () => {
    const { code, harness: context } = await run([
      'run',
      'a.ts',
      '--devices',
      'desktop-wide',
      '--seed',
      '1.5',
    ])
    expect(code).toBe(2)
    expect(context.text.err).toContain('--seed must be a non-negative integer')
  })

  it('prints the usage for --help and for no arguments at all', async () => {
    const help = await run(['--help'])
    expect(help.code).toBe(0)
    expect(help.harness.text.out).toContain('featurecast run <script>')
    expect(help.harness.text.out).toContain('--devices')

    const bare = await run([])
    expect(bare.code).toBe(0)
    expect(bare.harness.text.out).toContain('featurecast run <script>')
  })

  it('shows the usage alongside the complaint when arguments are wrong', async () => {
    const { harness: context } = await run(['run', 'a.ts'])
    expect(context.text.err).toContain('featurecast run <script>')
  })
})
