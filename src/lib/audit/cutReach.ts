import { MACHINE } from '@/lib/machine/profile'
import { faceNormal, placeNcFace, resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import {
  type NcContour,
  type NcFace,
  type NcGeometry,
  parseNcGeometry,
} from '@/lib/parsers/ncGeometry'

/**
 * Cut-reach analysis from the *profile*, not the part.
 *
 * The stock is prismatic, so whether a cut is manufacturable depends only on the 2D
 * cross-section, the beam's direction in it, and the bevel. The beam enters each cut at the
 * face's surface point and fires straight in (the face's inward normal); a bevel tilts the
 * beam out of the section plane, which only *shortens* its in-plane reach (`× cosβ`) — it does
 * not bend it in the section. So the test is one 2D ray per cut, no per-part OCC:
 *
 *   path = material the beam bores at that point
 *   clean  ⟺  path / cosβ ≤ MAX_CUT_THICKNESS_MM   (and the beam doesn't reach a further wall)
 *
 * This replaces the old "light sabre" 3D test, which fired perpendicular to the *finished*
 * surface — wrong for a bevel/mitre (its normal is not the beam), so it flagging e.g. a 20°
 * flange end as an 85 mm bore when the real pass is ~7 mm.
 */

/** Max material thickness the head can pierce in one pass (mm) — the machine profile. */
export const MAX_CUT_THICKNESS_MM = MACHINE.envelope.maxThicknessMm

/** The head's bevel / weld-prep range, from the machine profile. */
const MAX_BEVEL_DEG = Math.max(Math.abs(MACHINE.bevel.minDeg), Math.abs(MACHINE.bevel.maxDeg))

/**
 * Max search distance (mm) for the ray march. Only needs to clear the first wall (whose full
 * length we must measure) plus a little; a section can't be wider than ~450 mm.
 */
const MAX_PROBE_MM = 1000

/** A surface edge whose local normal is at least this aligned with the face counts as that face. */
const FACE_ALIGN_DOT = 0.5

/**
 * Bevels below this (deg) are unbevelled for our purposes. An unbevelled cut into a face is a
 * straight radial pass through that face's wall — always within the pierce cap for a structural
 * section — so it is taken as cuttable without a test (only a bevel can lengthen the bore).
 */
const MIN_BEVEL_DEG = 0.5

/**
 * Where along an edge to probe, as a fraction. The middle only: the ends of a face's end-cut
 * edge sit in the section's corner regions (e.g. where a channel web meets a flange), where a
 * beam along *this* face's normal is not how the cut is actually made — the corner is shared
 * with the transverse face and is cut by that face's pass. Probing the middle measures the wall
 * the cut genuinely runs through.
 */
const EDGE_SAMPLES = [0.35, 0.5, 0.65]

export interface CutReachFailure {
  /** `reach`: the beam bottoms out inside the material. `wall`: it would cut a wall behind. */
  reason: 'reach' | 'wall'
  face: NcFace
  /** where along the member the beam enters (NC X, mm) */
  x: number
  /** section-frame point the beam enters at (on the face plane) */
  entry: [number, number]
  /** section-frame unit direction the beam travels (the face's inward normal) */
  dir: [number, number]
  /** section-frame point the beam leaves the material (entry + path·dir) */
  exit: [number, number]
  /** material path along the beam (mm) — the bore it must make */
  path: number
  /** bevel angle magnitude at the cut (deg) */
  bevel: number
}

function unitComponent(axis: number, sign: number): [number, number] {
  return axis === 0 ? [sign, 0] : [0, sign]
}

function pointInPolygon([px, py]: [number, number], polygon: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] ?? [0, 0]
    const [xj, yj] = polygon[j] ?? [0, 0]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function insideMaterial(
  point: [number, number],
  outer: [number, number][],
  holes: [number, number][][],
): boolean {
  if (!pointInPolygon(point, outer)) return false
  for (const hole of holes) if (pointInPolygon(point, hole)) return false
  return true
}

/** Signed area (positive = counter-clockwise). */
function signedArea(points: [number, number][]): number {
  let twice = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j] ?? [0, 0]
    const b = points[i] ?? [0, 0]
    twice += a[0] * b[1] - b[0] * a[1]
  }
  return twice / 2
}

