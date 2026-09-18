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

  it('refuses a run no device was named for, and names both ways to name one', async () => {
    // The flag stopped being required when a script gained the right to name
    // its own devices, so the refusal moved to the only place that can see
    // both sources. It has to mention both, or it sends the reader to the one
    // they already tried.
    const { code, harness: context } = await run(['run', 'demo/feature-xy.ts'])
    expect(code).toBe(1)
    expect(context.text.err).toContain('--devices')
    expect(context.text.err).toContain('export const devices')
    expect(context.record).not.toHaveBeenCalled()
  })

  it('treats an empty --devices list as no list at all', async () => {
    // `--devices ,,` parses to three empty names. Recording nothing and
    // exiting 0 would look like success; falling back to a script that names
    // none is the same refusal as passing nothing.
    const { code } = await run([
      'run',
      'demo/feature-xy.ts',
      '--devices',
      ',, ',
    ])
    expect(code).toBe(1)
  })

  it('films what the script names when the flag is absent', async () => {
    const { code, harness: context } = await run(
      ['run', 'demo/feature-xy.ts'],
      {
        loadScript: vi.fn(async () => ({
          devices: ['desktop-wide'],
          recording: async () => undefined,
        })),
      } as Partial<PipelineDependencies>,
    )
    expect(code).toBe(0)
    expect(context.record).toHaveBeenCalledTimes(1)
  })

  it('lets the flag override what the script names', async () => {
    // The later, more specific instruction wins: a script says what it is
    // normally filmed on, the flag is somebody overriding that for one run.
    const { code, harness: context } = await run(
      ['run', 'demo/feature-xy.ts', '--devices', 'desktop'],
      {
        loadScript: vi.fn(async () => ({
          devices: ['desktop-wide', 'iphone'],
          recording: async () => undefined,
        })),
      } as Partial<PipelineDependencies>,
    )
    expect(code).toBe(0)
    expect(context.record).toHaveBeenCalledTimes(1)
    expect(context.text.out).toContain('desktop')
  })

  it('refuses two devices that would land in the same directory', async () => {
    // Allowed silently, the second recording writes its frames into the
    // first one's directory and the render reads a mixture of the two.
    const { code, harness: context } = await run(
      ['run', 'demo/feature-xy.ts'],
      {
        loadScript: vi.fn(async () => ({
          devices: [
            'desktop',
            { capture: { height: 2160, width: 3840 }, extends: 'desktop' },
          ],
          recording: async () => undefined,
        })),
      } as Partial<PipelineDependencies>,
    )
    expect(code).toBe(1)
    expect(context.text.err).toContain('both be filed under "desktop"')
    expect(context.text.err).toContain('as')
    expect(context.record).not.toHaveBeenCalled()
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
    // A missing script is a parse-time fault, which is the class of fault the
    // usage text answers. A missing device is not: by then the script may
    // already have named one, so that refusal belongs to the chain and prints
    // without the usage.
    const { harness: context } = await run(['run'])
    expect(context.text.err).toContain('featurecast run <script>')
  })
})

describe('featurecast run --reserve', () => {
  function recordedCapture(context: Harness, call = 0): unknown {
    const device = context.record.mock.calls[call]?.[0] as
      { capture: unknown } | undefined
    return device?.capture
  }

  it('records a touch preset with the 1.5x reserve by default', async () => {
    const { code, harness: context } = await run([
      'run',
      'a.ts',
      '--devices',
      'iphone',
    ])
    expect(code).toBe(0)
    expect(recordedCapture(context)).toMatchObject({
      height: 2880,
      width: 1620,
    })
  })

  it('records exactly the delivery with --reserve 1', async () => {
    const { code, harness: context } = await run([
      'run',
      'a.ts',
      '--devices',
      'iphone,tablet',
      '--reserve',
      '1',
    ])
    expect(code).toBe(0)
    expect(recordedCapture(context, 0)).toMatchObject({
      height: 1920,
      width: 1080,
    })
    expect(recordedCapture(context, 1)).toMatchObject({
      height: 1600,
      width: 1200,
    })
    // The flag changes how a device is recorded, not what it is called.
    expect(context.record.mock.calls[0]?.[1]).toBe('artifacts/a/iphone')
  })

  it('lays the flag over the devices a script names', async () => {
    const { code, harness: context } = await run(
      ['run', 'a.ts', '--reserve', '2'],
      {
        loadScript: vi.fn(async () => ({
          devices: [{ as: 'phone', extends: 'iphone' }],
          recording: async () => undefined,
        })),
      } as Partial<PipelineDependencies>,
    )
    expect(code).toBe(0)
    expect(recordedCapture(context)).toMatchObject({
      height: 3840,
      width: 2160,
    })
  })

  it('fails the device whose script already names a capture size', async () => {
    const { code, harness: context } = await run(
      ['run', 'a.ts', '--reserve', '1.5'],
      {
        loadScript: vi.fn(async () => ({
          devices: [
            {
              as: 'phone',
              capture: { height: 2880, width: 1620 },
              extends: 'iphone',
            },
          ],
          recording: async () => undefined,
        })),
      } as Partial<PipelineDependencies>,
    )
    expect(code).toBe(1)
    expect(context.record).not.toHaveBeenCalled()
    expect(context.text.out).toContain('both set the capture area')
  })

  it('refuses a reserve that is not a number of at least 1', async () => {
    for (const raw of ['0.5', '1,5', 'lots', '']) {
      const { code, harness: context } = await run([
        'run',
        'a.ts',
        '--devices',
        'iphone',
        '--reserve',
        raw,
      ])
      expect(code).toBe(2)
      expect(context.text.err).toContain(
        '--reserve must be a number of at least 1',
      )
    }
  })
})
