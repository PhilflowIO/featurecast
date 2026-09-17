import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveDevice } from '../src/devices.js'
import {
  deviceSlug,
  formatsFor,
  importScript,
  prepareCapture,
  runPipeline,
  scriptStem,
  type PipelineDependencies,
} from '../src/pipeline.js'
import { requireAppUrl } from '../src/session.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'featurecast-pipeline-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

/** What src/capture.ts actually records, standing in for a browser leg. */
const RECORDED_CAPTURE = {
  fps: 60,
  height: 1600,
  quality: 90,
  status: 'decided',
  strategy: 'screencast',
  width: 2560,
} as const

/**
 * The real gates the default `record` runs before it starts a browser. Used
 * by the tests that are about a device being refused rather than about the
 * order of the stages.
 */
const gatedRecord: PipelineDependencies['record'] = async (
  device,
  outputDirectory,
  script,
) => {
  const capture = prepareCapture(device)
  requireAppUrl(device, script.url)
  return { capture, captureDirectory: outputDirectory }
}

/**
 * Stand-ins for the browser, ffmpeg and the object store. The pipeline's job
 * is the order of the stages, the error policy and what each device is told;
 * none of that needs any of the three to be real, and this suite must not
 * start a browser or open a socket.
 */
function stubs(
  overrides: Partial<PipelineDependencies> = {},
): PipelineDependencies & { lines: string[] } {
  const lines: string[] = []
  return {
    render: vi.fn<PipelineDependencies['render']>(
      async (_capture, outDirectory, request) => ({
        decisionsPath: join(outDirectory, 'decisions.json'),
        outputs: request.formats.map((format) => ({
          label: format.label,
          outputPath: join(
            outDirectory,
            `${format.label.replace(':', '-')}.mp4`,
          ),
        })),
      }),
    ),
    checkUploadConfigured: vi.fn(),
    lines,
    loadScript: vi.fn(async () => ({ recording: async () => undefined })),
    record: vi.fn(async (_device, outputDirectory) => ({
      capture: RECORDED_CAPTURE,
      captureDirectory: outputDirectory,
    })),
    report: (line: string) => {
      lines.push(line)
    },
    upload: vi.fn(async (_path, key) => `https://store.example/${key}`),
    ...overrides,
  }
}

