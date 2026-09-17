import { describe, expect, it, vi } from 'vitest'

import {
  buildCompareFilter,
  buildComparePlan,
  commonHeight,
  labelFontSize,
  parseCompareArguments,
  runCompare,
  scaledWidth,
  type CompareSide,
} from '../src/compare.js'
import { parseVideoInfo, type VideoInfo } from '../src/probe.js'

function video(overrides: Partial<VideoInfo> = {}): VideoInfo {
  return {
    durationSeconds: 10,
    height: 1080,
    path: 'left.mp4',
    width: 1920,
    ...overrides,
  }
}

const SIDES: readonly [CompareSide, CompareSide] = [
  { label: 'rendered at device resolution', path: 'left.mp4' },
  { label: 'upscaled from a smaller capture', path: 'right.mp4' },
]

/** The per-side chain, split out of the graph, so a test can read one side. */
function sideChain(filter: string, index: 0 | 1): string {
  const chain = filter
    .split(';')
    .find((part) => part.startsWith(`[${String(index)}:v]`))
  expect(chain).toBeDefined()
  return chain as string
}

describe('the comparison picture', () => {
  it('puts both inputs in one frame, side by side', () => {
    const filter = buildCompareFilter(SIDES, [video(), video()])
    expect(filter).toContain('[side0][side1]hstack=inputs=2[stacked]')
    const plan = buildComparePlan(SIDES, [video(), video()], 'out.mp4')
    expect(plan.arguments).toContain('-map')
    expect(plan.arguments).toContain('[stacked]')
    // One output file, not two: the whole point is that the two pictures are
    // on screen at the same instant.
    expect(plan.arguments.filter((one) => one.endsWith('.mp4'))).toEqual([
      'left.mp4',
      'right.mp4',
      'out.mp4',
    ])
  })

  it('burns each label into its own side of the picture', () => {
    const filter = buildCompareFilter(SIDES, [video(), video()])
    expect(sideChain(filter, 0)).toContain(
      "drawtext=text='rendered at device resolution'",
    )
    expect(sideChain(filter, 1)).toContain(
      "drawtext=text='upscaled from a smaller capture'",
    )
    // Not merely present somewhere — attached to the correct input. A
    // comparison whose labels are swapped proves the opposite of its claim.
    expect(sideChain(filter, 0)).not.toContain('upscaled')
    expect(sideChain(filter, 1)).not.toContain('device resolution')
  })

  it('draws the label after the retiming, so every output frame carries it', () => {
    const chain = sideChain(buildCompareFilter(SIDES, [video(), video()]), 0)
    expect(chain.indexOf('setpts')).toBeLessThan(chain.indexOf('drawtext'))
  })

  it('slows both sides down, by the same factor, five times by default', () => {
    const filter = buildCompareFilter(SIDES, [video(), video()])
    expect(sideChain(filter, 0)).toContain('setpts=5.0000*PTS')
    expect(sideChain(filter, 1)).toContain('setpts=5.0000*PTS')
  })

  it('takes the slowdown factor as a parameter', () => {
    const filter = buildCompareFilter(SIDES, [video(), video()], { slow: 2.5 })
    expect(sideChain(filter, 0)).toContain('setpts=2.5000*PTS')
    expect(sideChain(filter, 1)).toContain('setpts=2.5000*PTS')
  })

  it('refuses a slowdown factor that is not a factor', () => {
    for (const slow of [0, -3, Number.NaN]) {
      expect(() =>
        buildCompareFilter(SIDES, [video(), video()], { slow }),
      ).toThrow(/--slow must be a positive factor/)
    }
  })

  it('keeps a long label inside its own half of the picture', () => {
    // The failure this pins actually shipped once: a 540x960 recording next
    // to a 1080x1920 one, and `upscaled from a 540x960 capture` cut off after
    // `captur`. A comparison with half a caption on it says nothing.
    const sides: readonly [CompareSide, CompareSide] = [
      { label: 'rendered at device resolution', path: 'left.mp4' },
      { label: 'upscaled from a 540x960 capture', path: 'right.mp4' },
    ]
    const probes: readonly [VideoInfo, VideoInfo] = [
      video({ height: 1920, width: 1080 }),
      video({ height: 960, width: 540 }),
    ]
    const size = labelFontSize(sides, probes, 1920)
    for (const [index, side] of sides.entries()) {
      const info = probes[index]
      if (info === undefined) continue
      const drawn = side.label.length * 0.62 * size
      expect(drawn).toBeLessThan(scaledWidth(info, 1920))
    }
    expect(buildCompareFilter(sides, probes)).toContain(
      `fontsize=${String(size)}`,
    )
  })

  it('shrinks the type for a longer label, not for a shorter one', () => {
    const probes: readonly [VideoInfo, VideoInfo] = [video(), video()]
    const short = labelFontSize(
      [
        { label: 'before', path: 'a.mp4' },
        { label: 'after', path: 'b.mp4' },
      ],
      probes,
      1080,
    )
    const long = labelFontSize(
      [
        { label: 'a'.repeat(200), path: 'a.mp4' },
        { label: 'after', path: 'b.mp4' },
      ],
      probes,
      1080,
    )
    expect(long).toBeLessThan(short)
  })

  it('gives both sides the same size, so neither reads as the headline', () => {
    const filter = buildCompareFilter(
      [
        { label: 'x', path: 'a.mp4' },
        { label: 'a much, much longer caption over here', path: 'b.mp4' },
      ],
      [video(), video()],
    )
    const sizes = [...filter.matchAll(/fontsize=(\d+)/g)].map(
      (match) => match[1],
    )
    expect(sizes).toHaveLength(2)
    expect(sizes[0]).toBe(sizes[1])
  })

  it('refuses a label it cannot draw, instead of drawing half of it', () => {
    expect(() =>
      buildCompareFilter(
        [{ label: "it's soft", path: 'a.mp4' }, SIDES[1]],
        [video(), video()],
      ),
    ).toThrow(/left label contains/)
    expect(() =>
      buildCompareFilter(
        [SIDES[0], { label: '  ', path: 'b.mp4' }],
        [video(), video()],
      ),
    ).toThrow(/right label is empty/)
  })
})

