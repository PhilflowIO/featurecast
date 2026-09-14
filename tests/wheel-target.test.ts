import { describe, expect, it, vi } from 'vitest'

import type { BoxRect, WheelPoint } from '../src/wheel-target.js'

import {
  chooseWheelPoint,
  firstClearPoint,
  visibleRect,
  wheelCandidatePoints,
} from '../src/wheel-target.js'

/**
 * The real geometry from the #47 measurement: OnlyDash's page scroll
 * container at the 2560x1600 capture viewport, with the grid's own
 * `MuiDataGrid-virtualScroller` (2px of range, enough to capture a wheel and
 * not enough to travel with it) covering everything but the container's
 * outer margin.
 */
const CONTAINER: BoxRect = { height: 800, width: 2000, x: 0, y: 0 }
const VIEWPORT = { height: 1600, width: 2560 }
const INNER_SCROLLER = { bottom: 760, left: 40, right: 1960, top: 40 }

function centerOf(box: BoxRect): WheelPoint {
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  }
}

function probeAvoiding(blocked: {
  bottom: number
  left: number
  right: number
  top: number
}) {
  return vi.fn(async (points: readonly WheelPoint[]) =>
    points.map(
      (point) =>
        !(
          point.x >= blocked.left &&
          point.x <= blocked.right &&
          point.y >= blocked.top &&
          point.y <= blocked.bottom
        ),
    ),
  )
}

describe('visibleRect', () => {
  it('clips a container that extends past the bottom of the viewport', () => {
    const rect = visibleRect(
      { height: 3000, width: 2000, x: 0, y: 200 },
      { height: 1000, width: 2560 },
    )

    expect(rect).toEqual({ bottom: 1000, left: 0, right: 2000, top: 200 })
  })

  it('reports no visible area for a container entirely off screen', () => {
    expect(
      visibleRect(
        { height: 400, width: 400, x: 0, y: 2000 },
        { height: 1000, width: 2560 },
      ),
    ).toBeNull()
  })

  it('uses the box itself when the viewport size is unknown', () => {
    expect(visibleRect({ height: 800, width: 2000, x: 0, y: 0 }, null)).toEqual(
      {
        bottom: 800,
        left: 0,
        right: 2000,
        top: 0,
      },
    )
  })
})

describe('wheelCandidatePoints', () => {
  it('offers several candidates and keeps every one inside the visible area', () => {
    const points = wheelCandidatePoints(CONTAINER, VIEWPORT)

    expect(points.length).toBeGreaterThan(8)
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(2000)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(800)
    }
  })

  it('tries the border before the middle and the center dead last', () => {
    const points = wheelCandidatePoints(CONTAINER, VIEWPORT)
    const center = centerOf(CONTAINER)

    expect(points[0]).toEqual({ x: 4, y: 4 })
    expect(points.at(-1)).toEqual(center)
    // Reachability: the center really is among the candidates, so "last"
    // is a statement about the order, not about it being filtered out.
    expect(points).toContainEqual(center)
  })

  it('never proposes a point outside the viewport for a clipped container', () => {
    const points = wheelCandidatePoints(
      { height: 3000, width: 2000, x: 0, y: 0 },
      { height: 1000, width: 2560 },
    )

    expect(points.length).toBeGreaterThan(0)
    for (const point of points) {
      expect(point.y).toBeLessThanOrEqual(1000)
    }
  })

  it('rounds every candidate to a whole pixel', () => {
    const points = wheelCandidatePoints(
      { height: 799.7, width: 1999.3, x: 0.4, y: 0.6 },
      VIEWPORT,
    )

    expect(points.length).toBeGreaterThan(0)
    for (const point of points) {
      expect(Number.isInteger(point.x)).toBe(true)
      expect(Number.isInteger(point.y)).toBe(true)
    }
    // Reachability: this geometry really does produce fractional
    // coordinates before rounding (the first candidate sits at x = 4.4).
    expect(points[0]).toEqual({ x: 4, y: 5 })
  })

  it('returns the same ordered list every time for the same geometry', () => {
    expect(wheelCandidatePoints(CONTAINER, VIEWPORT)).toEqual(
      wheelCandidatePoints(CONTAINER, VIEWPORT),
    )
  })

  it('collapses to a single usable point for a sliver of a container', () => {
    const points = wheelCandidatePoints(
      { height: 2, width: 2, x: 10, y: 10 },
      VIEWPORT,
    )

    expect(points).toEqual([{ x: 11, y: 11 }])
  })

  it('has nothing to offer when the container is off screen', () => {
    expect(
      wheelCandidatePoints(
        { height: 400, width: 400, x: 0, y: 2000 },
        VIEWPORT,
      ),
    ).toEqual([])
  })
})

