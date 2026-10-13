import { describe, expect, it } from 'vitest'
import {
  type NcFaceFrame,
  ncAuthoredStancePoints,
  placeNcFace,
  resolveNcFaceFrame,
} from './ncFaces'
import type { NcGeometry } from './ncGeometry'
import { holeOutline, projectNc } from './ncProject'

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
      notches: [],
    }
    expect(resolveNcFaceFrame(section, nc)).toEqual({ extent: [200, 100], axisVH: 1, axisOU: 0 })
  })
})

describe('channel authored stance', () => {
  // 100 (x, depth) × 50 (y, flange): a channel's canonical `n` outline proportions.
  const section: [number, number][] = [
    [-50, -25],
    [50, -25],
    [50, 25],
    [-50, 25],
  ]
  const nc: NcGeometry = {
    contours: [
      {
        face: 'v',
        kind: 'outer',
        points: [
          [0, 0],
          [10, 100],
        ],
        bevels: [],
      }, // web spans depth (100)
      {
        face: 'o',
        kind: 'outer',
        points: [
          [0, 0],
          [10, 50],
        ],
        bevels: [],
      }, // flange spans 50
    ],
    holes: [],
    notches: [],
  }

  it('maps a channel section into the authored (web-vertical) stance', () => {
    expect(ncAuthoredStancePoints('PFC100*50', [[1, 2]])).toEqual([[-2, 1]])
    expect(ncAuthoredStancePoints('200UB29.8', [[1, 2]])).toEqual([[1, 2]])
  })

  it('reverses both across directions for a channel (flanges and web)', () => {
    const frame = resolveNcFaceFrame(section, nc, 'PFC100*50')
    expect(frame.profile).toBe('PFC100*50')
    // `o` spans axis 1: across 0 lands at the far (reversed) side, +25 rather than −25.
    expect(placeNcFace(frame, 'o', 0, 0, section).cross[1]).toBeCloseTo(25, 6)
    expect(placeNcFace(frame, 'o', 0, 50, section).cross[1]).toBeCloseTo(-25, 6)
    // `v` spans axis 0 (depth) and is reversed too.
    expect(placeNcFace(frame, 'v', 0, 0, section).cross[0]).toBeCloseTo(50, 6)
    expect(placeNcFace(frame, 'v', 0, 100, section).cross[0]).toBeCloseTo(-50, 6)
  })

  it('leaves the authored direction alone without a profile', () => {
    const frame = resolveNcFaceFrame(section, nc)
    expect(frame.profile).toBeUndefined()
    expect(placeNcFace(frame, 'o', 0, 0, section).cross[1]).toBeCloseTo(-25, 6)
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
        // Only segment is beveled at the second vertex (angle-only → default spur). Kept clear of
        // the section edge (across = 50 → interior) so it isn't dropped as stock outline.
        {
          face: 'o',
          kind: 'outer',
          points: [
            [0, 50],
            [10, 50],
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
      notches: [],
    }
    const out = projectNc(nc, { frame, section, toScene, normal })
    // Cut lines are grouped by wall thickness: the `o` face (100 mm) and the `v` hole (200 mm).
    expect(out.cuts.map((cut) => cut.thickness)).toEqual([100, 200])
    // `o` face: the beveled cut segment + two inner cut-out segments = 3 segments.
    expect(out.cuts[0]?.points).toHaveLength(3 * 2 * 3)
    expect(out.cuts[1]?.points).toHaveLength(24 * 2 * 3)
    // The bevel also yields a stemmed arrow (3 segments) and one swept area (a quad = 2 triangles).
    expect(out.bevelArrows).toHaveLength(1)
    expect(out.bevelArrows[0]?.thickness).toBe(100)
    expect(out.bevelArrows[0]?.points).toHaveLength(3 * 2 * 3)
    expect(out.bevelAreas).toHaveLength(1)
    expect(out.bevelAreas[0]?.thickness).toBe(100)
    expect(out.bevelAreas[0]?.triangles).toHaveLength(2 * 3 * 3)
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
      notches: [],
    }
    const out = projectNc(nc, { frame, section: oneSided, toScene, normal })
    expect(out.cuts).toHaveLength(0)
  })
})

describe('holeOutline', () => {
  it('outlines a plain hole as a circle of radius diameter/2', () => {
    const ring = holeOutline({ face: 'o', x: 10, y: 5, diameter: 10 })
    for (const [x, y] of ring) expect(Math.hypot(x - 10, y - 5)).toBeCloseTo(5, 9)
  })

  it('outlines a slotted (`l`) hole as an obround between its two end centres', () => {
    // Start centre (0, 0), far centre (0, 20) → a 10 mm-wide obround spanning y = −5…25.
    const ring = holeOutline({
      face: 'o',
      x: 0,
      y: 0,
      diameter: 10,
      slot: { dx: 0, dy: 20, angle: 0 },
    })
    const xs = ring.map(([x]) => x)
    const ys = ring.map(([, y]) => y)
    expect(Math.min(...xs)).toBeCloseTo(-5, 6)
    expect(Math.max(...xs)).toBeCloseTo(5, 6)
    expect(Math.min(...ys)).toBeCloseTo(-5, 6)
    expect(Math.max(...ys)).toBeCloseTo(25, 6)
    // A circle of the same diameter would top out at y = 5; the slot must reach 25.
    expect(Math.max(...ys)).toBeGreaterThan(20)
  })
})