describe('two inputs that do not match', () => {
  it('brings both sides to one height, the taller of the two', () => {
    const filter = buildCompareFilter(SIDES, [
      video({ height: 1920, width: 1080 }),
      video({ height: 960, width: 540 }),
    ])
    expect(sideChain(filter, 0)).toContain('scale=-2:1920')
    expect(sideChain(filter, 1)).toContain('scale=-2:1920')
  })

  it('never shrinks the better side to meet the worse one', () => {
    // Downwards would resample the sharp side and soften away exactly the
    // difference the comparison exists to show.
    expect(
      commonHeight([video({ height: 1920 }), video({ height: 960 })]),
    ).toBe(1920)
  })

  it('takes a common height when one is named, and keeps it even', () => {
    expect(commonHeight([video(), video()], 721)).toBe(722)
    expect(() => commonHeight([video(), video()], -4)).toThrow(
      /--height must be a positive number/,
    )
  })

  it('holds the shorter side on its last frame until the longer one ends', () => {
    const filter = buildCompareFilter(SIDES, [
      video({ durationSeconds: 12 }),
      video({ durationSeconds: 9.5 }),
    ])
    expect(sideChain(filter, 0)).not.toContain('tpad')
    expect(sideChain(filter, 1)).toContain(
      'tpad=stop_mode=clone:stop_duration=2.500',
    )
  })

  it('measures the freeze in input seconds, before the slowdown stretches it', () => {
    const chain = sideChain(
      buildCompareFilter(
        SIDES,
        [video({ durationSeconds: 12 }), video({ durationSeconds: 9.5 })],
        { slow: 5 },
      ),
      1,
    )
    // 2.5 source seconds, not 12.5: `tpad` before `setpts` is what makes the
    // two sides end together.
    expect(chain).toContain('stop_duration=2.500')
    expect(chain.indexOf('tpad')).toBeLessThan(chain.indexOf('setpts'))
  })

  it('refuses a file that is not a picture rather than stacking nothing', () => {
    expect(() => commonHeight([video({ height: 0 }), video()])).toThrow(
      /not a picture that can be stacked/,
    )
  })

  it('refuses a file with no readable duration, naming it', () => {
    expect(() =>
      parseVideoInfo(
        JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }),
        'broken.mp4',
      ),
    ).toThrow(/broken\.mp4 reports no usable duration/)
  })
})

describe('the encoded comparison', () => {
  it('speaks the repository’s encoder vocabulary, not ffmpeg’s', () => {
    const plan = buildComparePlan(SIDES, [video(), video()], 'out.mp4')
    expect(plan.command).toBe('ffmpeg')
    expect(plan.arguments).toContain('libx264')
    expect(plan.arguments).toContain('-crf')
    const nvenc = buildComparePlan(SIDES, [video(), video()], 'out.mp4', {
      quality: { cq: 21, encoder: 'nvenc-h264' },
    })
    // NVENC does not understand `-crf`, and a bitrate target starves a dense
    // screencast — the same three flags the render stage writes.
    expect(nvenc.arguments).toContain('h264_nvenc')
    expect(nvenc.arguments).toContain('-cq')
    expect(nvenc.arguments).toContain('-rc')
    expect(nvenc.arguments).not.toContain('-crf')
  })
})