describe('firstClearPoint', () => {
  it('takes the earliest candidate the probe cleared', () => {
    const points = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]

    expect(firstClearPoint(points, [false, true, true])).toEqual({ x: 2, y: 2 })
  })

  it('reports nothing when the probe cleared nothing', () => {
    expect(firstClearPoint([{ x: 1, y: 1 }], [false])).toBeNull()
  })
})

describe('chooseWheelPoint', () => {
  it('picks a point outside the nested scroller, not the container center', async () => {
    const probe = probeAvoiding(INNER_SCROLLER)

    const point = await chooseWheelPoint(CONTAINER, VIEWPORT, probe, {
      axis: 'y',
      description: 'main.flex-1',
    })

    expect(point).not.toEqual(centerOf(CONTAINER))
    expect(
      point.x < INNER_SCROLLER.left ||
        point.x > INNER_SCROLLER.right ||
        point.y < INNER_SCROLLER.top ||
        point.y > INNER_SCROLLER.bottom,
    ).toBe(true)
    // Reachability: the center is a candidate this probe would have
    // rejected, so the assertion above discriminates.
    const candidates = wheelCandidatePoints(CONTAINER, VIEWPORT)
    expect(candidates).toContainEqual(centerOf(CONTAINER))
    const verdicts = await probe(candidates)
    expect(verdicts.at(-1)).toBe(false)
  })

  it('hit-tests every candidate in one batch, not one call per point', async () => {
    const probe = probeAvoiding(INNER_SCROLLER)

    await chooseWheelPoint(CONTAINER, VIEWPORT, probe, {
      axis: 'y',
      description: 'main.flex-1',
    })

    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0]?.[0]).toEqual(
      wheelCandidatePoints(CONTAINER, VIEWPORT),
    )
  })

  it('finds a free band pinched between the border and the center', async () => {
    // Neither the outer ring (a sticky header/footer overlay of the inner
    // scroller) nor the center is usable here; only the ring in between is.
    // A three-point-per-axis search has no such ring and would give up.
    const center = centerOf(CONTAINER)
    const probe = vi.fn(async (points: readonly WheelPoint[]) =>
      points.map(
        (point) =>
          point.x > 200 &&
          point.x < 1800 &&
          point.y > 100 &&
          point.y < 700 &&
          !(point.x === center.x && point.y === center.y),
      ),
    )

    const point = await chooseWheelPoint(CONTAINER, VIEWPORT, probe, {
      axis: 'y',
      description: 'main.flex-1',
    })

    expect(point).not.toEqual(center)
    expect(point.x).toBeGreaterThan(200)
    expect(point.x).toBeLessThan(1800)
    expect(point.y).toBeGreaterThan(100)
    expect(point.y).toBeLessThan(700)
    // Reachability: the outer ring really was offered and really was
    // rejected, so this is a band found, not a border point renamed.
    const candidates = wheelCandidatePoints(CONTAINER, VIEWPORT)
    const verdicts = await probe(candidates)
    expect(verdicts[0]).toBe(false)
  })

  it('takes the center when the probe says the center is genuinely free', async () => {
    const probe = vi.fn(async (points: readonly WheelPoint[]) =>
      points.map((point) => point.y === centerOf(CONTAINER).y),
    )

    const point = await chooseWheelPoint(CONTAINER, VIEWPORT, probe, {
      axis: 'y',
      description: 'main.flex-1',
    })

    expect(point.y).toBe(centerOf(CONTAINER).y)
  })

  it('fails loudly instead of falling back when no candidate is free', async () => {
    const probe = vi.fn(async (points: readonly WheelPoint[]) =>
      points.map(() => false),
    )

    await expect(
      chooseWheelPoint(CONTAINER, VIEWPORT, probe, {
        axis: 'y',
        description: 'main.flex-1',
      }),
    ).rejects.toThrow(/covered by another scrollable element/)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('fails when the container has no visible area at all', async () => {
    const probe = vi.fn(async (points: readonly WheelPoint[]) =>
      points.map(() => true),
    )

    await expect(
      chooseWheelPoint(
        { height: 400, width: 400, x: 0, y: 2000 },
        VIEWPORT,
        probe,
        { axis: 'y', description: 'main.flex-1' },
      ),
    ).rejects.toThrow(/no visible area/)
    expect(probe).not.toHaveBeenCalled()
  })
})
