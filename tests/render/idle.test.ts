import { describe, expect, it } from 'vitest'

import { buildTimeMapping, mapTime } from '../../src/render/idle.js'

describe('idle trimming', () => {
  it('leaves a lively recording completely alone', () => {
    const frames = [0, 16, 33, 50, 66, 83]
    const mapping = buildTimeMapping(frames, 100)
    expect(mapping.removedMs).toBe(0)
    expect(mapping.trimmed).toEqual([])
    expect(mapTime(mapping, 50)).toBe(50)
  })

  it('compresses a stretch in which the picture did not change', () => {
    // Two seconds between surviving frames means two seconds in which nothing
    // repainted — the capture already folded byte-identical frames away.
    const frames = [0, 16, 33, 2033, 2050]
    const mapping = buildTimeMapping(frames, 2100, [], {
      compressToMs: 250,
      thresholdMs: 600,
    })
    expect(mapping.trimmed).toEqual([{ startMs: 33, endMs: 2033 }])
    expect(mapping.removedMs).toBe(1750)
    expect(mapping.outputDurationMs).toBe(350)
  })

  it('keeps the mapping strictly increasing, so nothing plays backwards', () => {
    const frames = [0, 20, 1500, 1520, 4000, 4020]
    const mapping = buildTimeMapping(frames, 4100)
    let previous = -1
    for (let sourceMs = 0; sourceMs <= 4100; sourceMs += 7) {
      const outputMs = mapTime(mapping, sourceMs)
      expect(outputMs).toBeGreaterThanOrEqual(previous)
      previous = outputMs
    }
  })

  it('does not cut the pause that lets a click land', () => {
    const frames = [0, 20, 1500, 1520]
    const guarded = buildTimeMapping(frames, 1600, [1200])
    expect(guarded.trimmed).toEqual([])
    const unguarded = buildTimeMapping(frames, 1600, [])
    expect(unguarded.trimmed).toHaveLength(1)
  })

  it('bends frames and events with the same map, so they cannot drift apart', () => {
    const frames = [0, 20, 3000, 3020]
    const mapping = buildTimeMapping(frames, 3100)
    // An event logged in the middle of the trimmed stretch and the frame that
    // ends it both land on the same output time scale, in the same order.
    const eventOutput = mapTime(mapping, 1500)
    const frameOutput = mapTime(mapping, 3000)
    expect(eventOutput).toBeLessThan(frameOutput)
    expect(mapTime(mapping, 20)).toBeLessThanOrEqual(eventOutput)
  })

  it('is deterministic', () => {
    const frames = [0, 20, 3000, 3020, 7000]
    expect(buildTimeMapping(frames, 7100)).toEqual(
      buildTimeMapping(frames, 7100),
    )
  })

  it('rejects a threshold that would trim everything', () => {
    expect(() => buildTimeMapping([0, 10], 20, [], { thresholdMs: 0 })).toThrow(
      /positive threshold/,
    )
  })
})