describe('the compare command line', () => {
  it('takes two videos and the file they go into', () => {
    const request = parseCompareArguments(['a.mp4', 'b.mp4', '--out', 'c.mp4'])
    expect(request?.sides[0].path).toBe('a.mp4')
    expect(request?.sides[1].path).toBe('b.mp4')
    expect(request?.outputPath).toBe('c.mp4')
  })

  it('names the sides after their files unless told otherwise', () => {
    const bare = parseCompareArguments([
      'x/left-run.mp4',
      'y/right-run.mp4',
      '--out',
      'c.mp4',
    ])
    expect(bare?.sides.map((side) => side.label)).toEqual([
      'left-run',
      'right-run',
    ])
    const named = parseCompareArguments([
      'a.mp4',
      'b.mp4',
      '--out',
      'c.mp4',
      '--label-left',
      'stock browser build',
      '--label-right',
      'patched browser build',
    ])
    expect(named?.sides.map((side) => side.label)).toEqual([
      'stock browser build',
      'patched browser build',
    ])
  })

  it('insists on somewhere to put the result', () => {
    expect(() => parseCompareArguments(['a.mp4', 'b.mp4'])).toThrow(
      /--out is required/,
    )
  })

  it('refuses to write the comparison over its own material', () => {
    expect(() =>
      parseCompareArguments(['a.mp4', 'b.mp4', '--out', 'b.mp4']),
    ).toThrow(/would\s+overwrite the material/)
  })

  it('takes two videos, not three', () => {
    expect(() =>
      parseCompareArguments(['a.mp4', 'b.mp4', 'c.mp4', '--out', 'd.mp4']),
    ).toThrow(/takes two videos, got 3/)
  })

  it('carries the look flags through', () => {
    const request = parseCompareArguments([
      'a.mp4',
      'b.mp4',
      '--out',
      'c.mp4',
      '--slow',
      '3',
      '--height',
      '720',
      '--fps',
      '30',
    ])
    expect(request?.options).toMatchObject({ fps: 30, height: 720, slow: 3 })
  })

  it('refuses an encoder it does not have, by name', () => {
    expect(() =>
      parseCompareArguments([
        'a.mp4',
        'b.mp4',
        '--out',
        'c.mp4',
        '--encoder',
        'libx264',
      ]),
    ).toThrow(/Unknown encoder "libx264"/)
  })

  it('prints the usage instead of guessing when asked for nothing', () => {
    expect(parseCompareArguments([])).toBeUndefined()
    expect(parseCompareArguments(['--help'])).toBeUndefined()
  })

  it('rejects an unknown option instead of ignoring it', () => {
    expect(() =>
      parseCompareArguments(['a.mp4', 'b.mp4', '--out', 'c.mp4', '--sharpen']),
    ).toThrow(/Unknown option/)
  })
})

describe('running a comparison', () => {
  it('probes both inputs before it decides anything', async () => {
    const probe = vi.fn(async (path: string) =>
      Promise.resolve(
        video(
          path === 'right.mp4'
            ? { durationSeconds: 4, height: 960, path, width: 540 }
            : { durationSeconds: 6, height: 1920, path, width: 1080 },
        ),
      ),
    )
    const commands: string[][] = []
    const run = async (
      _command: string,
      arguments_: readonly string[],
    ): Promise<void> => {
      commands.push([...arguments_])
    }
    let written = ''
    await runCompare(
      { options: {}, outputPath: 'out.mp4', sides: SIDES },
      { probe, run, write: (text) => (written += text) },
    )
    expect(probe.mock.calls.map((call) => call[0])).toEqual([
      'left.mp4',
      'right.mp4',
    ])
    const arguments_ = commands[0] ?? []
    const filter = arguments_[arguments_.indexOf('-filter_complex') + 1] ?? ''
    expect(filter).toContain('scale=-2:1920')
    expect(filter).toContain('stop_duration=2.000')
    // The report says what was done to each side, so a reader of the log can
    // tell a frozen tail from a hung encode.
    expect(written).toContain('holds its last frame for 2.00s')
    expect(written).toContain('5.0x slower')
  })
})
