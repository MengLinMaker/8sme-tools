import { describe, expect, it } from 'vitest'
import { erodePolygon } from './reconstructFromNc'

const fmt = (pts: [number, number][] | null) =>
  pts?.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')

describe('erodePolygon', () => {
  it('insets a square by the distance on all sides', () => {
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    expect(fmt(erodePolygon(square, 1))).toBe('1.00,1.00 9.00,1.00 9.00,9.00 1.00,9.00')
  })

  it('is winding-agnostic', () => {
    const ccw: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const cw = [...ccw].reverse()
    // Same vertex set (winding only changes which vertex comes first).
    const asSet = (pts: [number, number][] | null) => fmt(pts)?.split(' ').sort().join(' ')
    expect(asSet(erodePolygon(cw, 1))).toBe(asSet(erodePolygon(ccw, 1)))
  })

  it('handles a concave outline wider than twice the distance', () => {
    // U notch 4 wide, erode 1: notch narrows to 2, outline stays valid.
    const u: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [7, 10],
      [7, 4],
      [3, 4],
      [3, 10],
      [0, 10],
    ]
    const out = erodePolygon(u, 1)
    expect(out).not.toBeNull()
    expect(out).toHaveLength(8)
  })

  it('widens a concave void instead of refusing it', () => {
    // A 1-wide notch is void, not solid: eroding the solid widens the notch.
    const u: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [5.5, 10],
      [5.5, 4],
      [4.5, 4],
      [4.5, 10],
      [0, 10],
    ]
    const out = erodePolygon(u, 1)
    expect(out).not.toBeNull()
    expect(out).toHaveLength(8)
  })

  it('refuses a solid protrusion narrower than twice the distance', () => {
    // A 1-wide tower eroded by 1 inverts (its walls cross): the offset is meaningless.
    const tower: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 3],
      [5.5, 3],
      [5.5, 10],
      [4.5, 10],
      [4.5, 3],
      [0, 3],
    ]
    expect(erodePolygon(tower, 1)).toBeNull()
  })

  it('refuses degenerate loops', () => {
    expect(
      erodePolygon(
        [
          [0, 0],
          [1, 1],
        ],
        0.5,
      ),
    ).toBeNull()
    expect(
      erodePolygon(
        [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
        0.5,
      ),
    ).toBeNull()
    expect(
      erodePolygon(
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        0,
      ),
    ).toBeNull()
  })
})
