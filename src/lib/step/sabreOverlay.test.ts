import { describe, expect, it } from 'vitest'
import { clusterSabre, type SabreFailure, sabreBoundary } from './sabre'

function failure(
  point: [number, number, number],
  normal: [number, number, number],
  tri: SabreFailure['tri'],
): SabreFailure {
  return { point, normal, thickness: Number.POSITIVE_INFINITY, area: 50, tri }
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

describe('clusterSabre', () => {
  it('merges nearby failures facing the same way', () => {
    const failures = [
      failure([0, 0, 0], N, [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
      ]),
      failure([5, 5, 0], N, [
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ]),
    ]
    const clusters = clusterSabre(failures)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].count).toBe(2)
    expect(clusters[0].normal[2]).toBeCloseTo(1)
  })

  it('splits far-apart and opposing failures', () => {
    const tri: SabreFailure['tri'] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ]
    const failures = [
      failure([0, 0, 0], N, tri),
      failure([500, 0, 0], N, tri),
      failure([2, 2, 0], [0, 0, -1], tri),
    ]
    expect(clusterSabre(failures)).toHaveLength(3)
  })
})