describe('runPipeline', () => {
  it('records, renders and uploads each device and hands back a URL each', async () => {
    const dependencies = stubs()
    const report = await runPipeline(
      {
        devices: ['desktop-wide', 'Desktop Chrome'],
        out: 'artifacts/feature-xy',
        script: 'demo/feature-xy.ts',
        upload: true,
      },
      dependencies,
    )

    expect(report.ok).toBe(true)
    expect(report.outcomes.map((outcome) => outcome.kind)).toEqual([
      'rendered',
      'rendered',
    ])
    expect(
      report.outcomes.flatMap((outcome) =>
        outcome.kind === 'rendered'
          ? outcome.deliveries.map((delivery) => delivery.url)
          : [],
      ),
    ).toEqual([
      // 16:10 for desktop-wide: the key carries the format, or a device that
      // ships more than one video would land them all on one object.
      'https://store.example/feature-xy/desktop-wide-1920x1200.mp4',
      'https://store.example/feature-xy/desktop-chrome-16-9.mp4',
    ])
    // Each device reads its own capture directory and writes to its own
    // sister directory, so neither the frames nor the videos can collide —
    // and the render's own artifacts never land between the frames.
    expect(dependencies.render).toHaveBeenNthCalledWith(
      1,
      join('artifacts/feature-xy', 'desktop-wide'),
      join('artifacts/feature-xy', 'desktop-wide-video'),
      expect.anything(),
    )
    expect(dependencies.render).toHaveBeenNthCalledWith(
      2,
      join('artifacts/feature-xy', 'desktop-chrome'),
      join('artifacts/feature-xy', 'desktop-chrome-video'),
      expect.anything(),
    )
  })

  it('delivers exactly the one size the device promises', async () => {
    // The gap this command closes: before it, nothing carried a resolved
    // device's output layer to the encoder, and every render was 1920x1080.
    // `desktop-wide` promises 16:10, which is also the case that proves the
    // format is a size and not one of three names.
    const dependencies = stubs()
    await runPipeline(
      {
        devices: ['desktop-wide'],
        out: 'out',
        script: 'demo/feature-xy.ts',
        upload: false,
      },
      dependencies,
    )
    expect(vi.mocked(dependencies.render).mock.calls[0]?.[2]).toEqual({
      formats: [{ desired: { height: 1200, width: 1920 }, label: '1920x1200' }],
      quality: { crf: 23, encoder: 'x264' },
    })
  })

  it('delivers all three formats when asked, from the one recording', async () => {
    const dependencies = stubs()
    await runPipeline(
      {
        allFormats: true,
        devices: ['desktop-wide'],
        out: 'out',
        script: 'demo/feature-xy.ts',
        upload: false,
      },
      dependencies,
    )
    expect(dependencies.record).toHaveBeenCalledTimes(1)
    const request = vi.mocked(dependencies.render).mock.calls[0]?.[2]
    expect(request?.formats.map((format) => format.label)).toEqual([
      '16:9',
      '9:16',
      '1:1',
    ])
  })

  it('does not stop the other devices when one is refused', async () => {
    // A recording is minutes of work; throwing a finished one away to report
    // a sibling's problem sooner helps nobody. The verdict still turns.
    const dependencies = stubs({ record: vi.fn(gatedRecord) })
    const report = await runPipeline(
      {
        devices: ['iphone', 'desktop-wide'],
        out: 'out',
        script: 'demo/feature-xy.ts',
        upload: false,
      },
      dependencies,
    )

    expect(report.ok).toBe(false)
    expect(report.outcomes[0]?.kind).toBe('failed')
    expect(report.outcomes[1]?.kind).toBe('rendered')
    expect(dependencies.render).toHaveBeenCalledTimes(1)
  })

  it('refuses a framed device whose script never named the application', async () => {
    // A mobile recording films the application inside a shell served from
    // its own origin (src/framed.ts), so the address has to be known before
    // the browser starts. Discovering it afterwards costs the launch.
    const dependencies = stubs({ record: vi.fn(gatedRecord) })
    const report = await runPipeline(
      {
        devices: ['iphone'],
        out: 'out',
        script: 'demo/feature-xy.ts',
        upload: false,
      },
      dependencies,
    )
    const [outcome] = report.outcomes
    expect(outcome?.kind).toBe('failed')
    if (outcome?.kind !== 'failed') throw new Error('unreachable')
    expect(outcome.stage).toBe('record')
    expect(outcome.reason).toContain('iphone')
    expect(outcome.reason).toContain('export const url')
  })

  it('lets resolveDevice refuse an unknown name, and adds no list of its own', async () => {
    const dependencies = stubs()
    const report = await runPipeline(
      {
        devices: ['iphone 99'],
        out: 'out',
        script: 'demo/feature-xy.ts',
        upload: false,
      },
      dependencies,
    )
    const [outcome] = report.outcomes
    if (outcome?.kind !== 'failed') throw new Error('unreachable')
    expect(outcome.stage).toBe('device')
    // The exact message resolveDevice produces, not a paraphrase: a second
    // name list in the command would drift from the registry.
    let expected = ''
    try {
      resolveDevice('iphone 99')
    } catch (error) {
      expected = (error as Error).message
    }
    expect(outcome.reason).toBe(expected)
    expect(dependencies.record).not.toHaveBeenCalled()
  })

  it('refuses an unconfigured upload before it starts a browser', async () => {
    // Discovering this after a recording and an encode throws away the most
    // expensive work in the pipeline for a fault knowable at second zero.
    const dependencies = stubs({
      checkUploadConfigured: () => {
        throw new Error(
          'Upload is not configured: FEATURECAST_S3_BUCKET is missing or empty',
        )
      },
    })
    await expect(
      runPipeline(
        {
          devices: ['desktop-wide'],
          out: 'out',
          script: 'demo/feature-xy.ts',
          upload: true,
        },
        dependencies,
      ),
    ).rejects.toThrow(/Upload is not configured/)
    expect(dependencies.record).not.toHaveBeenCalled()
    expect(dependencies.loadScript).not.toHaveBeenCalled()
  })

  it('never checks the upload configuration when nothing is uploaded', async () => {
    const dependencies = stubs()
    await runPipeline(
      {
        devices: ['desktop-wide'],
        out: 'out',
        script: 'demo/feature-xy.ts',
        upload: false,
      },
      dependencies,
    )
    expect(dependencies.checkUploadConfigured).not.toHaveBeenCalled()
    expect(dependencies.upload).not.toHaveBeenCalled()
  })

  it('reports a failed upload as a failed device, and keeps going', async () => {
    const dependencies = stubs({
      upload: vi
        .fn()
        .mockRejectedValueOnce(new Error('never reached the store'))
        .mockResolvedValueOnce('https://store.example/second.mp4'),
    })
    const report = await runPipeline(
      {
        devices: ['desktop-wide', 'Desktop Chrome'],
        out: 'out',
        script: 'demo/feature-xy.ts',
        upload: true,
      },
      dependencies,
    )
    expect(report.ok).toBe(false)
    const [first, second] = report.outcomes
    if (first?.kind !== 'failed') throw new Error('unreachable')
    expect(first.stage).toBe('upload')
    expect(second?.kind).toBe('rendered')
  })

  it('names the stage that refused in the printed report', async () => {
    const dependencies = stubs({ record: vi.fn(gatedRecord) })
    await runPipeline(
      {
        devices: ['iphone', 'desktop-wide'],
        out: 'out',
        script: 'demo/feature-xy.ts',
        upload: false,
      },
      dependencies,
    )
    expect(dependencies.lines).toHaveLength(2)
    expect(dependencies.lines[0]).toContain('iphone: record refused')
    expect(dependencies.lines[1]).toContain('desktop-wide')
  })

  it('refuses a run with no device at all', async () => {
    await expect(
      runPipeline(
        { devices: [], out: 'out', script: 'demo/x.ts', upload: false },
        stubs(),
      ),
    ).rejects.toThrow(/No device requested/)
  })
})

