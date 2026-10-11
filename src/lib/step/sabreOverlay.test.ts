import { describe, expect, it } from 'vitest'
import { type SabreFailure, sabreBoundary } from './sabre'

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