/** Ray (origin + t·dir, t ≥ 0) against one segment; returns `t` when it crosses, else null. */
function raySegmentT(
  origin: [number, number],
  dir: [number, number],
  a: [number, number],
  b: [number, number],
): number | null {
  const ex = b[0] - a[0]
  const ey = b[1] - a[1]
  const det = ex * dir[1] - dir[0] * ey
  if (Math.abs(det) < 1e-12) return null
  const ox = a[0] - origin[0]
  const oy = a[1] - origin[1]
  const t = (ox * -ey - -ex * oy) / det
  const s = (dir[0] * oy - dir[1] * ox) / det
  if (t <= 1e-6 || s < 0 || s > 1) return null
  return t
}

/**
 * The material spans (intervals of `t` along the ray) the beam passes through, ordered. Uses
 * even-odd over the outer outline and its voids, so hollow sections and concave (channel/T)
 * profiles both read correctly.
 */
export function materialSpans(
  outer: [number, number][],
  holes: [number, number][][],
  origin: [number, number],
  dir: [number, number],
  maxDist = MAX_PROBE_MM,
): [number, number][] {
  const cuts: number[] = []
  for (let i = 0; i < outer.length; i++) {
    const t = raySegmentT(origin, dir, outer[i] ?? [0, 0], outer[(i + 1) % outer.length] ?? [0, 0])
    if (t !== null && t <= maxDist) cuts.push(t)
  }
  for (const hole of holes) {
    for (let i = 0; i < hole.length; i++) {
      const t = raySegmentT(origin, dir, hole[i] ?? [0, 0], hole[(i + 1) % hole.length] ?? [0, 0])
      if (t !== null && t <= maxDist) cuts.push(t)
    }
  }
  cuts.sort((a, b) => a - b)
  const bounds = [0, ...cuts, maxDist]
  const spans: [number, number][] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i] ?? 0
    const hi = bounds[i + 1] ?? 0
    if (hi - lo < 1e-6) continue
    const mid: [number, number] = [
      origin[0] + ((lo + hi) / 2) * dir[0],
      origin[1] + ((lo + hi) / 2) * dir[1],
    ]
    if (insideMaterial(mid, outer, holes)) spans.push([lo, hi])
  }
  return spans
}

function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy || 1
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/**
 * Outward normal of the section boundary at `point` (assumed on the outline) — the nearest
 * edge's normal. Used to tell a point that genuinely sits on a face from one at a junction
 * (e.g. the web corner of a channel, which belongs to a different face).
 */
export function nearestEdgeOutwardNormal(
  points: [number, number][],
  point: [number, number],
): [number, number] {
  const ccw = signedArea(points) >= 0
  let best = Number.POSITIVE_INFINITY
  let normal: [number, number] = [0, 0]
  for (let i = 0; i < points.length; i++) {
    const a = points[i] ?? [0, 0]
    const b = points[(i + 1) % points.length] ?? [0, 0]
    const d = distanceToSegment(point, a, b)
    if (d >= best) continue
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    // CCW outward normal is (dy, −dx); flip for a clockwise outline.
    normal = ccw ? [dy / len, -dx / len] : [-dy / len, dx / len]
    best = d
  }
  return normal
}

/**
 * Bevel angle magnitude (deg) at a contour vertex — the largest welding-prep *angle* field that
 * is within the head's ±45° range. Tekla also writes values outside it (e.g. `79.4`) that are
 * not bevel angles; those are ignored rather than mistaken for a near-vertical cut.
 */
function bevelAt(contour: NcContour, index: number): number {
  const values = contour.bevels[index] ?? []
  let best = 0
  for (const angle of [values[0], values[2]]) {
    if (Number.isFinite(angle) && Math.abs(angle as number) <= MAX_BEVEL_DEG) {
      best = Math.max(best, Math.abs(angle as number))
    }
  }
  return best
}

