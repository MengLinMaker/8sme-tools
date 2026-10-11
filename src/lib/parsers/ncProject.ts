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

import {
  faceHalf,
  faceNormal,
  faceSpanAxis,
  materialReaches,
  type NcFaceFrame,
  placeNcFace,
} from './ncFaces'
import type { NcFace, NcGeometry } from './ncGeometry'

export type Vec3 = [number, number, number]

/** One colour per distinct cut thickness (indexed by thickness order within a part). */
export const THICKNESS_COLORS = [
  0x3ddc84, 0x38bdf8, 0xf59e0b, 0xa78bfa, 0xf87171, 0x22d3ee, 0xfacc15,
] as const

/** Fixed colours for the non-cut profiles (etch / weld markings). */
export const ETCH_COLOR = 0xf5f5f5
export const MARKING_COLOR = 0xfb923c

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

/** Cut lines (with their welding-bevel arrows) grouped by the wall thickness they cut. */
export interface NcLineSets {
  /** One entry per distinct cut thickness (mm); cut lines and bevel arrows share its colour. */
  cuts: { thickness: number; points: number[] }[]
}

/** Segments around each hole ring — enough to read as a circle at part scale. */
const HOLE_STEPS = 24

/** Default spur length (mm) shown for an angle-only bevel that carries no distance. */
const DEFAULT_BEVEL_SPUR = 3

/** Bevel arrow length (mm, tip distance from the cut line), head size (mm) and spacing (mm). */
const ARROW_LENGTH = 30
const ARROW_HEAD = 9
const ARROW_SPACING = 40
/** A bevel within this many degrees of the surface normal is a plain (regular) cut — no arrow. */
const REGULAR_CUT_DEG = 8

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/**
 * A stemmed arrow. The stem runs from the cut line outward along `dir`; the head sits at the cut
 * line and points back inward (against `dir`) along the same line.
 */
function arrow(target: number[], at: Vec3, dir: Vec3, spread: Vec3): void {
  const tail: Vec3 = [
    at[0] + dir[0] * ARROW_LENGTH,
    at[1] + dir[1] * ARROW_LENGTH,
    at[2] + dir[2] * ARROW_LENGTH,
  ]
  push(target, at, tail)
  const half = ARROW_HEAD * 0.5
  const bx = at[0] + dir[0] * ARROW_HEAD
  const by = at[1] + dir[1] * ARROW_HEAD
  const bz = at[2] + dir[2] * ARROW_HEAD
  push(target, at, [bx + spread[0] * half, by + spread[1] * half, bz + spread[2] * half])
  push(target, at, [bx - spread[0] * half, by - spread[1] * half, bz - spread[2] * half])
}

/** Signed bevel angle (degrees) at a vertex — the larger-magnitude of its two angle/distance pairs. */
function bevelAngle(bevel: number[] | undefined): number {
  if (!bevel) return 0
  const a0 = bevel[0] ?? 0
  const a1 = bevel[2] ?? 0
  return Math.abs(a0) >= Math.abs(a1) ? a0 : a1
}

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

/**
 * Wall thickness (mm) a face cuts through: the distance from the face plane to the nearest opposite
 * edge of the section (the plate the cut passes through) — e.g. the flange/ web thickness.
 */
export function faceThickness(
  frame: NcFaceFrame,
  section: [number, number][],
  face: NcFace,
): number {
  const normal = faceNormal(frame, face)
  const axis = normal.axis
  const faceCoord = normal.sign * faceHalf(frame, axis)
  let min = Number.POSITIVE_INFINITY
  for (const point of section) {
    const distance = Math.abs((point[axis] ?? 0) - faceCoord)
    if (distance > 0.01 && distance < min) min = distance
  }
  return Number.isFinite(min) ? min : 0
}

