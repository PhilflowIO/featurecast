import { describe, expect, it } from 'vitest'

import { buildTimeMapping, mapTime } from '../../src/render/idle.js'
import type { PointerSample } from '../../src/render/rest.js'

/** A pointer that stands in one place for the whole recording. */
const still = (untilMs: number): PointerSample[] => [
  { timeMs: 0, x: 40, y: 40 },
  { timeMs: untilMs, x: 40, y: 40 },
]

/** A pointer walking at the recorder's cap, 20px per 60Hz sample. */
const walking = (fromMs: number, toMs: number): PointerSample[] => {
  const samples: PointerSample[] = []
  for (let timeMs = fromMs, x = 40; timeMs <= toMs; timeMs += 1000 / 60) {
    samples.push({ timeMs, x, y: 40 })
    x += 20
  }
  return samples
}

describe('idle trimming', () => {
  it('leaves a lively recording completely alone', () => {
    const frames = [0, 16, 33, 50, 66, 83]
    const mapping = buildTimeMapping(frames, 100, [], still(100), [])
    expect(mapping.removedMs).toBe(0)
    expect(mapping.trimmed).toEqual([])
    expect(mapTime(mapping, 50)).toBe(50)
  })

  it('compresses a stretch in which the picture did not change', () => {
    // Two seconds between surviving frames means two seconds in which nothing
    // repainted — the capture already folded byte-identical frames away.
    const frames = [0, 16, 33, 2033, 2050]
    const mapping = buildTimeMapping(frames, 2100, [], still(2100), [], {
      compressToMs: 250,
      thresholdMs: 600,
    })
    expect(mapping.trimmed).toEqual([{ startMs: 33, endMs: 2033, heldMs: 250 }])
    expect(mapping.removedMs).toBe(1750)
    expect(mapping.outputDurationMs).toBe(350)
  })

  it('keeps the mapping strictly increasing, so nothing plays backwards', () => {
    const frames = [0, 20, 1500, 1520, 4000, 4020]
    const mapping = buildTimeMapping(frames, 4100, [], still(4100), [])
    let previous = -1
    for (let sourceMs = 0; sourceMs <= 4100; sourceMs += 7) {
      const outputMs = mapTime(mapping, sourceMs)
      expect(outputMs).toBeGreaterThanOrEqual(previous)
      previous = outputMs
    }
  })

  it('does not cut the pause that lets a click land', () => {
    const frames = [0, 20, 1500, 1520]
    const guarded = buildTimeMapping(frames, 1600, [1200], still(1600), [])
    expect(guarded.trimmed).toEqual([])
    const unguarded = buildTimeMapping(frames, 1600, [], still(1600), [])
    expect(unguarded.trimmed).toHaveLength(1)
  })

  it('bends frames and events with the same map, so they cannot drift apart', () => {
    const frames = [0, 20, 3000, 3020]
    const mapping = buildTimeMapping(frames, 3100, [], still(3100), [])
    // An event logged in the middle of the trimmed stretch and the frame that
    // ends it both land on the same output time scale, in the same order.
    const eventOutput = mapTime(mapping, 1500)
    const frameOutput = mapTime(mapping, 3000)
    expect(eventOutput).toBeLessThan(frameOutput)
    expect(mapTime(mapping, 20)).toBeLessThanOrEqual(eventOutput)
  })

  it('is deterministic', () => {
    const frames = [0, 20, 3000, 3020, 7000]
    expect(buildTimeMapping(frames, 7100, [], still(7100), [])).toEqual(
      buildTimeMapping(frames, 7100, [], still(7100), []),
    )
  })

  it('does not cut a stretch the pointer is crossing', () => {
    // The defect the owner saw, in one unit. The page does not repaint while
    // the pointer travels over it, so the capture leaves a two-second gap
    // between surviving frames and the picture alone calls it stillness. It is
    // not: the pointer covers 2380px in there, and compressing it to 250ms is
    // what turns a walk into a slideshow.
    const frames = [0, 16, 2033, 2050]
    const crossing = buildTimeMapping(frames, 2100, [], walking(16, 2033), [])
    expect(crossing.trimmed).toEqual([])
    expect(crossing.removedMs).toBe(0)

    // Same frames, same gap, pointer parked: trimmed.
    const parked = buildTimeMapping(frames, 2100, [], still(2100), [])
    expect(parked.trimmed).toEqual([{ startMs: 16, endMs: 2033, heldMs: 250 }])
  })

  it('keeps a scripted hold in full and trims only the stillness around it', () => {
    // Issue 139. The picture stands still from 100 to 5100 and the pointer is
    // parked, so without the log this whole gap is idle. The script held from
    // 1000 for 3000ms: that stretch is the author asking for time on screen.
    const frames = [0, 50, 100, 5100, 5150]
    const hold = [{ startMs: 1000, endMs: 4000 }]
    const mapping = buildTimeMapping(frames, 5200, [], still(5200), hold)

    // Before and after the hold: ordinary idle, compressed to the floor.
    expect(mapping.trimmed).toEqual([
      { startMs: 100, endMs: 1000, heldMs: 250 },
      { startMs: 4000, endMs: 5100, heldMs: 250 },
    ])
    // The hold itself plays at recording speed, to the millisecond.
    expect(mapTime(mapping, 4000) - mapTime(mapping, 1000)).toBe(3000)

    // Without the log the same recording loses the reading pause.
    const blind = buildTimeMapping(frames, 5200, [], still(5200), [])
    expect(mapTime(blind, 4000) - mapTime(blind, 1000)).toBeLessThan(250)
  })

  it('keeps a hold that ends the recording', () => {
    // The raven-besprechen shape: an answer lands, the script holds on it,
    // the session ends. No frame follows the hold at all.
    const frames = [0, 50, 100]
    const mapping = buildTimeMapping(frames, 3600, [], still(3600), [
      { startMs: 100, endMs: 3600 },
    ])
    expect(mapping.trimmed).toEqual([])
    expect(mapping.outputDurationMs).toBe(3600)
  })

  it('treats back-to-back holds as one pause', () => {
    const frames = [0, 50, 100, 4100]
    const mapping = buildTimeMapping(frames, 4200, [], still(4200), [
      { startMs: 2100, endMs: 4100 },
      { startMs: 100, endMs: 2100 },
    ])
    expect(mapping.trimmed).toEqual([])
    expect(mapping.removedMs).toBe(0)
  })

  it('does not trim a sliver left between a hold and the next frame', () => {
    // 400ms of stillness after the hold is below the threshold: untouched,
    // exactly as it would be as a gap of its own.
    const frames = [0, 50, 100, 3500]
    const mapping = buildTimeMapping(frames, 3600, [], still(3600), [
      { startMs: 100, endMs: 3100 },
    ])
    expect(mapping.trimmed).toEqual([])
  })

  it('rejects a threshold that would trim everything', () => {
    expect(() =>
      buildTimeMapping([0, 10], 20, [], still(20), [], { thresholdMs: 0 }),
    ).toThrow(/positive threshold/)
  })
})
