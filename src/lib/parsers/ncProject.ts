/**
 * Projects DSTV NC toolpath geometry (outer/inner contours, holes, welding bevels) onto a
 * solid's bounding faces so the cut lines can be drawn on the manufactured model — showing
 * each operation on the part it produced.
 *
 * The geometry reader (`ncGeometry`) is frame-agnostic: every point is `(x along the member,
 * y across its face)`. The caller supplies a `place` mapping that turns those per-face
 * coordinates into 3D points in the target frame (stock-ghost seated frame for preflight, the
 * beam's own frame for nesting) and a `normal` for orienting bevel spurs.
 */

import type { NcContour, NcFace, NcGeometry } from './ncGeometry'

export type Vec3 = [number, number, number]

export interface NcPlacement {
  /** Maps an NC per-face `(x along member, y across face)` to a 3D point. */
  place: (face: NcFace, x: number, y: number) => Vec3
  /** Outward unit normal of a face, for bevel spurs. */
  normal: (face: NcFace) => Vec3
}

/** Flat XYZ pair lists (two vertices per segment), ready for a `LineSegments`. */
export interface NcLineSets {
  /** Outer contours with no bevel — the plain, normal-to-surface cuts. */
  outer: number[]
  /** Outer contour segments carrying a welding bevel, plus their spurs. */
  bevel: number[]
  /** Inner (cut-out) contours. */
  inner: number[]
  /** Holes, drawn as rings. */
  holes: number[]
}

/** Segments around each hole ring — enough to read as a circle at part scale. */
const HOLE_STEPS = 24

/** Default spur length (mm) shown for an angle-only bevel that carries no distance. */
const DEFAULT_BEVEL_SPUR = 3

/** Bevel distance to draw for a vertex, or 0 when the vertex is a plain cut. */
function bevelDistance(bevel: number[] | undefined): number {
  if (!bevel) return 0
  const distance = Math.max(bevel[1] ?? 0, bevel[3] ?? 0)
  if (distance > 0) return distance
  const angle = Math.max(bevel[0] ?? 0, bevel[2] ?? 0)
  return angle !== 0 ? DEFAULT_BEVEL_SPUR : 0
}

function push(target: number[], a: Vec3, b: Vec3): void {
  target.push(a[0], a[1], a[2], b[0], b[1], b[2])
}

/** Projects an NC's contours, holes and bevels into the caller's frame. */
export function projectNc(nc: NcGeometry, placement: NcPlacement): NcLineSets {
  const outer: number[] = []
  const bevel: number[] = []
  const inner: number[] = []
  const holes: number[] = []

  for (const contour of nc.contours) {
    const spur = placement.normal(contour.face)
    for (let i = 0; i < contour.points.length - 1; i++) {
      const [x0, y0] = contour.points[i]
      const [x1, y1] = contour.points[i + 1]
      const a = placement.place(contour.face, x0, y0)
      const b = placement.place(contour.face, x1, y1)
      if (contour.kind === 'inner') {
        push(inner, a, b)
        continue
      }
      const d0 = bevelDistance(contour.bevels[i])
      const d1 = bevelDistance(contour.bevels[i + 1])
      if (d0 > 0 || d1 > 0) {
        push(bevel, a, b)
        if (d0 > 0) push(bevel, a, [a[0] + spur[0] * d0, a[1] + spur[1] * d0, a[2] + spur[2] * d0])
        if (d1 > 0) push(bevel, b, [b[0] + spur[0] * d1, b[1] + spur[1] * d1, b[2] + spur[2] * d1])
      } else {
        push(outer, a, b)
      }
    }
  }

  for (const hole of nc.holes) {
    const r = hole.diameter / 2
    if (!(r > 0)) continue
    let prev: Vec3 | null = null
    for (let i = 0; i <= HOLE_STEPS; i++) {
      const angle = (i / HOLE_STEPS) * Math.PI * 2
      const point = placement.place(
        hole.face,
        hole.x + Math.cos(angle) * r,
        hole.y + Math.sin(angle) * r,
      )
      if (prev) push(holes, prev, point)
      prev = point
    }
  }

  return { outer, bevel, inner, holes }
}

function extent(points: [number, number][], axis: 0 | 1): number {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const p of points) {
    min = Math.min(min, p[axis])
    max = Math.max(max, p[axis])
  }
  return max - min
}

function maxAcross(contour: NcContour): number {
  return Math.max(...contour.points.map((p) => p[1]))
}

/**
 * Which cross-section axis (0 or 1) each NC face pair lives on, mirroring the NC→solid
 * rebuild: `v`/`h` (web) faces span one section axis, `o`/`u` (flange) the other. The web
 * contour's across-extent is matched to the two section dimensions to decide which.
 */
export function resolveNcFaceAxes(
  section: [number, number][],
  nc: NcGeometry,
): { ou: 0 | 1; vh: 0 | 1 } {
  const ex = extent(section, 0)
  const ey = extent(section, 1)
  const match = (across: number): 0 | 1 => (Math.abs(across - ex) <= Math.abs(across - ey) ? 0 : 1)
  const vh = nc.contours.find((c) => c.kind === 'outer' && (c.face === 'v' || c.face === 'h'))
  const ou = nc.contours.find((c) => c.kind === 'outer' && (c.face === 'o' || c.face === 'u'))
  const axisVH: 0 | 1 = vh ? match(maxAcross(vh)) : ou ? ((1 - match(maxAcross(ou))) as 0 | 1) : 0
  return { vh: axisVH, ou: (1 - axisVH) as 0 | 1 }
}
