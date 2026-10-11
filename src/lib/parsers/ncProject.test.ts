import { describe, expect, it } from 'vitest'
import type { NcGeometry } from './ncGeometry'
import { projectNc, resolveNcFaceAxes } from './ncProject'

describe('resolveNcFaceAxes', () => {
  it('matches each face pair to the section axis its contour spans', () => {
    const section: [number, number][] = [
      [0, 0],
      [200, 0],
      [200, 100],
      [0, 100],
    ]
    const nc: NcGeometry = {
      contours: [
        // web (`v`) spans 100 → section axis 1 (the 100 mm dimension)
        { face: 'v', kind: 'outer', points: [[0, 0], [50, 100]], bevels: [] },
        // flange (`o`) spans 200 → section axis 0
        { face: 'o', kind: 'outer', points: [[0, 0], [50, 200]], bevels: [] },
      ],
      holes: [],
    }
    expect(resolveNcFaceAxes(section, nc)).toEqual({ vh: 1, ou: 0 })
  })
})

describe('projectNc', () => {
  it('splits plain cuts, bevels, inner cut-outs and holes into their own segment lists', () => {
    const nc: NcGeometry = {
      contours: [
        // Only segment is beveled at the second vertex (angle-only → default spur).
        { face: 'o', kind: 'outer', points: [[0, 0], [10, 0]], bevels: [[0, 0, 0, 0], [45, 0, 0, 0]] },
        // Inner cut-out: three points → two plain segments.
        {
          face: 'o',
          kind: 'inner',
          points: [[0, 0], [5, 5], [0, 5]],
          bevels: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        },
      ],
      holes: [{ face: 'v', x: 5, y: 5, diameter: 10 }],
    }
    const out = projectNc(nc, { place: (_face, x, y) => [x, y, 0], normal: () => [0, 0, 1] })
    expect(out.outer).toHaveLength(0)
    // One beveled segment + one spur from the beveled vertex.
    expect(out.bevel).toHaveLength(2 * 2 * 3)
    expect(out.inner).toHaveLength(2 * 2 * 3)
    expect(out.holes).toHaveLength(24 * 2 * 3)
  })
})