describe('prepareCapture', () => {
  it('lets every desktop preset through, not just the one M1 measured', () => {
    // The whole point of ticket 55: the capture area is the device's answer, so a
    // preset is no longer gated on matching one constant in src/capture.ts.
    for (const preset of ['desktop', 'desktop-wide', 'safari']) {
      expect(prepareCapture(resolveDevice(preset))).toMatchObject({
        height: 1600,
        status: 'decided',
        strategy: 'screencast',
        width: 2560,
      })
    }
  })

  it('hands on an unusual capture area instead of substituting its own', () => {
    // An override is the caller saying "record this rectangle". Nothing in
    // the gate may quietly replace it with the geometry M1 happened to use.
    expect(
      prepareCapture(
        resolveDevice({
          capture: { height: 2000, strategy: 'screencast', width: 3200 },
          extends: 'desktop',
        }),
      ),
    ).toMatchObject({ height: 2000, width: 3200 })
  })

  it('still refuses the capture settings the capture stage does own', () => {
    // Dropping the area from this gate must not hollow the rest of it out:
    // JPEG quality and frame rate are still the capture stage's own, and a
    // device asking for different ones has to be told, not humoured.
    expect(() =>
      prepareCapture(
        resolveDevice({
          capture: {
            height: 1600,
            quality: 70,
            strategy: 'screencast',
            width: 2560,
          },
          extends: 'desktop',
        }),
      ),
    ).toThrow(/JPEG quality 70/)
    expect(() =>
      prepareCapture(
        resolveDevice({
          capture: {
            fps: 30,
            height: 1600,
            strategy: 'screencast',
            width: 2560,
          },
          extends: 'desktop',
        }),
      ),
    ).toThrow(/30 fps/)
  })

  it('lets both implemented strategies through', () => {
    // M3 left two strategies standing, and the gate is about geometry and
    // cadence rather than about which of them is in use.
    for (const name of ['desktop', 'iphone']) {
      expect(() => prepareCapture(resolveDevice(name))).not.toThrow()
    }
  })

  it('refuses a framed device with no application address, before the browser', () => {
    expect(() => requireAppUrl(resolveDevice('iphone'), undefined)).toThrow(
      /export const url/,
    )
    expect(() =>
      requireAppUrl(resolveDevice('desktop'), undefined),
    ).not.toThrow()
  })
})

