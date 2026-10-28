import { describe, expect, it } from 'vitest'
import { CUT_FACES, faceNormalSigns, faceRole } from '@/lib/sections/canonical'
import { partSectionForCode } from '@/lib/sections/stock'
import {
  brepCutSegments,
  classifyEdgeSegments,
  cutEdgeThicknessAt,
  edgeCutSegments,
  type SeatedBrepFace,
  splitCutEdges,
  stockFaceThicknesses,
  type Vec3,
} from './cutEdges'

/** A 100 × 50 solid rectangular stock section, centred on the origin. */
const SECTION: [number, number][] = [
  [-50, -25],
  [50, -25],
  [50, 25],
  [-50, 25],
]

/** Canonical `H` I-section: depth 100 on x, width 50 on y, flanges 10, web 6. */
const I_SECTION: [number, number][] = [
  [-50, 25],
  [-40, 25],
  [-40, 3],
  [40, 3],
  [40, 25],
  [50, 25],
  [50, -25],
  [40, -25],
  [40, -3],
  [-40, -3],
  [-40, -25],
  [-50, -25],
]

/** A 100 × 100 square tube, wall 9 mm (inner void wound clockwise). */
const TUBE_OUTER: [number, number][] = [
  [-50, -50],
  [50, -50],
  [50, 50],
  [-50, 50],
]
const TUBE_HOLE: [number, number][] = [
  [-41, -41],
  [-41, 41],
  [41, 41],
  [41, -41],
]

// Cross-section (x, y) maps into world (Y, Z); the member runs along world X.
const X_AXIS: Vec3 = [0, 1, 0]
const Y_AXIS: Vec3 = [0, 0, 1]

describe('cutEdgeThicknessAt', () => {
  it('measures the plate perpendicular to the nearest face', () => {
    expect(cutEdgeThicknessAt(SECTION, [], [0, 25])).toBeCloseTo(50, 6)
    expect(cutEdgeThicknessAt(SECTION, [], [50, 0])).toBeCloseTo(100, 6)
  })

  it('uses the inner void for a hollow section wall', () => {
    expect(cutEdgeThicknessAt(TUBE_OUTER, [TUBE_HOLE], [0, 50])).toBeCloseTo(9, 6)
    expect(cutEdgeThicknessAt(TUBE_OUTER, [TUBE_HOLE], [50, 0])).toBeCloseTo(9, 6)
  })
})

describe('stockFaceThicknesses', () => {
  it('measures each stock face at its own surface (no NC frame needed)', () => {
    // Sides (x = ±50) are 100 mm apart; the top face (y = 25) is 50 mm above the bottom.
    expect(
      stockFaceThicknesses(
        SECTION,
        [],
        [
          [1, 0],
          [-1, 0],
          [0, 1],
        ],
      ),
    ).toEqual([50, 100])
  })

  it('reports one wall thickness for every face of a hollow section', () => {
    expect(
      stockFaceThicknesses(
        TUBE_OUTER,
        [TUBE_HOLE],
        [
          [1, 0],
          [-1, 0],
          [0, 1],
        ],
      ),
    ).toEqual([9])
  })

  it('gives a PFC the two plate thicknesses on its cut faces, not the open underside', () => {
    const pfc = partSectionForCode('PFC100*50', [100, 50, 6.7, 4.2, 8])
    expect(pfc).toBeTruthy()
    if (!pfc) return
    const normals: [number, number][] = []
    for (const face of CUT_FACES.channel) {
      const role = faceRole('channel', face)
      for (const sign of faceNormalSigns('channel', face)) {
        normals.push(role === 'side' ? [sign, 0] : [0, sign])
      }
    }
    // Flange (6.7) and web (4.2) — a channel's underside toe/throat is not a cut face.
    expect(stockFaceThicknesses(pfc.points, [], normals)).toEqual([4.2, 6.7])
  })
})

