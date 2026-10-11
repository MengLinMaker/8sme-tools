import { describe, expect, it } from 'vitest'
import { type SabreFailure, sabreBoundary, sabreRegions } from './sabre'

function failure(
  point: [number, number, number],
  normal: [number, number, number],
  tri: SabreFailure['tri'],
): SabreFailure {
  return {
    point,
    normal,
    thickness: Number.POSITIVE_INFINITY,
    area: 50,
    tri,
    entry: point,
    exit: point,
  }
}

const N: [number, number, number] = [0, 0, 1]

describe('sabreBoundary', () => {
  it('draws a lone triangle as its 3 edges', () => {
    const failures = [
      failure([0, 0, 0], N, [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
      ]),
    ]
    expect(sabreBoundary(failures)).toHaveLength(3)
  })

  it('drops the shared diagonal of two adjacent triangles', () => {
    // Quad (0,0)-(10,0)-(10,10)-(0,10) split along the (10,0)-(0,10) diagonal.
    const failures = [
      failure([5, 2, 0], N, [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
      ]),
      failure([5, 8, 0], N, [
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ]),
    ]
    const boundary = sabreBoundary(failures)
    // Quad perimeter: 4 edges; the internal diagonal is gone.
    expect(boundary).toHaveLength(4)
  })
})

describe('sabreRegions', () => {
  const withBore = (
    tri: SabreFailure['tri'],
    entry: [number, number, number],
    exit: [number, number, number],
    area: number,
    thickness: number,
  ): SabreFailure => ({
    point: entry,
    normal: N,
    thickness,
    area,
    tri,
    entry,
    exit,
  })

  it('merges triangles that share a vertex into one localized region', () => {
    const regions = sabreRegions([
      withBore(
        [
          [0, 0, 0],
          [10, 0, 0],
          [0, 10, 0],
        ],
        [3, 3, 0],
        [3, 3, -85],
        100,
        85,
      ),
      withBore(
        [
          [10, 0, 0],
          [10, 10, 0],
          [0, 10, 0],
        ],
        [7, 7, 0],
        [7, 7, -60],
        50,
        60,
      ),
    ])
    expect(regions).toHaveLength(1)
    expect(regions[0].triangles).toBe(2)
    expect(regions[0].area).toBe(150)
    expect(regions[0].depth).toBe(85)
    expect(regions[0].bores).toHaveLength(2)
  })

  it('keeps disjoint patches (mirror flanges) as separate regions', () => {
    const regions = sabreRegions([
      withBore(
        [
          [0, -50, 0],
          [10, -50, 0],
          [0, -40, 0],
        ],
        [3, -48, 0],
        [3, -48, -85],
        100,
        85,
      ),
      withBore(
        [
          [0, 50, 0],
          [10, 50, 0],
          [0, 40, 0],
        ],
        [3, 48, 0],
        [3, 48, -85],
        100,
        85,
      ),
    ])
    expect(regions).toHaveLength(2)
    expect(regions.every((r) => r.triangles === 1)).toBe(true)
  })
})
