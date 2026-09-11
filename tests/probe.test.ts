import { describe, expect, it, vi } from 'vitest'

import {
  buildFfprobeArguments,
  probeOutput,
  validateOutputProbe,
} from '../src/probe.js'

describe('validateOutputProbe', () => {
  it('validates a 1920x1080 constant-60fps output matching the capture span', () => {
    expect(() =>
      validateOutputProbe(
        {
          streams: [
            {
              avg_frame_rate: '60/1',
              duration: '20.000000',
              height: 1080,
              nb_frames: '1200',
              r_frame_rate: '60/1',
              width: 1920,
            },
          ],
        },
        20,
      ),
    ).not.toThrow()
  })

  it('rejects a positive frame count that is not actually 20 seconds', () => {
    // The regression this guards: the old gate accepted an 83ms clip because
    // it only checked `nb_frames > 0`.
    expect(() =>
      validateOutputProbe(
        {
          streams: [
            {
              avg_frame_rate: '60/1',
              duration: '0.083000',
              height: 1080,
              nb_frames: '5',
              r_frame_rate: '60/1',
              width: 1920,
            },
          ],
        },
        20,
      ),
    ).toThrow('does not match the 20s capture span')
  })

  it('rejects a frame count inconsistent with a constant 60fps encode of the reported duration', () => {
    expect(() =>
      validateOutputProbe(
        {
          streams: [
            {
              avg_frame_rate: '60/1',
              duration: '20.000000',
              height: 1080,
              nb_frames: '600',
              r_frame_rate: '60/1',
              width: 1920,
            },
          ],
        },
        20,
      ),
    ).toThrow('does not match the 1200 frames expected')
  })

  it('rejects a missing duration field', () => {
    expect(() =>
      validateOutputProbe(
        {
          streams: [
            {
              avg_frame_rate: '60/1',
              height: 1080,
              nb_frames: '1200',
              r_frame_rate: '60/1',
              width: 1920,
            },
          ],
        },
        20,
      ),
    ).toThrow('must report a stream duration')
  })

  it('rejects a non-positive frame count', () => {
    expect(() =>
      validateOutputProbe(
        {
          streams: [
            {
              avg_frame_rate: '60/1',
              duration: '0.000000',
              height: 1080,
              nb_frames: '0',
              r_frame_rate: '60/1',
              width: 1920,
            },
          ],
        },
        0,
      ),
    ).toThrow('positive frame count')
  })
})

describe('buildFfprobeArguments', () => {
  it('builds a machine-readable ffprobe command that includes duration', () => {
    expect(buildFfprobeArguments('/tmp/output.mp4')).toEqual([
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration',
      '-of',
      'json',
      '/tmp/output.mp4',
    ])
  })
})

describe('probeOutput', () => {
  it('runs ffprobe, parses its JSON, and validates the assembled output', async () => {
    const runner = vi.fn().mockResolvedValue(
      JSON.stringify({
        streams: [
          {
            avg_frame_rate: '60/1',
            duration: '20.000000',
            height: 1080,
            nb_frames: '1200',
            r_frame_rate: '60/1',
            width: 1920,
          },
        ],
      }),
    )

    await probeOutput('/tmp/output.mp4', 20, runner)

    expect(runner).toHaveBeenCalledWith(
      'ffprobe',
      buildFfprobeArguments('/tmp/output.mp4'),
    )
  })

  it('rejects ffprobe output that is not valid JSON', async () => {
    const runner = vi.fn().mockResolvedValue('not json')

    await expect(probeOutput('/tmp/output.mp4', 20, runner)).rejects.toThrow(
      'ffprobe must emit valid JSON',
    )
  })
})
