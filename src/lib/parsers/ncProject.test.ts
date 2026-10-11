import { describe, expect, it } from 'vitest'
import { type NcFaceFrame, resolveNcFaceFrame } from './ncFaces'
import type { NcGeometry } from './ncGeometry'
import { projectNc } from './ncProject'

describe('resolveNcFaceFrame', () => {
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
        {
          face: 'v',
          kind: 'outer',
          points: [
            [0, 0],
            [50, 100],
          ],
          bevels: [],
        },
        // flange (`o`) spans 200 → section axis 0
        {
          face: 'o',
          kind: 'outer',
          points: [
            [0, 0],
            [50, 200],
          ],
          bevels: [],
        },
      ],
      holes: [],
    }
    expect(resolveNcFaceFrame(section, nc)).toEqual({ extent: [200, 100], axisVH: 1, axisOU: 0 })
  })
})

describe('projectNc', () => {
  // 200 (x) × 100 (y) solid section, centred on the origin.
  const section: [number, number][] = [
    [-100, -50],
    [100, -50],
    [100, 50],
    [-100, 50],
  ]
  const frame: NcFaceFrame = { extent: [200, 100], axisVH: 1, axisOU: 0 }
  const toScene = (along: number, cross: [number, number]): [number, number, number] => [
    along,
    cross[0],
    cross[1],
  ]
  const normal = (): [number, number, number] => [0, 1, 0]

  it('splits plain cuts, bevels, inner cut-outs and holes into their own lists', () => {
    const nc: NcGeometry = {
      contours: [
        // Only segment is beveled at the second vertex (angle-only → default spur).
        {
          face: 'o',
          kind: 'outer',
          points: [
            [0, 0],
            [10, 0],
          ],
          bevels: [
            [0, 0, 0, 0],
            [45, 0, 0, 0],
          ],
        },
        // Inner cut-out: three points → two plain segments.
        {
          face: 'o',
          kind: 'inner',
          points: [
            [0, 0],
            [5, 5],
            [0, 5],
          ],
          bevels: [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ],
        },
      ],
      holes: [{ face: 'v', x: 5, y: 5, diameter: 10 }],
    }
    const out = projectNc(nc, { frame, section, toScene, normal })
    expect(out.outer).toHaveLength(0)
    // One beveled segment + one spur from the beveled vertex.
    expect(out.bevel).toHaveLength(2 * 2 * 3)
    expect(out.inner).toHaveLength(2 * 2 * 3)
    expect(out.holes).toHaveLength(24 * 2 * 3)
  })

  it('drops a cut that has no material on its face', () => {
    // An L-ish section: material only on the +y side (like a T stem), so an `o`-face cut
    // hanging in the void is not a cut.
    const oneSided: [number, number][] = [
      [-100, 0],
      [100, 0],
      [100, 50],
      [-100, 50],
    ]
    const nc: NcGeometry = {
      contours: [
        {
          face: 'o',
          kind: 'outer',
          points: [
            [0, 0],
            [10, 0],
          ],
          bevels: [],
        },
      ],
      holes: [],
    }
    const out = projectNc(nc, { frame, section: oneSided, toScene, normal })
    expect(out.outer).toHaveLength(0)
    expect(out.bevel).toHaveLength(0)
  })
})
