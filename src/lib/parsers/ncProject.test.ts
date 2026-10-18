import { existsSync, readFileSync } from 'node:fs'
import { nw30Bottom, nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { partSectionForCode } from '@/lib/sections/stock'
import { parseDstv } from './dstv'
import {
  faceNormal,
  type NcFaceFrame,
  ncAuthoredStancePoints,
  placeNcFace,
  resolveNcFaceFrame,
} from './ncFaces'
import type { NcFace, NcGeometry } from './ncGeometry'
import { parseNcGeometry } from './ncGeometry'
import { cutThicknesses, faceThickness, holeOutline, projectNc, type Vec3 } from './ncProject'
import { MAX_BEVEL_DEG } from './weldingPrep'

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

  it('maps a channel / I-section into the authored (web-vertical) stance', () => {
    // Channel canonical `n` is a 90° CW rotation of the authored pose.
    expect(ncAuthoredStancePoints('PFC100*50', [[1, 2]])).toEqual([[-2, 1]])
    // I canonical `H` is a 90° CCW rotation, so the inverse is CW.
    expect(ncAuthoredStancePoints('200UB29.8', [[1, 2]])).toEqual([[2, -1]])
    // Everything else shares the authored stance.
    expect(ncAuthoredStancePoints('RHS100*50*3.0', [[1, 2]])).toEqual([[1, 2]])
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

describe('tube canonical stance (RHS150*100*9.0)', () => {
  it('seats the long side horizontal and the DSTV faces on the right sides', () => {
    const text = readFileSync(nw31Top('NC files', 'm150.nc1'), 'utf8')
    const header = parseDstv(text).header
    const geo = parseNcGeometry(text)
    const section = partSectionForCode(header.profile, header.dimensions)?.points
    expect(section).toBeTruthy()
    if (!section) return
    // Tekla authors the tube long-side-vertical; our stance is long-side-horizontal.
    const frame = resolveNcFaceFrame(section, geo, header.profile)
    expect(frame.extent[0]).toBeCloseTo(150, 6)
    expect(frame.extent[1]).toBeCloseTo(100, 6)
    // `v`/`h` (the long faces) span the 150 side; `o`/`u` (short) the 100.
    expect(frame.axisVH).toBe(0)
    expect(frame.axisOU).toBe(1)
    // `o` is the short right face: across 0 → +y, on the +x side.
    const o = placeNcFace(frame, 'o', 0, 0, section)
    expect(o.cross[0]).toBeCloseTo(75, 6)
    expect(o.cross[1]).toBeCloseTo(50, 6)
    // `v` is the long bottom face, on the −y side, reading back the other way.
    const v = placeNcFace(frame, 'v', 0, 0, section)
    expect(v.cross[0]).toBeCloseTo(-75, 6)
    expect(v.cross[1]).toBeCloseTo(-50, 6)
    // `h` (long top face) mirrors `v` across the member.
    const h = placeNcFace(frame, 'h', 0, 0, section)
    expect(h.cross[0]).toBeCloseTo(-75, 6)
    expect(h.cross[1]).toBeCloseTo(50, 6)
    // `u` (short left face) mirrors `o`.
    const u = placeNcFace(frame, 'u', 0, 0, section)
    expect(u.cross[0]).toBeCloseTo(-75, 6)
    expect(u.cross[1]).toBeCloseTo(50, 6)
  })
})

describe('faceThickness', () => {
  const empty: NcGeometry = { contours: [], holes: [], notches: [] }
  const section = partSectionForCode('EA75*75*6', [75, 75, 6, 6, 8])?.points ?? []

  it('takes an angle leg thickness from the section code', () => {
    const frame = resolveNcFaceFrame(section, empty, 'EA75*75*6')
    // The toe radius leaves vertices/chords ~1 mm inside the leg face; the callout names the 6 mm leg.
    expect(faceThickness(frame, section, 'u')).toBe(6)
    expect(faceThickness(frame, section, 'h')).toBe(6)
  })

  it('falls back to the leg geometry when the code omits the thickness', () => {
    const frame = resolveNcFaceFrame(section, empty, 'EA75')
    expect(faceThickness(frame, section, 'u')).toBeCloseTo(6, 6)
  })

  it('reports the real leg thickness in an angle NC legend', () => {
    const text = readFileSync(nw30Bottom('a2.nc1'), 'utf8')
    const header = parseDstv(text).header
    const geo = parseNcGeometry(text)
    const points = partSectionForCode(header.profile, header.dimensions)?.points
    expect(points).toBeTruthy()
    if (!points) return
    const frame = resolveNcFaceFrame(points, geo, header.profile)
    expect(cutThicknesses(frame, points, geo)).toEqual([6])
  })

  it('takes a hollow wall thickness from the section code', () => {
    // The outer outline alone can't reveal a hollow's wall — the callout names it.
    const rhs = partSectionForCode('RHS150*100*9.0', [150, 100, 9, 9, 22.5])?.points ?? []
    expect(faceThickness(resolveNcFaceFrame(rhs, empty, 'RHS150*100*9.0'), rhs, 'h')).toBe(9)
    const shs = partSectionForCode('SHS100*100*6.0', [100, 100, 6, 6, 15])?.points ?? []
    expect(faceThickness(resolveNcFaceFrame(shs, empty, 'SHS100*100*6.0'), shs, 'o')).toBe(6)
  })

  it('reports hollow walls in the NC legend', () => {
    for (const [path, wall] of [
      [nw31Top('NC files', 'm117.nc1'), 9], // RHS150*100*9.0
      [nw30Bottom('m105.nc1'), 6], // SHS100*100*6.0
    ] as [string, number][]) {
      const text = readFileSync(path, 'utf8')
      const header = parseDstv(text).header
      const geo = parseNcGeometry(text)
      const points = partSectionForCode(header.profile, header.dimensions)?.points
      expect(points).toBeTruthy()
      if (!points) continue
      const frame = resolveNcFaceFrame(points, geo, header.profile)
      expect(cutThicknesses(frame, points, geo)).toEqual([wall])
    }
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

describe('projectNc welding prep on real RHS parts', () => {
  // `m119`/`m159` carry a two-sided prep on their long (`v`/`h`) faces — a real 45° chamfer plus a
  // steep back-side couple (79.4°) the head can't cut. `m24` is a plain 20° mitre.
  const marks = ['m119', 'm159', 'm24']
  for (const mark of marks) {
    const path = nw31Top('NC files', `${mark}.nc1`)
    it.skipIf(!existsSync(path))(`${mark} never sweeps a bevel fin past the head's range`, () => {
      const text = readFileSync(path, 'utf8')
      const header = parseDstv(text).header
      const geo = parseNcGeometry(text)
      const section = partSectionForCode(header.profile, header.dimensions)?.points
      expect(section).toBeTruthy()
      if (!section) return
      const frame = resolveNcFaceFrame(section, geo, header.profile)
      // Seat the member along world X; cross-section x→world Y, y→world Z.
      const toScene = (along: number, cross: [number, number]): Vec3 => [along, cross[0], cross[1]]
      const normal = (face: NcFace): Vec3 => {
        const n = faceNormal(frame, face, section)
        return n.axis === 0 ? [0, n.sign, 0] : [0, 0, n.sign]
      }
      const out = projectNc(geo, { frame, section, toScene, normal })
      const finTilts: number[] = []
      for (const area of out.bevelAreas) {
        const t = area.triangles
        for (let i = 0; i + 8 < t.length; i += 9) {
          // Triangle vertices: a, b, b+reach (the second begins a, b+reach, a+reach).
          const reach = [t[i + 6] - t[i + 3], t[i + 7] - t[i + 4], t[i + 8] - t[i + 5]]
          const len = Math.hypot(reach[0] as number, reach[1] as number, reach[2] as number) || 1
          // The fin's along-member component is sin(bevel); a past-range bevel tilts it near-flat.
          finTilts.push(Math.abs((reach[0] as number) / len))
        }
      }
      expect(finTilts.length).toBeGreaterThan(0)
      const maxTilt = Math.max(...finTilts)
      expect(maxTilt).toBeLessThanOrEqual(Math.sin((MAX_BEVEL_DEG * Math.PI) / 180) + 1e-3)
    })
  }
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

  it('rotates a tilted (`l`) slot by its DSTV angle, not straight along `dy`', () => {
    // Real NW31 a1 slot: `0.00l 0.00 10.00 69.95` at (0, 0). The far end is (dx, dy) = (0, 10)
    // rotated 69.95° CCW → (−9.394, 3.428), so the obround leans ~20° off vertical.
    const ring = holeOutline({
      face: 'v',
      x: 0,
      y: 0,
      diameter: 10,
      slot: { dx: 0, dy: 10, angle: 69.95 },
    })
    const xs = ring.map(([x]) => x)
    const ys = ring.map(([, y]) => y)
    // If the angle were ignored the slot would be vertical: x ∈ [−5, 5], y ∈ [−5, 15].
    expect(Math.min(...xs)).toBeCloseTo(-9.394 - 5, 1)
    expect(Math.max(...xs)).toBeCloseTo(5, 1)
    expect(Math.min(...ys)).toBeCloseTo(-5, 1)
    expect(Math.max(...ys)).toBeCloseTo(3.428 + 5, 1)
    // A vertical slot would never reach x = −8; the tilt does.
    expect(Math.min(...xs)).toBeLessThan(-8)
  })
})

describe('I-section web face plane', () => {
  // Canonical H stance for a 200UB29.8: depth 207 along the section x, flange width 134 along y,
  // web thickness 6.3. The web's `v`/`h` faces are interior — their plane is the web half-thickness,
  // not the flange-width edge.
  const section = partSectionForCode('200UB29.8', [207, 134, 9.6, 6.3])?.points ?? []
  const nc: NcGeometry = {
    contours: [
      {
        face: 'v',
        kind: 'outer',
        points: [
          [0, 0],
          [10, 207],
          [0, 207],
        ],
        bevels: [],
      },
      {
        face: 'o',
        kind: 'outer',
        points: [
          [0, 0],
          [10, 134],
          [0, 134],
        ],
        bevels: [],
      },
    ],
    holes: [],
    notches: [],
  }

  it('places v/h cuts on the web surface, not the width edge', () => {
    const frame = resolveNcFaceFrame(section, nc, '200UB29.8')
    expect(frame.webHalf).toBeCloseTo(6.3 / 2, 1)
    // `v` spans the depth (axis 0); its normal is the width (axis 1). A cut sits at ±webHalf.
    const v = placeNcFace(frame, 'v', 0, 100, section).cross
    expect(Math.abs(v[1] as number)).toBeCloseTo(6.3 / 2, 1)
    expect(Math.abs(v[0] as number)).toBeCloseTo(207 / 2 - 100, 1)
    // `o`/`u` remain on the flange outer faces (depth extremes).
    const o = placeNcFace(frame, 'o', 0, 0, section).cross
    expect(Math.abs(o[0] as number)).toBeCloseTo(207 / 2, 1)
    expect(Math.abs(o[1] as number)).toBeCloseTo(134 / 2, 1)
  })

  it('reports the web wall (tw) for v/h, not the flange width', () => {
    const frame = resolveNcFaceFrame(section, nc, '200UB29.8')
    // 200UB29.8: tf 9.6, tw 6.3. The web faces must measure ~6.3 mm, not ~67 mm.
    expect(faceThickness(frame, section, 'v')).toBeCloseTo(6.3, 1)
    expect(faceThickness(frame, section, 'h')).toBeCloseTo(6.3, 1)
    expect(faceThickness(frame, section, 'o')).toBeCloseTo(9.6, 1)
    expect(faceThickness(frame, section, 'u')).toBeCloseTo(9.6, 1)
  })
})