/** Projects an NC's contours, holes and bevels into the caller's frame, grouped by cut thickness. */
export function projectNc(nc: NcGeometry, projection: NcProjection): NcLineSets {
  const { frame, section, toScene, normal } = projection
  const byFace: Record<NcFace, number[]> = { v: [], o: [], u: [], h: [] }

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
        push(byFace[contour.face], a.world, b.world)
        continue
      }
      // A cut with no material on its face (edge of stock / one-sided section) removes nothing.
      const reached =
        materialReaches(frame, section, contour.face, a.point.cross) ||
        materialReaches(frame, section, contour.face, b.point.cross)
      if (!reached) continue
      // A segment lying along the stock's own edge (the section boundary, both ends at the same
      // span extreme) removes nothing either — it's the raw-stock outline, not a cut.
      const span = faceSpanAxis(frame, contour.face)
      const halfSpan = faceHalf(frame, span)
      const ca = a.point.cross[span]
      const cb = b.point.cross[span]
      if (
        Math.sign(ca) === Math.sign(cb) &&
        Math.abs(Math.abs(ca) - halfSpan) < 0.5 &&
        Math.abs(Math.abs(cb) - halfSpan) < 0.5
      ) {
        continue
      }
      const d0 = bevelDistance(contour.bevels[i])
      const d1 = bevelDistance(contour.bevels[i + 1])
      // The cut line is grouped by its face's thickness; the bevel just adds a direction arrow.
      push(byFace[contour.face], a.world, b.world)
      if (d0 <= 0 && d1 <= 0) continue

      // The cut face is tilted off the surface normal by the bevel angle; show that tilt with an
      // arrow perpendicular to the cut line (in the plane of the normal), plotted periodically.
      // A bevel within REGULAR_CUT_DEG of the normal is just a plain cut — no arrow.
      const deg =
        Math.abs(bevelAngle(contour.bevels[i])) >= Math.abs(bevelAngle(contour.bevels[i + 1]))
          ? bevelAngle(contour.bevels[i])
          : bevelAngle(contour.bevels[i + 1])
      if (Math.abs(deg) < REGULAR_CUT_DEG) continue
      const line = normalize([
        b.world[0] - a.world[0],
        b.world[1] - a.world[1],
        b.world[2] - a.world[2],
      ])
      const perp = normalize(cross(spur, line))
      const theta = (Math.abs(deg) * Math.PI) / 180
      const side = deg >= 0 ? -1 : 1
      // Outward tilt from the surface normal: at 0° it is the normal (regular), grows toward perp.
      const dir = normalize([
        spur[0] * Math.cos(theta) + perp[0] * Math.sin(theta) * side,
        spur[1] * Math.cos(theta) + perp[1] * Math.sin(theta) * side,
        spur[2] * Math.cos(theta) + perp[2] * Math.sin(theta) * side,
      ])
      const length = Math.hypot(
        b.world[0] - a.world[0],
        b.world[1] - a.world[1],
        b.world[2] - a.world[2],
      )
      const count = Math.max(1, Math.round(length / ARROW_SPACING))
      for (let k = 1; k <= count; k++) {
        const t = k / (count + 1)
        const at: Vec3 = [
          a.world[0] + (b.world[0] - a.world[0]) * t,
          a.world[1] + (b.world[1] - a.world[1]) * t,
          a.world[2] + (b.world[2] - a.world[2]) * t,
        ]
        arrow(byFace[contour.face], at, dir, line)
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
    for (let i = 0; i < ring.length - 1; i++) push(byFace[hole.face], ring[i], ring[i + 1])
  }

  // Group the cut lines by the wall thickness of the face they cut (same thickness ⇒ same profile).
  const groups = new Map<number, number[]>()
  for (const face of ['v', 'o', 'u', 'h'] as NcFace[]) {
    const points = byFace[face]
    if (points.length === 0) continue
    const key = Math.round(faceThickness(frame, section, face) * 10) / 10
    const bucket = groups.get(key)
    if (bucket) bucket.push(...points)
    else groups.set(key, points)
  }
  const cuts = [...groups.entries()]
    .map(([thickness, points]) => ({ thickness, points }))
    .sort((a, b) => a.thickness - b.thickness)
  return { cuts }
}

/** Distinct cut thicknesses (mm) present in an NC, sorted ascending — for the viewer legend. */
export function cutThicknesses(
  frame: NcFaceFrame,
  section: [number, number][],
  nc: NcGeometry,
): number[] {
  const faces = new Set<NcFace>()
  for (const contour of nc.contours) faces.add(contour.face)
  for (const hole of nc.holes) faces.add(hole.face)
  const values = [...faces].map((face) => Math.round(faceThickness(frame, section, face) * 10) / 10)
  return [...new Set(values)].sort((a, b) => a - b)
}