describe('formatsFor', () => {
  it('delivers the one size the preset promises, labelled by its ratio', () => {
    expect(formatsFor(resolveDevice('desktop').output, false)).toEqual([
      { desired: { height: 1080, width: 1920 }, label: '16:9' },
    ])
    expect(formatsFor(resolveDevice('iphone').output, false)).toEqual([
      { desired: { height: 1920, width: 1080 }, label: '9:16' },
    ])
  })

  it('names a ratio that has no name by its pixels', () => {
    // `desktop-wide` is 16:10 and `tablet` is 3:4. Neither is one of the
    // curated three, and both used to be unreachable from the chain because
    // a format was a name rather than a size.
    expect(formatsFor(resolveDevice('desktop-wide').output, false)).toEqual([
      { desired: { height: 1200, width: 1920 }, label: '1920x1200' },
    ])
    expect(formatsFor(resolveDevice('tablet').output, false)[0]?.label).toBe(
      '1200x1600',
    )
  })

  it('switches to all three only when asked', () => {
    expect(
      formatsFor(resolveDevice('desktop-wide').output, true).map(
        (format) => format.label,
      ),
    ).toEqual(['16:9', '9:16', '1:1'])
  })
})

describe('deviceSlug', () => {
  it('turns a registry name into something that reads in a URL', () => {
    expect(deviceSlug('Desktop Chrome HiDPI')).toBe('desktop-chrome-hidpi')
    expect(deviceSlug('iPhone 15 Pro landscape')).toBe(
      'iphone-15-pro-landscape',
    )
    expect(deviceSlug('desktop-wide')).toBe('desktop-wide')
  })

  it('never produces an empty path or key component', () => {
    // An empty slug would silently make `<out>/` and `<stem>/.mp4`.
    expect(deviceSlug('///')).toBe('device')
  })
})

describe('scriptStem', () => {
  it('names the run after the script, without its extension', () => {
    expect(scriptStem('demo/feature-xy.ts')).toBe('feature-xy')
  })
})

