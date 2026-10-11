/**
 * Projects DSTV NC toolpath geometry (outer/inner contours, holes, welding bevels) onto the
 * manufactured solid so the cut lines can be drawn on the part they produced.
 *
 * Face placement is not re-derived here: it comes from the shared cross-section face frame
 * (`ncFaces`), the same rule the NC→solid rebuild uses. So each contour lands on exactly the
 * face the laser cuts, and a cut that lines up with the edge of the stock (no material on that
 * side) is dropped instead of being drawn across the void.
 *
 * The geometry reader is frame-agnostic — points are `(x along the member, y across the face)`.
 * The caller supplies a `toScene` mapper that turns a section-frame point into 3D coordinates in
 * the model's own frame (stock-ghost seated frame for preflight, beam frame for nesting) and a
 * `normal` for orienting bevel spurs.
 */

import { materialReaches, type NcFaceFrame, placeNcFace } from './ncFaces'
import type { NcFace, NcGeometry } from './ncGeometry'

export type Vec3 = [number, number, number]

export interface NcProjection {
  /** The section face frame the NC was matched against (see `resolveNcFaceFrame`). */
  frame: NcFaceFrame
  /** The section outline the frame came from, for material-reach checks. */
  section: [number, number][]
  /** Maps a section-frame point to scene coordinates (already offset clear of the surface). */
  toScene: (along: number, cross: [number, number], face: NcFace) => Vec3
  /** Outward unit normal of a face, in scene coordinates, for bevel spurs. */
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
export function projectNc(nc: NcGeometry, projection: NcProjection): NcLineSets {
  const { frame, section, toScene, normal } = projection
  const outer: number[] = []
  const bevel: number[] = []
  const inner: number[] = []
  const holes: number[] = []

  const place = (face: NcFace, x: number, y: number) => {
    const point = placeNcFace(frame, face, x, y)
    return { point, world: toScene(point.along, point.cross, face) }
  }

  for (const contour of nc.contours) {
    const spur = normal(contour.face)
    for (let i = 0; i < contour.points.length - 1; i++) {
      const [x0, y0] = contour.points[i]
      const [x1, y1] = contour.points[i + 1]
      const a = place(contour.face, x0, y0)
      const b = place(contour.face, x1, y1)
      if (contour.kind === 'inner') {
        push(inner, a.world, b.world)
        continue
      }
      // A cut with no material on its face (edge of stock / one-sided section) removes nothing.
      const reached =
        materialReaches(frame, section, contour.face, a.point.cross) ||
        materialReaches(frame, section, contour.face, b.point.cross)
      if (!reached) continue
      const d0 = bevelDistance(contour.bevels[i])
      const d1 = bevelDistance(contour.bevels[i + 1])
      if (d0 > 0 || d1 > 0) {
        push(bevel, a.world, b.world)
        if (d0 > 0)
          push(bevel, a.world, [
            a.world[0] + spur[0] * d0,
            a.world[1] + spur[1] * d0,
            a.world[2] + spur[2] * d0,
          ])
        if (d1 > 0)
          push(bevel, b.world, [
            b.world[0] + spur[0] * d1,
            b.world[1] + spur[1] * d1,
            b.world[2] + spur[2] * d1,
          ])
      } else {
        push(outer, a.world, b.world)
      }
    }
  }

  for (const hole of nc.holes) {
    const r = hole.diameter / 2
    if (!(r > 0)) continue
    const ring: Vec3[] = []
    let anyReached = false
    for (let i = 0; i <= HOLE_STEPS; i++) {
      const angle = (i / HOLE_STEPS) * Math.PI * 2
      const placed = place(hole.face, hole.x + Math.cos(angle) * r, hole.y + Math.sin(angle) * r)
      if (materialReaches(frame, section, hole.face, placed.point.cross)) anyReached = true
      ring.push(placed.world)
    }
    // Drop a hole that sits entirely where the section has no material on its face.
    if (!anyReached) continue
    for (let i = 0; i < ring.length - 1; i++) push(holes, ring[i], ring[i + 1])
  }

  return { outer, bevel, inner, holes }
}