describe('classifyEdgeSegments', () => {
  it('keeps a lengthwise edge on the stock silhouette as stock', () => {
    // Along the member, lying on the top face (section y = 25).
    const classes = classifyEdgeSegments([0, 0, 25, 100, 0, 25], SECTION, [], X_AXIS, Y_AXIS)
    expect(classes).toHaveLength(1)
    expect(classes[0]?.kind).toBe('stock')
  })

  it('flags a transverse end-cut edge as a cut through the plate', () => {
    // Across the section at the member end — not parallel to the member axis.
    const classes = classifyEdgeSegments([0, -50, 25, 0, 50, 25], SECTION, [], X_AXIS, Y_AXIS)
    expect(classes[0]?.kind).toBe('cut')
    expect(classes[0]?.thickness).toBeCloseTo(50, 6)
  })

  it('flags an interior lengthwise edge (not on the outline) as a cut', () => {
    // Along the member, but in the middle of the section — a lengthwise split, not raw stock.
    const classes = classifyEdgeSegments([0, 0, 0, 100, 0, 0], SECTION, [], X_AXIS, Y_AXIS)
    expect(classes[0]?.kind).toBe('cut')
    expect(classes[0]?.thickness).toBeCloseTo(25, 6)
  })
})

describe('splitCutEdges', () => {
  it('separates stock edges and groups cut edges by thickness', () => {
    const segments = [
      // stock: lengthwise on the top face
      0, 0, 25, 100, 0, 25,
      // cut through 50 mm (a transverse end-cut edge on the top face)
      0, -50, 25, 0, 50, 25,
      // cut through 100 mm (a transverse end-cut edge on the side face)
      0, 50, -25, 0, 50, 25,
    ]
    const { stock, cuts } = splitCutEdges(segments, SECTION, [], X_AXIS, Y_AXIS)
    expect(stock).toHaveLength(6)
    expect(cuts.map((cut) => cut.thickness)).toEqual([50, 100])
    expect(cuts[0]?.points).toHaveLength(6)
    expect(cuts[1]?.points).toHaveLength(6)
  })
})

describe('edgeCutSegments', () => {
  it('keeps a lengthwise cut that sits off the stock silhouette (a cope / zig-zag step)', () => {
    // Along the member, inside the section (note the top face is at z = 25): a cut, not raw stock.
    const cut = edgeCutSegments([0, 0, 0, 100, 0, 0], SECTION, [], X_AXIS, Y_AXIS, false)
    expect(cut).toHaveLength(1)
    expect(cut[0]?.thickness).toBeCloseTo(25, 6)
  })

  it('drops a lengthwise edge that sits on the stock silhouette', () => {
    // Along the member, on the top face (z = 25): the raw-stock edge, not a cut.
    expect(
      edgeCutSegments([0, 0, 25, 100, 0, 25], SECTION, [], X_AXIS, Y_AXIS, false),
    ).toHaveLength(0)
  })

  it('keeps every segment of an edge already known to be a cut', () => {
    // On the silhouette, but the edge is shared with a transverse cut face → all segments kept.
    const cut = edgeCutSegments([0, 0, 25, 100, 0, 25], SECTION, [], X_AXIS, Y_AXIS, true)
    expect(cut).toHaveLength(1)
  })
})

const MEMBER: Vec3 = [1, 0, 0]

/** top (target, stock) + end (cut, transverse) + side (stock). Neighbours are face indices. */
function faces(transverseNeighbour: number, lengthwiseNeighbour: number): SeatedBrepFace[] {
  return [
    {
      normal: [0, 0, 1],
      center: [50, 0, 25],
      planar: true,
      samples: [50, 0, 25],
      wires: [
        {
          enclosed: false,
          edges: [
            // transverse end-cut edge on the top face → borders the end (cut) face
            { points: [0, -50, 25, 0, 50, 25], neighbours: [transverseNeighbour] },
            // lengthwise edge on the top face → borders the side (stock) face
            { points: [0, 0, 25, 100, 0, 25], neighbours: [lengthwiseNeighbour] },
          ],
        },
      ],
    },
    {
      normal: [1, 0, 0],
      center: [0, 0, 0],
      planar: true,
      samples: [0, 0, 0],
      wires: [{ enclosed: false, edges: [{ points: [0, -50, 25, 0, 50, 25], neighbours: [0] }] }],
    },
    {
      normal: [0, 1, 0],
      center: [50, 50, 0],
      planar: true,
      samples: [50, 50, 0],
      wires: [{ enclosed: false, edges: [{ points: [0, 50, 0, 100, 50, 0], neighbours: [0] }] }],
    },
  ]
}