describe('importScript', () => {
  it('loads the exported recording body', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'recording.mjs')
    await writeFile(path, 'export default async () => "ran"\n')
    const loaded = await importScript(path)
    expect(typeof loaded.recording).toBe('function')
    // No setup export means no setup step, not an empty one that runs.
    expect(loaded.prepare).toBeUndefined()
  })

  it('carries a setup step that runs before the camera rolls', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'recording-prepare.mjs')
    await writeFile(
      path,
      'export const prepare = async () => "signed in"\n' +
        'export default async () => undefined\n',
    )
    const loaded = await importScript(path)
    expect(typeof loaded.prepare).toBe('function')
    // It is the file's own function, not a wrapper: what it returns comes
    // back, so a setup step that throws throws where the caller can see it.
    expect(await loaded.prepare?.({} as never)).toBe('signed in')
  })

  it('ignores a `prepare` that is not a function instead of calling it', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'recording-prepare-wrong.mjs')
    await writeFile(
      path,
      'export const prepare = "soon"\nexport default async () => undefined\n',
    )
    expect((await importScript(path)).prepare).toBeUndefined()
  })

  it('accepts `recording` for a file that already has a default export', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'recording-named.mjs')
    await writeFile(
      path,
      'export default 42\nexport const recording = async () => undefined\n',
    )
    expect(typeof (await importScript(path)).recording).toBe('function')
  })

  it('hands the setup step to the recorder, not to the demo wrapper', async () => {
    // The chain's only job with `prepare` is to carry it intact: it is a plain
    // Playwright page function, so it must not be wrapped, paced or written to
    // the event log. Where it runs relative to the capture is `src/session.ts`'s
    // promise, and the recording on the box is what shows it kept.
    const prepare = async (): Promise<void> => undefined
    const recording = async (): Promise<void> => undefined
    const deps = stubs({
      loadScript: vi.fn(async () => ({ prepare, recording })),
    })
    await runPipeline(
      {
        devices: ['desktop-wide'],
        out: 'artifacts/prepare',
        script: 'demo/feature-xy.ts',
        upload: false,
      },
      deps,
    )
    const recordMock = deps.record as unknown as {
      mock: { calls: unknown[][] }
    }
    expect(recordMock.mock.calls[0]?.[2]).toEqual({ prepare, recording })
  })

  it('carries the three facts about the context a script cannot set itself', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'recording-authenticated.mjs')
    await writeFile(
      path,
      "export const storageStatePath = 'auth/state.json'\n" +
        "export const hideSelectors = ['#cookie-banner', '#room-card']\n" +
        "export const fixedTime = '2026-01-15T09:00:00Z'\n" +
        'export default async () => undefined\n',
    )
    const loaded = await importScript(path)
    // The path, and nothing read from the file it names: the chain never
    // holds the session, the browser opens it.
    expect(loaded.storageStatePath).toBe('auth/state.json')
    expect(loaded.hideSelectors).toEqual(['#cookie-banner', '#room-card'])
    expect(loaded.fixedTime).toBe('2026-01-15T09:00:00Z')
  })

  it('refuses a session handed over as state instead of as a path', async () => {
    // The one mistake with a real cost. An inlined `storageState` object is
    // a set of live cookies in a versioned file; Playwright would even
    // accept it. The refusal is what keeps the access on disk, under
    // `auth/`, where git does not look.
    const directory = await temporaryDirectory()
    const path = join(directory, 'recording-inline-state.mjs')
    await writeFile(
      path,
      'export const storageStatePath = { cookies: [] }\n' +
        'export default async () => undefined\n',
    )
    await expect(importScript(path)).rejects.toThrow(
      /storageStatePath.*path of a Playwright storageState file/s,
    )
  })

  it('refuses a single selector where a list of them belongs', async () => {
    // Silent otherwise, and invisibly so: a string reaches the browser as a
    // context option, hides nothing, and the recording that comes out is
    // perfect except for the surface that had to go.
    const directory = await temporaryDirectory()
    const path = join(directory, 'recording-one-selector.mjs')
    await writeFile(
      path,
      "export const hideSelectors = '#cookie-banner'\n" +
        'export default async () => undefined\n',
    )
    await expect(importScript(path)).rejects.toThrow(
      /hideSelectors.*list of CSS selectors/s,
    )
  })

  it('refuses an instant no Date can read', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'recording-bad-time.mjs')
    await writeFile(
      path,
      "export const fixedTime = 'yesterday morning'\n" +
        'export default async () => undefined\n',
    )
    await expect(importScript(path)).rejects.toThrow(/fixedTime.*an instant/s)
  })

  it('hands the context settings to the browser leg intact', async () => {
    const recording = async (): Promise<void> => undefined
    const script = {
      fixedTime: '2026-01-15T09:00:00Z',
      hideSelectors: ['#room-card'],
      recording,
      storageStatePath: 'auth/state.json',
    }
    const deps = stubs({ loadScript: vi.fn(async () => script) })
    await runPipeline(
      {
        devices: ['desktop-wide'],
        out: 'artifacts/authenticated',
        script: 'demo/raven-meetings.ts',
        upload: false,
      },
      deps,
    )
    const recordMock = deps.record as unknown as {
      mock: { calls: unknown[][] }
    }
    expect(recordMock.mock.calls[0]?.[2]).toEqual(script)
  })

  it('says what a script has to export when it exports nothing usable', async () => {
    // The contract is not obvious — scripts in docs/RECORDING-SCRIPTS.md
    // call record() themselves — so the failure has to teach it.
    const directory = await temporaryDirectory()
    const path = join(directory, 'empty.mjs')
    await writeFile(path, 'export const unrelated = 1\n')
    await expect(importScript(path)).rejects.toThrow(
      /exports no recording function.*must not call record\(\)/s,
    )
  })
})
