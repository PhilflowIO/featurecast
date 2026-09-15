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
    expect(parsed.options.formats?.map((format) => format.aspect)).toEqual([
      '9:16',
      '1:1',
    ])
  })

  it('names the available formats when asked for one that does not exist', () => {
    expect(() => parseArguments(['in', 'out', '--formats', '4:3'])).toThrow(
      /Available: 16:9, 9:16, 1:1/,
    )
  })

  it('rejects an unknown option instead of ignoring it', () => {
    expect(() => parseArguments(['in', 'out', '--sharpen'])).toThrow(
      /Unknown option/,
    )
  })
})