function sameFailure(a: CutReachFailure, b: CutReachFailure): boolean {
  return a.reason === b.reason && a.face === b.face && Math.abs(a.x - b.x) < 1
}

/** Runs the profile cut-reach analysis over an NC file's outer (cut) contours. */
export function assessCutReach(
  ncText: string,
  section: [number, number][],
  holes: [number, number][][] = [],
): CutReachFailure[] {
  return assessCutReachGeometry(parseNcGeometry(ncText), section, holes)
}

/** As {@link assessCutReach} but on already-parsed NC geometry. */
export function assessCutReachGeometry(
  nc: NcGeometry,
  section: [number, number][],
  holes: [number, number][][] = [],
): CutReachFailure[] {
  if (section.length < 3) return []
  const frame = resolveNcFaceFrame(section, nc)
  const failures: CutReachFailure[] = []

  for (const contour of nc.contours) {
    if (contour.kind !== 'outer') continue
    const face = contour.face
    const normal = faceNormal(frame, face)
    const dir = unitComponent(normal.axis, -normal.sign)
    const outward = unitComponent(normal.axis, normal.sign)
    const points = contour.points
    const count = points.length

    for (let i = 0; i < count; i++) {
      const a = points[i] ?? [0, 0]
      const b = points[(i + 1) % count] ?? [0, 0]
      const bevel = Math.max(bevelAt(contour, i), bevelAt(contour, (i + 1) % count))
      // An unbevelled cut is a straight pass through the wall — always reachable in a
      // structural section; only a bevel can push the bore past the pierce cap.
      if (bevel < MIN_BEVEL_DEG) continue
      // Skip degenerate (duplicate-point) edges, then keep only transverse cuts (end / mitre /
      // bevel across a face). A long edge running along the member is the section's own
      // silhouette (or a longitudinal split) — its beam belongs to another face, so probing it
      // here would measure the wrong wall.
      if (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) < 1e-9) continue
      if (Math.abs(b[1] - a[1]) < Math.abs(b[0] - a[0])) continue
      const budget = MAX_CUT_THICKNESS_MM * Math.cos((bevel * Math.PI) / 180)

      let worst: CutReachFailure | null = null
      for (const fraction of EDGE_SAMPLES) {
        const x = a[0] + (b[0] - a[0]) * fraction
        const y = a[1] + (b[1] - a[1]) * fraction
        const cross = placeNcFace(frame, face, x, y).cross
        // Only where the profile boundary actually faces this way (skip junction vertices
        // whose beam would run along an adjacent wall instead of into this face).
        const local = nearestEdgeOutwardNormal(section, cross)
        if (local[0] * outward[0] + local[1] * outward[1] < FACE_ALIGN_DOT) continue

        const spans = materialSpans(section, holes, cross, dir)
        const first = spans[0]
        if (!first) continue

        if (first[1] > budget + 1e-6) {
          const failure: CutReachFailure = {
            reason: 'reach',
            face,
            x,
            entry: cross,
            dir,
            exit: [cross[0] + first[1] * dir[0], cross[1] + first[1] * dir[1]],
            path: first[1] / Math.cos((bevel * Math.PI) / 180),
            bevel,
          }
          if (!worst || failure.path > worst.path) worst = failure
        } else if (spans[1] && (spans[1] as [number, number])[0] < budget - 1e-6) {
          const second = spans[1] as [number, number]
          const failure: CutReachFailure = {
            reason: 'wall',
            face,
            x,
            entry: cross,
            dir,
            exit: [cross[0] + second[0] * dir[0], cross[1] + second[0] * dir[1]],
            path: (second[0] - first[1]) / Math.cos((bevel * Math.PI) / 180),
            bevel,
          }
          if (!worst || failure.path > worst.path) worst = failure
        }
      }
      if (worst && !failures.some((existing) => sameFailure(existing, worst as CutReachFailure))) {
        failures.push(worst)
      }
    }
  }

  return failures
}
