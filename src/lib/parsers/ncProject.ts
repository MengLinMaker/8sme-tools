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
import type { NcFace, NcGeometry, NcHole } from './ncGeometry'

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

/**
 * The face-space outline of a hole as a closed polyline (last point repeats the first): a circle,
 * or — for a DSTV slotted (`l`) hole — an **obround** (stadium) whose end centres are the hole's
 * start point `(x, y)` and its far end `(x + dx, y + dy)`, each of radius `diameter / 2`.
 */
export function holeOutline(hole: NcHole, steps = HOLE_STEPS): [number, number][] {
  const r = hole.diameter / 2
  const slot = hole.slot
  const points: [number, number][] = []
  if (slot && (slot.dx !== 0 || slot.dy !== 0)) {
    const base = Math.atan2(slot.dy, slot.dx)
    const half = Math.max(2, Math.round(steps / 2))
    // Far end's semicircle, sweeping through the slot direction (base ± 90°), then the near
    // end's, back to the start — together they trace the full stadium.
    for (let i = 0; i <= half; i++) {
      const a = base - Math.PI / 2 + (i / half) * Math.PI
      points.push([hole.x + slot.dx + Math.cos(a) * r, hole.y + slot.dy + Math.sin(a) * r])
    }
    for (let i = 0; i <= half; i++) {
      const a = base + Math.PI / 2 + (i / half) * Math.PI
      points.push([hole.x + Math.cos(a) * r, hole.y + Math.sin(a) * r])
    }
    points.push([points[0][0], points[0][1]])
    return points
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2
    points.push([hole.x + Math.cos(a) * r, hole.y + Math.sin(a) * r])
  }
  return points
}

/** Samples taken along a cut segment when testing whether any of it has material (see `reached`). */
const REACH_SAMPLES = 8

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
  /** Corner coordinates of the DSTV notch labels on a face — real cuts even where material recedes. */
  const notchCorners = (face: NcFace): [number, number][] =>
    nc.notches.filter((n) => n.face === face).map((n) => [n.x, n.y])

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
      // A cut with no material anywhere along it (edge of stock / one-sided section) removes
      // nothing. Sample along the segment: checking only the *ends* wrongly drops a full-width end
      // cut, whose ends sit in the corner radius where the face plane recedes from the material.
      let reached = false
      for (let s = 0; s <= REACH_SAMPLES; s++) {
        const t = s / REACH_SAMPLES
        const cross: [number, number] = [
          a.point.cross[0] + (b.point.cross[0] - a.point.cross[0]) * t,
          a.point.cross[1] + (b.point.cross[1] - a.point.cross[1]) * t,
        ]
        if (materialReaches(frame, section, contour.face, cross)) {
          reached = true
          break
        }
      }
      if (!reached) {
        // A DSTV notch label (`t`/`w`) marks a real cut at a corner where the face plane recedes
        // (e.g. the necked end of a shaft). Keep the segment so its cut line is drawn.
        const notched = notchCorners(contour.face).some(
          ([nx, ny]) => Math.hypot(x0 - nx, y0 - ny) < 2 || Math.hypot(x1 - nx, y1 - ny) < 2,
        )
        if (!notched) continue
      }
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
    const outline = holeOutline(hole)
    const ring: Vec3[] = []
    let anyReached = false
    for (const [hx, hy] of outline) {
      const placed = place(hole.face, hx, hy)
      if (materialReaches(frame, section, hole.face, placed.point.cross)) anyReached = true
      ring.push(placed.world)
    }
    // Drop a hole/slot that sits entirely where the section has no material on its face.
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
