import { describe, expect, it, vi } from 'vitest'

import {
  afterCrop,
  afterStart,
  buildCompareFilter,
  buildComparePlan,
  commonHeight,
  compareOutputSize,
  frameWidth,
  labelBandHeight,
  labelFontSize,
  parseCompareArguments,
  parseCropSpec,
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
    expect(filter).toContain('[side0][side1]hstack=inputs=2')
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

  it('puts three pictures in one row when three were given', () => {
    const sides: CompareSide[] = [
      { label: 'wide for a landing page', path: 'wide.mp4' },
      { label: 'tall for a phone', path: 'tall.mp4' },
      { label: 'square for a feed', path: 'square.mp4' },
    ]
    const probes = [
      video({ path: 'wide.mp4', width: 1920, height: 1080 }),
      video({ path: 'tall.mp4', width: 900, height: 1600 }),
      video({ path: 'square.mp4', width: 1080, height: 1080 }),
    ]
    const filter = buildCompareFilter(sides, probes)
    expect(filter).toContain('[side0][side1][side2]hstack=inputs=3,')
    // Each picture is an input of its own, in the order it was named: a row
    // that drew the same file twice would look like a comparison and be one
    // file short of it.
    const plan = buildComparePlan(sides, probes, 'row.mp4')
    expect(plan.arguments.filter((one) => one === '-i')).toHaveLength(3)
    expect(plan.arguments.filter((one) => one.endsWith('.mp4'))).toEqual([
      'wide.mp4',
      'tall.mp4',
      'square.mp4',
      'row.mp4',
    ])
  })

  it('refuses one picture and refuses five', () => {
    expect(() => buildCompareFilter([SIDES[0]], [video()])).toThrow(
      /at least 2 videos/,
    )
    expect(() =>
      buildCompareFilter(
        [SIDES[0], SIDES[1], SIDES[0], SIDES[1], SIDES[0]],
        [video(), video(), video(), video(), video()],
      ),
    ).toThrow(/at most 4 videos in a row/)
  })

  it('lets the caller size the caption for the width it will be read at', () => {
    // The automatic size is a twenty-eighth of the picture, which assumes the
    // clip is watched at its own resolution. A row destined for a README
    // column is watched at a fraction of it, and the caption arrives there
    // too small to read. The caller knows that width; the command cannot.
    const automatic = buildCompareFilter(SIDES, [video(), video()])
    expect(automatic).toContain('fontsize=39')
    const asked = buildCompareFilter(SIDES, [video(), video()], {
      labelSize: 90,
    })
    expect(asked).toContain('fontsize=90')
    // The fit rule still wins: a caption wider than the picture it sits on
    // would walk off the edge, which is the failure the rule exists for.
    const absurd = buildCompareFilter(SIDES, [video(), video()], {
      labelSize: 4000,
    })
    expect(absurd).not.toContain('fontsize=4000')
    // And the band grows with the type, so the caption never lands on the
    // picture it captions.
    expect(asked).toContain(`pad=iw:ih+${String(labelBandHeight(90))}`)
  })

  it('escapes a colon in a caption instead of losing half of it', () => {
    // Found in a finished picture: `16:9 for a landing page` was drawn as
    // `9 for a landing page`, because drawtext splits its own options on
    // colons even inside a quoted section. Nothing errored.
    const filter = buildCompareFilter(
      [
        { label: '16:9 for a landing page', path: 'a.mp4' },
        { label: '9:16 for a phone', path: 'b.mp4' },
      ],
      [video(), video()],
    )
    expect(filter).toContain(String.raw`text='16\:9 for a landing page'`)
    expect(filter).toContain(String.raw`text='9\:16 for a phone'`)
  })

  it('counts one frame per picture and one closing the row', () => {
    // A row of three has four frames, not three: one down the left of each
    // picture and one shutting the right edge. Getting that count wrong makes
    // the announced size disagree with the encoded one, which is the whole
    // point of being able to state it.
    const sides: CompareSide[] = [
      { label: 'wide', path: 'wide.mp4' },
      { label: 'tall', path: 'tall.mp4' },
      { label: 'square', path: 'square.mp4' },
    ]
    const probes = [
      video({ path: 'wide.mp4', width: 1920, height: 1080 }),
      video({ path: 'tall.mp4', width: 1080, height: 1080 }),
      video({ path: 'square.mp4', width: 1080, height: 1080 }),
    ]
    const size = compareOutputSize(sides, probes)
    const frame = frameWidth(labelFontSize(sides, probes, 1080))
    expect(size.frame).toBe(frame)
    expect(size.width).toBe(1920 + 1080 + 1080 + frame * 4)
  })

  it('cuts every side to the same length budget', () => {
    const plan = buildComparePlan(SIDES, [video(), video()], 'out.mp4', {
      seconds: 9,
    })
    // On the output, after the filter graph: on an input it would be counted
    // in input seconds, which --slow stretches.
    expect(plan.arguments.indexOf('-t')).toBeGreaterThan(
      plan.arguments.indexOf('-filter_complex'),
    )
    expect(plan.arguments[plan.arguments.indexOf('-t') + 1]).toBe('9')
    // A budget shorter than both inputs makes them equally long, so no side
    // freezes waiting for another.
    const filter = buildCompareFilter(
      SIDES,
      [video({ durationSeconds: 30 }), video({ durationSeconds: 24 })],
      { seconds: 9 },
    )
    expect(filter).not.toContain('tpad')
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

  it('runs at real time unless somebody asks for slow motion', () => {
    // Slowing a comparison down makes the smooth side look broken: a pointer
    // path that is even at real speed reads as a stutter at a fifth speed.
    // A published comparison must not argue against the thing it shows.
    const filter = buildCompareFilter(SIDES, [video(), video()])
    expect(sideChain(filter, 0)).toContain('setpts=1.0000*PTS')
    expect(sideChain(filter, 1)).toContain('setpts=1.0000*PTS')
  })

  it('slows both sides by the same factor when asked to', () => {
    const filter = buildCompareFilter(SIDES, [video(), video()], { slow: 5 })
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

describe('the caption band', () => {
  it('adds the caption above the picture instead of painting over it', () => {
    const filter = buildCompareFilter(SIDES, [video(), video()])
    for (const index of [0, 1] as const) {
      const chain = sideChain(filter, index)
      // The picture is pushed down by exactly the band, so the first row of
      // the filmed application is still the first row of the picture.
      expect(chain).toMatch(/pad=iw:ih\+(\d+):0:\1:color=black/)
      expect(chain.indexOf('pad=')).toBeLessThan(chain.indexOf('drawtext'))
    }
  })

  it('makes the finished frame taller than the material it is made of', () => {
    // Without this the regression is invisible from the outside: a caption
    // that has fallen back onto the video and a caption in a band look the
    // same in every other assertion.
    const probes: readonly [VideoInfo, VideoInfo] = [
      video({ height: 1080, width: 1920 }),
      video({ height: 1080, width: 1920 }),
    ]
    const size = compareOutputSize(SIDES, probes)
    expect(size.height).toBeGreaterThan(1080)
    expect(size.height).toBe(1080 + size.band + size.frame)
    expect(size.width).toBe(3840 + size.frame * 3)
  })

  it('derives the band from the type size, not from a guessed constant', () => {
    expect(labelBandHeight(40)).toBe(76)
    expect(labelBandHeight(20)).toBe(38)
    // Even, because an odd frame dimension is not encodable as yuv420p.
    expect(labelBandHeight(21) % 2).toBe(0)
  })

  it('gives both sides the same band, so the halves stay flush', () => {
    const filter = buildCompareFilter(
      [
        { label: 'x', path: 'a.mp4' },
        { label: 'a much, much longer caption over here', path: 'b.mp4' },
      ],
      [
        video({ height: 1920, width: 1080 }),
        video({ height: 960, width: 540 }),
      ],
    )
    const bands = [...filter.matchAll(/pad=iw:ih\+(\d+)/g)].map(
      (match) => match[1],
    )
    expect(bands).toHaveLength(2)
    expect(bands[0]).toBe(bands[1])
  })

  it('sits the caption inside the band rather than on the first frame row', () => {
    const chain = sideChain(buildCompareFilter(SIDES, [video(), video()]), 0)
    const band = /pad=iw:ih\+(\d+)/.exec(chain)?.[1] ?? '0'
    expect(chain).toContain(`y=(${band}-text_h)/2`)
  })
})

describe('starting both sides later', () => {
  it('takes the offset off both sides, in the inputs’ own seconds', () => {
    const plan = buildComparePlan(
      SIDES,
      [video({ durationSeconds: 30 }), video({ durationSeconds: 30 })],
      'out.mp4',
      { from: 10 },
    )
    const seeks = plan.arguments.filter((one) => one === '-ss')
    expect(seeks).toHaveLength(2)
    // Before each input, not once after them: `-ss` after the inputs seeks
    // the output and would cut the front off the comparison instead of the
    // front off the material.
    expect(plan.arguments.indexOf('-ss')).toBeLessThan(
      plan.arguments.indexOf('-i'),
    )
  })

  it('re-reads which side is the longer one after the offset', () => {
    // 12s and 11s becomes 2s and 1s: the same side is still longer here, but
    // the hold has to shrink with it or the shorter side freezes for ten
    // seconds of nothing.
    const left = afterStart(
      [video({ durationSeconds: 12 }), video({ durationSeconds: 11 })],
      10,
    )
    expect(left.map((one) => one.durationSeconds)).toEqual([2, 1])
    const filter = buildCompareFilter(
      SIDES,
      [video({ durationSeconds: 12 }), video({ durationSeconds: 11 })],
      { from: 10 },
    )
    expect(sideChain(filter, 1)).toContain('stop_duration=1.000')
  })

  it('refuses an offset past the end of a side, naming it', () => {
    expect(() =>
      afterStart([video({ durationSeconds: 4, path: 'short.mp4' })], 9),
    ).toThrow(/past the end of short\.mp4/)
    expect(() => afterStart([video()], -1)).toThrow(/--from must be a number/)
  })

  it('leaves the command alone when nobody asks for an offset', () => {
    const plan = buildComparePlan(SIDES, [video(), video()], 'out.mp4')
    expect(plan.arguments).not.toContain('-ss')
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

describe('comparing a region instead of whole frames', () => {
  const CROP = { height: 560, width: 470, x: 500, y: 140 }

  it('takes the rectangle out of both sides, before anything is scaled', () => {
    const filter = buildCompareFilter(SIDES, [video(), video()], {
      crop: CROP,
    })
    for (const index of [0, 1] as const) {
      const chain = sideChain(filter, index)
      expect(chain).toContain('crop=470:560:500:140')
      // The rectangle is read off a still of the input, so it has to be in
      // the input's pixels. After a scale it would mean something different
      // on every run with a different --height.
      expect(chain.indexOf('crop=')).toBeLessThan(chain.indexOf('scale='))
    }
  })

  it('sizes the finished frame from the rectangle, not from the inputs', () => {
    const whole = compareOutputSize(SIDES, [video(), video()])
    const cropped = compareOutputSize(SIDES, [video(), video()], { crop: CROP })
    expect(whole.width).toBe(1920 * 2 + whole.frame * 3)
    // Two 470-wide halves, brought to the crop's own height, plus the band
    // above them and the three frames around and between them.
    expect(cropped.width).toBe(470 * 2 + cropped.frame * 3)
    expect(cropped.height).toBe(560 + cropped.band + cropped.frame)
  })

  it('leaves whole frames alone when no rectangle is asked for', () => {
    expect(buildCompareFilter(SIDES, [video(), video()])).not.toContain('crop=')
    expect(afterCrop([video(), video()], undefined)).toHaveLength(2)
  })

  it('refuses one rectangle across two differently sized inputs', () => {
    // The same numbers are a different part of the application in each, so
    // the picture would look like a comparison without being one.
    expect(() =>
      afterCrop(
        [
          video({ height: 1080, path: 'left.mp4', width: 1920 }),
          video({ height: 540, path: 'right.mp4', width: 960 }),
        ],
        CROP,
      ),
    ).toThrow(/would be a different region of each/)
  })

  it('refuses a rectangle that hangs over the edge, naming the input', () => {
    expect(() => afterCrop([video(), video()], { ...CROP, x: 1600 })).toThrow(
      /does not fit inside left\.mp4, which is 1920x1080/,
    )
    expect(() => afterCrop([video(), video()], { ...CROP, y: 900 })).toThrow(
      /does not fit inside/,
    )
  })

  it('refuses a rectangle with no area and a negative offset', () => {
    expect(() => afterCrop([video(), video()], { ...CROP, width: 0 })).toThrow(
      /positive whole-pixel size/,
    )
    expect(() => afterCrop([video(), video()], { ...CROP, x: -8 })).toThrow(
      /non-negative whole-pixel offset/,
    )
  })

  it('reads the geometry a caller types, and refuses a near miss', () => {
    expect(parseCropSpec('470x560+500+140')).toEqual(CROP)
    expect(parseCropSpec(' 470x560+500+140 ')).toEqual(CROP)
    for (const wrong of [
      '470x560',
      '470,560+500+140',
      '470x560+500',
      '470x560+500+140+0',
    ]) {
      expect(() => parseCropSpec(wrong)).toThrow(/WIDTHxHEIGHT\+X\+Y/)
    }
  })

  it('carries the rectangle from the command line into the picture', () => {
    const request = parseCompareArguments([
      'left.mp4',
      'right.mp4',
      '--out',
      'out.mp4',
      '--crop',
      '470x560+500+140',
    ])
    expect(request?.options.crop).toEqual(CROP)
    const plan = buildComparePlan(SIDES, [video(), video()], 'out.mp4', {
      crop: CROP,
    })
    expect(plan.arguments.join(' ')).toContain('crop=470:560:500:140')
  })
})

describe('telling the two halves apart', () => {
  it('frames each half and puts the frames between them, not only outside', () => {
    const filter = buildCompareFilter(SIDES, [video(), video()])
    const frame = frameWidth(labelFontSize(SIDES, [video(), video()], 1080))
    for (const index of [0, 1] as const) {
      // Each half carries its own frame on its left edge, so stacking them
      // puts one outside the picture and one in the middle.
      expect(sideChain(filter, index)).toContain(
        `pad=iw+${String(frame)}:ih:${String(frame)}:0:color=black`,
      )
    }
    // And the right and bottom edges are closed once, after the stack.
    expect(filter).toContain(
      `hstack=inputs=2,pad=iw+${String(frame)}:ih+${String(frame)}:0:0:color=black`,
    )
  })

  it('draws the frame after the caption, so the caption does not move into it', () => {
    const chain = sideChain(buildCompareFilter(SIDES, [video(), video()]), 0)
    expect(chain.indexOf('drawtext')).toBeLessThan(chain.lastIndexOf('pad='))
  })

  it('counts the frames into the finished size, three of them', () => {
    const size = compareOutputSize(SIDES, [video(), video()])
    expect(size.frame).toBeGreaterThan(0)
    expect(size.width).toBe(1920 * 2 + size.frame * 3)
    expect(size.height).toBe(1080 + size.band + size.frame)
  })

  it('keeps the frame in proportion to the type, and never hairline', () => {
    // A frame of one or two pixels is a rendering artefact to the eye, not a
    // separation; below that size it stops doing the only job it has.
    expect(frameWidth(40)).toBe(20)
    expect(frameWidth(4)).toBe(4)
    expect(frameWidth(40) % 2).toBe(0)
    expect(frameWidth(30) % 2).toBe(0)
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
  it('takes the videos and the file they go into', () => {
    const request = parseCompareArguments(['a.mp4', 'b.mp4', '--out', 'c.mp4'])
    expect(request?.sides.map((side) => side.path)).toEqual(['a.mp4', 'b.mp4'])
    expect(request?.outputPath).toBe('c.mp4')
  })

  it('takes a third and a fourth video, in the order they were typed', () => {
    const request = parseCompareArguments([
      'wide.mp4',
      'tall.mp4',
      'square.mp4',
      '--out',
      'row.mp4',
    ])
    expect(request?.sides.map((side) => side.path)).toEqual([
      'wide.mp4',
      'tall.mp4',
      'square.mp4',
    ])
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
      '--label',
      'stock browser build',
      '--label',
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

  it('refuses a row of one, and a row too wide to read', () => {
    expect(() => parseCompareArguments(['a.mp4', '--out', 'c.mp4'])).toThrow(
      /needs at least 2 videos/,
    )
    expect(() =>
      parseCompareArguments([
        'a.mp4',
        'b.mp4',
        'c.mp4',
        'd.mp4',
        'e.mp4',
        '--out',
        'f.mp4',
      ]),
    ).toThrow(/at most 4 videos in a row, got 5/)
  })

  it('refuses more captions than there are pictures to put them on', () => {
    // The extra caption is silently not drawn, and a row with a miscounted
    // caption looks finished. Nothing downstream would ever surface it.
    expect(() =>
      parseCompareArguments([
        'a.mp4',
        'b.mp4',
        '--out',
        'c.mp4',
        '--label',
        'one',
        '--label',
        'two',
        '--label',
        'three',
      ]),
    ).toThrow(/3 captions were given for 2 videos/)
  })

  it('carries the caption size and the length budget through', () => {
    const request = parseCompareArguments([
      'a.mp4',
      'b.mp4',
      '--out',
      'c.mp4',
      '--label-size',
      '96',
      '--seconds',
      '9',
    ])
    expect(request?.options).toMatchObject({ labelSize: 96, seconds: 9 })
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
    expect(written).toContain('1.0x slower')
  })
})