describe('brepCutSegments', () => {
  it('drops a lengthwise edge whose neighbour is stock, keeps the transverse cut', () => {
    const cut = brepCutSegments(faces(1, 2), SECTION, [], X_AXIS, Y_AXIS, MEMBER, [[0, 0, 1]])
    expect(cut).toHaveLength(1)
    expect(cut[0]?.thickness).toBeCloseTo(50, 6)
    // The kept segment is the transverse one, not the lengthwise silhouette edge.
    expect(cut[0]?.points).toEqual([0, -50, 25, 0, 50, 25])
  })

  it('keeps a lengthwise edge whose neighbour is a cut face (never dropped as silhouette)', () => {
    // Both edges border the cut (end) face → both are cuts.
    const cut = brepCutSegments(faces(1, 1), SECTION, [], X_AXIS, Y_AXIS, MEMBER, [[0, 0, 1]])
    expect(cut).toHaveLength(2)
  })

  it('keys the cut thickness off the stock face map when supplied', () => {
    const seen: Vec3[] = []
    const cut = brepCutSegments(faces(1, 2), SECTION, [], X_AXIS, Y_AXIS, MEMBER, [[0, 0, 1]], {
      thicknessForNormal: (normal) => {
        seen.push(normal)
        return normal[2] > 0.9 ? 12 : null
      },
    })
    expect(cut).toHaveLength(1)
    // The top face's stock thickness (12 mm) replaces the geometric 50 mm measurement.
    expect(cut[0]?.thickness).toBe(12)
    expect(seen).toContainEqual([0, 0, 1])
  })

  it('falls back to the geometric thickness when the face is not in the stock map', () => {
    const cut = brepCutSegments(faces(1, 2), SECTION, [], X_AXIS, Y_AXIS, MEMBER, [[0, 0, 1]], {
      thicknessForNormal: () => null,
    })
    expect(cut[0]?.thickness).toBeCloseTo(50, 6)
  })

  it('targets an I-section interior web by its plane offset, not the flange edge', () => {
    // The +y normal exists on both the flange top edge (z = 25) and the web top (z = 3). The web
    // offset (tw/2) must select the web, so its cut reads the web plate, never the flange/depth.
    const flangeEdge: SeatedBrepFace = {
      normal: [0, 0, 1],
      center: [0, -45, 25],
      planar: true,
      samples: [0, -45, 25],
      wires: [
        {
          enclosed: false,
          edges: [{ points: [0, -50, 25, 0, -40, 25], neighbours: [2] }],
        },
      ],
    }
    // The web is modelled 1 mm off the catalogue plane (z = 2 vs tw/2 = 3): the nearest-face
    // match must still pick it, not the flange edge.
    const web: SeatedBrepFace = {
      normal: [0, 0, 1],
      center: [50, 0, 2],
      planar: true,
      samples: [50, 0, 2],
      wires: [
        {
          enclosed: false,
          edges: [{ points: [0, -40, 2, 0, 40, 2], neighbours: [2] }],
        },
      ],
    }
    const cut: SeatedBrepFace = {
      normal: [1, 0, 0],
      center: [0, 0, 0],
      planar: true,
      samples: [0, 0, 0],
      wires: [
        {
          enclosed: false,
          edges: [
            { points: [0, -50, 25, 0, -40, 25], neighbours: [0] },
            { points: [0, -40, 2, 0, 40, 2], neighbours: [1] },
          ],
        },
      ],
    }
    const cutSegments = brepCutSegments(
      [flangeEdge, web, cut],
      I_SECTION,
      [],
      X_AXIS,
      Y_AXIS,
      MEMBER,
      [[0, 0, 1]],
      { targetOffsets: [3] },
    )
    expect(cutSegments).toHaveLength(1)
    expect(cutSegments[0]?.points).toEqual([0, -40, 2, 0, 40, 2])
  })

  it('does not substitute a far-off stock face for a missing NC face plane', () => {
    // The only +y stock face is the flange edge at z = 25, far from the web plane (tw/2 ≈ 3).
    // Drawing its cut as a web line would be wrong, so nothing is emitted.
    const flangeEdge: SeatedBrepFace = {
      normal: [0, 0, 1],
      center: [0, -45, 25],
      planar: true,
      samples: [0, -45, 25],
      wires: [
        {
          enclosed: false,
          edges: [{ points: [0, -50, 25, 0, -40, 25], neighbours: [1] }],
        },
      ],
    }
    const cut: SeatedBrepFace = {
      normal: [1, 0, 0],
      center: [0, 0, 0],
      planar: true,
      samples: [0, 0, 0],
      wires: [
        {
          enclosed: false,
          edges: [{ points: [0, -50, 25, 0, -40, 25], neighbours: [0] }],
        },
      ],
    }
    const cutSegments = brepCutSegments(
      [flangeEdge, cut],
      I_SECTION,
      [],
      X_AXIS,
      Y_AXIS,
      MEMBER,
      [[0, 0, 1]],
      { targetOffsets: [3] },
    )
    expect(cutSegments).toHaveLength(0)
  })

  it('treats a flat↔fillet tangent edge as stock, not a cut', () => {
    // The fillet here is a lengthwise curved face whose surface samples are nowhere near the
    // catalogue outline (a radius mismatch). It is still stock, so the tangent edge must not be
    // drawn; only the edge bordering the real cut face is.
    const flat: SeatedBrepFace = {
      normal: [0, 1, 0],
      center: [50, 50, 0],
      planar: true,
      samples: [0, 50, 0],
      wires: [
        {
          enclosed: false,
          edges: [
            { points: [0, 50, -10, 0, 50, 0], neighbours: [1] },
            { points: [0, 50, 0, 0, 50, 10], neighbours: [2] },
          ],
        },
      ],
    }
    const fillet: SeatedBrepFace = {
      normal: [0, 0, 1],
      center: [50, 0, 20],
      planar: false,
      samples: [0, 50, 0],
      wires: [
        {
          enclosed: false,
          edges: [{ points: [0, 50, -10, 0, 50, 0], neighbours: [0] }],
        },
      ],
    }
    const cut: SeatedBrepFace = {
      normal: [1, 0, 0],
      center: [0, 0, 0],
      planar: true,
      samples: [0, 0, 0],
      wires: [
        {
          enclosed: false,
          edges: [{ points: [0, 50, 0, 0, 50, 10], neighbours: [0] }],
        },
      ],
    }
    const cutSegments = brepCutSegments(
      [flat, fillet, cut],
      I_SECTION,
      [],
      X_AXIS,
      Y_AXIS,
      MEMBER,
      [[0, 1, 0]],
    )
    expect(cutSegments).toHaveLength(1)
    expect(cutSegments[0]?.points).toEqual([0, 50, 0, 0, 50, 10])
  })

  it('projects a cut across a root fillet onto the face plane’s cut trace (as if sharp)', () => {
    // The fillet edge sits above the web plane (z = 5 vs 3) and runs past the web's physical end
    // (|y| = 45). Projecting orthogonally would leave both the offset and a kink; the cut plane's
    // trace on the web plane (X = 10 − 0.5·Y) is the line the NC would draw on a sharp section.
    const n = Math.hypot(1, 0.5)
    const web: SeatedBrepFace = {
      normal: [0, 0, 1],
      center: [50, 0, 3],
      planar: true,
      samples: [50, 0, 3],
      wires: [{ enclosed: false, edges: [{ points: [0, -40, 3, 0, 40, 3], neighbours: [1] }] }],
    }
    const fillet: SeatedBrepFace = {
      normal: [0, 0, 1],
      center: [50, 45, 5],
      planar: false,
      samples: [0, 45, 25],
      wires: [{ enclosed: false, edges: [{ points: [0, -45, 5, 0, 45, 5], neighbours: [0, 2] }] }],
    }
    const cut: SeatedBrepFace = {
      normal: [1 / n, 0.5 / n, 0],
      center: [10, 0, 0],
      planar: true,
      samples: [0, 0, 0],
      wires: [{ enclosed: false, edges: [{ points: [0, -45, 5, 0, 45, 5], neighbours: [1] }] }],
    }
    const cutSegments = brepCutSegments(
      [web, fillet, cut],
      I_SECTION,
      [],
      X_AXIS,
      Y_AXIS,
      MEMBER,
      [[0, 0, 1]],
      { targetOffsets: [undefined] },
    )
    expect(cutSegments).toHaveLength(1)
    const p = cutSegments[0]?.points ?? []
    expect(p[2]).toBeCloseTo(3, 6)
    expect(p[5]).toBeCloseTo(3, 6)
    expect(p[0]).toBeCloseTo(10 - 0.5 * (p[1] as number), 6)
    expect(p[3]).toBeCloseTo(10 - 0.5 * (p[4] as number), 6)
    // The span reaches past the web's physical half-width (40): the line goes to the sharp corner.
    expect(Math.max(Math.abs(p[1] as number), Math.abs(p[4] as number))).toBeGreaterThan(40)
  })

  it('keeps every coplanar piece of a flange split by a cut', () => {
    // A flange face can be split into several planar patches. Both are the outermost +x stock
    // face, so both must stay targets — otherwise an item loses half its flange cut lines.
    const piece = (z: number): SeatedBrepFace => ({
      normal: [0, 1, 0],
      center: [50, 50, z],
      planar: true,
      samples: [50, 50, z],
      wires: [
        {
          enclosed: false,
          edges: [{ points: [0, 50, z - 5, 0, 50, z + 5], neighbours: [2] }],
        },
      ],
    })
    const cut: SeatedBrepFace = {
      normal: [1, 0, 0],
      center: [0, 0, 0],
      planar: true,
      samples: [0, 0, 0],
      wires: [
        {
          enclosed: false,
          edges: [
            { points: [0, 50, -15, 0, 50, -5], neighbours: [0] },
            { points: [0, 50, 5, 0, 50, 15], neighbours: [1] },
          ],
        },
      ],
    }
    const cutSegments = brepCutSegments(
      [piece(-10), piece(10), cut],
      I_SECTION,
      [],
      X_AXIS,
      Y_AXIS,
      MEMBER,
      [[0, 1, 0]],
      { targetOffsets: [undefined] },
    )
    expect(cutSegments).toHaveLength(2)
  })

  it('reads a bevel from a tilted cut face and gives its outward sweep direction', () => {
    const degrees = 20
    const rad = (degrees * Math.PI) / 180
    // Top (stock) face + a cut face tilted 20° about the cross-edge: its normal gains a +z component.
    const cut = brepCutSegments(
      [
        {
          normal: [0, 0, 1],
          center: [50, 0, 25],
          planar: true,
          samples: [50, 0, 25],
          wires: [
            {
              enclosed: false,
              edges: [{ points: [0, -50, 25, 0, 50, 25], neighbours: [1] }],
            },
          ],
        },
        {
          normal: [Math.cos(rad), 0, Math.sin(rad)],
          center: [0, 0, 0],
          planar: true,
          samples: [0, 0, 0],
          wires: [
            {
              enclosed: false,
              edges: [{ points: [0, -50, 25, 0, 50, 25], neighbours: [0] }],
            },
          ],
        },
      ],
      SECTION,
      [],
      X_AXIS,
      Y_AXIS,
      MEMBER,
      [[0, 0, 1]],
    )
    expect(cut).toHaveLength(1)
    expect(cut[0]?.bevel).toBeCloseTo(degrees, 1)
    // The fin sweeps outward (+z, the stock normal), tilted to the side the cut face rises to —
    // opposite the cut normal's +x in-plane lean (the face rises toward −x as it leaves the stock).
    expect(cut[0]?.bevelDir?.[0]).toBeCloseTo(-Math.sin(rad), 3)
    expect(cut[0]?.bevelDir?.[2]).toBeCloseTo(Math.cos(rad), 3)
  })

  it('reports no bevel for a square cut, and no line for a lengthwise step', () => {
    const square = brepCutSegments(faces(1, 2), SECTION, [], X_AXIS, Y_AXIS, MEMBER, [[0, 0, 1]])
    expect(square[0]?.bevel).toBe(0)
    expect(square[0]?.bevelDir).toBeNull()
    // A face parallel to the top face runs along the member (a flat step), not a transverse cut,
    // so it produces no cut line at all.
    const step = brepCutSegments(
      [
        {
          normal: [0, 0, 1],
          center: [50, 0, 25],
          planar: true,
          samples: [50, 0, 25],
          wires: [
            {
              enclosed: false,
              edges: [{ points: [0, -50, 25, 0, 50, 25], neighbours: [1] }],
            },
          ],
        },
        {
          normal: [0, 0, 1],
          center: [0, 0, 10],
          planar: true,
          samples: [0, 0, 10],
          wires: [
            {
              enclosed: false,
              edges: [{ points: [0, -50, 25, 0, 50, 25], neighbours: [0] }],
            },
          ],
        },
      ],
      SECTION,
      [],
      X_AXIS,
      Y_AXIS,
      MEMBER,
      [[0, 0, 1]],
    )
    expect(step).toHaveLength(0)
  })

  it('keeps a bevel fin where the cut rounds a curved stock corner (fillet)', () => {
    const degrees = 20
    const rad = (degrees * Math.PI) / 180
    // A rounded stock corner (curved face, adjacent to the top target) carries the same transverse
    // cut edge; the fin must survive there, read against the plane it projects onto.
    const top: SeatedBrepFace = {
      normal: [0, 0, 1],
      center: [50, 0, 25],
      planar: true,
      samples: [50, 0, 25],
      wires: [{ enclosed: false, edges: [{ points: [0, 0, 25, 100, 0, 25], neighbours: [1] }] }],
    }
    const fillet: SeatedBrepFace = {
      normal: [0, 0.7, 0.7],
      center: [50, 25, 20],
      planar: false,
      samples: [50, 0, 25, 50, 50, 25],
      wires: [
        {
          enclosed: false,
          edges: [
            { points: [0, 0, 25, 100, 0, 25], neighbours: [0] },
            { points: [0, -50, 25, 0, 50, 25], neighbours: [2] },
          ],
        },
      ],
    }
    const cut: SeatedBrepFace = {
      normal: [Math.cos(rad), 0, Math.sin(rad)],
      center: [0, 0, 15],
      planar: true,
      samples: [0, 0, 15],
      wires: [{ enclosed: false, edges: [{ points: [0, -50, 25, 0, 50, 25], neighbours: [1] }] }],
    }
    const out = brepCutSegments([top, fillet, cut], SECTION, [], X_AXIS, Y_AXIS, MEMBER, [
      [0, 0, 1],
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.bevel).toBeCloseTo(degrees, 1)
    expect(out[0]?.bevelDir?.[0]).toBeCloseTo(-Math.sin(rad), 3)
  })

  it('reads a bevel per segment from a curved cut face (local neighbour normals)', () => {
    const n = (deg: number): Vec3 => {
      const r = (deg * Math.PI) / 180
      return [Math.cos(r), 0, Math.sin(r)]
    }
    // A three-point edge → two segments; the cut face is curved and its local normal tapers 20° → 10°.
    const top: SeatedBrepFace = {
      normal: [0, 0, 1],
      center: [50, 0, 25],
      planar: true,
      samples: [50, 0, 25],
      wires: [
        {
          enclosed: false,
          edges: [
            {
              points: [0, -50, 25, 0, 0, 25, 0, 50, 25],
              neighbours: [1],
              neighbourNormals: [[...n(20), ...n(10), ...n(10)]],
            },
          ],
        },
      ],
    }
    const cope: SeatedBrepFace = {
      normal: n(20),
      center: [0, 0, 15],
      planar: false,
      samples: [],
      wires: [{ enclosed: false, edges: [{ points: [0, -50, 25, 0, 50, 25], neighbours: [0] }] }],
    }
    const out = brepCutSegments([top, cope], SECTION, [], X_AXIS, Y_AXIS, MEMBER, [[0, 0, 1]])
    expect(out).toHaveLength(2)
    expect(out[0]?.bevel).toBeCloseTo(20, 1)
    expect(out[1]?.bevel).toBeCloseTo(10, 1)
    expect(out[0]?.bevelDir).not.toBeNull()
  })

  it('does not draw a lengthwise flat step/chamfer as a cut line', () => {
    // A lengthwise chamfer's boundary touches the outline (top face at z = 25), but it is a flat
    // surface running along the member — not a transverse cut — so it must not produce a cut line.
    const top: SeatedBrepFace = {
      normal: [0, 0, 1],
      center: [50, 0, 25],
      planar: true,
      samples: [50, 0, 25],
      wires: [
        {
          enclosed: false,
          edges: [{ points: [0, 0, 25, 100, 0, 25], neighbours: [1] }],
        },
      ],
    }
    const chamfer: SeatedBrepFace = {
      normal: [0, 0, 1],
      center: [50, 0, 10],
      planar: true,
      samples: [50, 0, 10],
      wires: [
        {
          enclosed: false,
          edges: [{ points: [0, 0, 25, 100, 0, 25], neighbours: [0] }],
        },
      ],
    }
    const cut = brepCutSegments([top, chamfer], SECTION, [], X_AXIS, Y_AXIS, MEMBER, [[0, 0, 1]])
    expect(cut).toHaveLength(0)
  })
})
