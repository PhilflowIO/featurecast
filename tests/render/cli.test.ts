import { describe, expect, it } from 'vitest'

import { parseArguments } from '../../src/render/cli.js'

describe('the render command', () => {
  it('takes a capture directory and an output directory', () => {
    const parsed = parseArguments(['artifacts/m1-008', 'dist/feature-xy'])
    expect(parsed.captureDirectory).toBe('artifacts/m1-008')
    expect(parsed.outDirectory).toBe('dist/feature-xy')
  })

  it('insists on both directories rather than guessing one', () => {
    expect(() => parseArguments(['only-one'])).toThrow(/required/)
  })

  it('turns look flags into look parameters', () => {
    const parsed = parseArguments([
      'in',
      'out',
      '--padding',
      '60',
      '--cursor-size',
      '32',
      '--no-cursor',
      '--idle-threshold',
      '900',
    ])
    expect(parsed.options.zoom?.paddingPx).toBe(60)
    expect(parsed.options.cursor?.sizePx).toBe(32)
    expect(parsed.options.cursor?.visible).toBe(false)
    expect(parsed.options.idle?.thresholdMs).toBe(900)
  })

  it('accepts a subset of the formats', () => {
    const parsed = parseArguments(['in', 'out', '--formats', '9:16,1:1'])
    expect(parsed.options.formats?.map((format) => format.label)).toEqual([
      '9:16',
      '1:1',
    ])
  })

  it('names the available formats when asked for one that does not exist', () => {
    expect(() => parseArguments(['in', 'out', '--formats', '4:3'])).toThrow(
      /Available: 16:9, 9:16, 1:1/,
    )
  })

  it('leaves the encoder alone unless asked, and names it when asked', () => {
    // Nothing set means nothing overridden: the device layer's own choice
    // survives instead of being replaced by a render-side default.
    expect(parseArguments(['in', 'out']).options.encoder).toBeUndefined()
    expect(
      parseArguments(['in', 'out', '--encoder', 'nvenc-h264']).options.encoder,
    ).toEqual({ cq: 23, encoder: 'nvenc-h264' })
    // The quality number lands on the scale its encoder speaks — `cq` for the
    // GPU, `crf` for the CPU — because the two are not the same number.
    expect(
      parseArguments([
        'in',
        'out',
        '--encoder',
        'nvenc-hevc',
        '--quality',
        '21',
      ]).options.encoder,
    ).toEqual({ cq: 21, encoder: 'nvenc-hevc' })
    expect(
      parseArguments(['in', 'out', '--quality', '18']).options.encoder,
    ).toEqual({ crf: 18, encoder: 'x264' })
  })

  it('refuses an encoder it does not have, by name', () => {
    expect(() => parseArguments(['in', 'out', '--encoder', 'libx264'])).toThrow(
      /Unknown encoder "libx264"\. Available: nvenc-h264, nvenc-hevc, x264/,
    )
  })

  it('rejects an unknown option instead of ignoring it', () => {
    expect(() => parseArguments(['in', 'out', '--sharpen'])).toThrow(
      /Unknown option/,
    )
  })
})
