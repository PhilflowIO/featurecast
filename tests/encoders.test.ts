import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ENCODER,
  encoderProfile,
  ENCODERS,
  resolveEncoder,
  type Encoder,
} from '../src/encoders.js'

/**
 * The mapping table is the whole reason this module exists, so it is pinned
 * entry by entry against literal ffmpeg codec names written out here by
 * hand. Deriving the expectation from `ENCODER_PROFILES` would make the test
 * agree with whatever the table currently says, including a swap.
 */
const EXPECTED: Readonly<Record<Encoder, { codec: string; family: string }>> = {
  'nvenc-h264': { codec: 'h264_nvenc', family: 'nvenc' },
  'nvenc-hevc': { codec: 'hevc_nvenc', family: 'nvenc' },
  x264: { codec: 'libx264', family: 'x264' },
}

describe('encoder vocabulary', () => {
  it('translates every name into the ffmpeg codec it stands for', () => {
    expect(encoderProfile('x264').ffmpegCodec).toBe('libx264')
    expect(encoderProfile('nvenc-h264').ffmpegCodec).toBe('h264_nvenc')
    expect(encoderProfile('nvenc-hevc').ffmpegCodec).toBe('hevc_nvenc')
  })

  it('says which hardware each name runs on', () => {
    // The rate-control block in `buildFfmpegArguments` keys off the family,
    // not off the name, so a family that drifts silently changes what ffmpeg
    // is told about quality.
    expect(encoderProfile('x264').family).toBe('x264')
    expect(encoderProfile('nvenc-h264').family).toBe('nvenc')
    expect(encoderProfile('nvenc-hevc').family).toBe('nvenc')
  })

  it('offers exactly the three names, and no name maps twice', () => {
    // Two vocabulary entries pointing at one ffmpeg codec would make the
    // choice between them meaningless, which is the shape a copy-paste
    // mistake in the table takes.
    expect([...ENCODERS]).toEqual(['nvenc-h264', 'nvenc-hevc', 'x264'])
    const codecs = ENCODERS.map(
      (encoder) => encoderProfile(encoder).ffmpegCodec,
    )
    expect(new Set(codecs).size).toBe(ENCODERS.length)
    for (const encoder of ENCODERS) {
      expect(encoderProfile(encoder).ffmpegCodec).toBe(EXPECTED[encoder].codec)
      expect(encoderProfile(encoder).family).toBe(EXPECTED[encoder].family)
    }
  })

  it('stays on the CPU by default', () => {
    // Nobody has measured or looked at an NVENC result yet, so the path
    // whose output has been seen is the one that runs by default.
    expect(DEFAULT_ENCODER).toBe('x264')
  })
})

describe('resolveEncoder', () => {
  it('accepts every encoder this stage can drive', () => {
    // Named literally rather than looped over `ENCODERS`: a test that reads
    // its expectations out of the same constant it is checking cannot fail
    // when that constant loses an entry.
    expect(resolveEncoder('x264')).toBe('x264')
    expect(resolveEncoder('nvenc-h264')).toBe('nvenc-h264')
    expect(resolveEncoder('nvenc-hevc')).toBe('nvenc-hevc')
  })

  it('refuses ffmpeg spellings, which are not the vocabulary', () => {
    // The point of owning the names is that `libx264` is not one of them.
    // Accepting it too would restore the two-namespace situation this
    // module removed.
    expect(() => resolveEncoder('libx264')).toThrow(/Unknown encoder/)
    expect(() => resolveEncoder('h264_nvenc')).toThrow(/Unknown encoder/)
  })

  it('names the available encoders when given an unknown one', () => {
    // A typo that silently fell back to the CPU would only be noticed by
    // the encode taking two minutes.
    expect(() => resolveEncoder('nvenc-av1')).toThrow(
      /Unknown encoder "nvenc-av1"\. Available: nvenc-h264, nvenc-hevc, x264/,
    )
  })
})
