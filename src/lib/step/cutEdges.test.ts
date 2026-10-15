import { describe, expect, it } from 'vitest'
import {
  brepCutSegments,
  classifyEdgeSegments,
  cutEdgeThicknessAt,
  edgeCutSegments,
  type SeatedBrepFace,
  splitCutEdges,
  type Vec3,
} from './cutEdges'

/** A 100 × 50 solid rectangular stock section, centred on the origin. */
const SECTION: [number, number][] = [
  [-50, -25],
  [50, -25],
  [50, 25],
  [-50, 25],
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

  it('reports no bevel for a square cut or a step parallel to the face', () => {
    const square = brepCutSegments(faces(1, 2), SECTION, [], X_AXIS, Y_AXIS, MEMBER, [[0, 0, 1]])
    expect(square[0]?.bevel).toBe(0)
    expect(square[0]?.bevelDir).toBeNull()
    // A face parallel to the top face (a step) reads as 90° — past the head's range, so no bevel.
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
    expect(step[0]?.bevel).toBe(0)
    expect(step[0]?.bevelDir).toBeNull()
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

  it('treats a lengthwise chamfer as a cut even though its boundary sits on the outline', () => {
    // A chamfer cut down the corner: its boundary edges touch the outline (top face at z = 25), but
    // its *surface* (sampled by the centroid) is inset → a cut face, so the edge is captured.
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
    expect(cut.length).toBeGreaterThan(0)
  })
})
