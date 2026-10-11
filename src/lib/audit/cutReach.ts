import { MACHINE } from '@/lib/machine/profile'
import { faceNormal, faceSpanAxis, placeNcFace, resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
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
 * face's surface point and fires straight in (the face's inward normal); a bevel tilts the beam
 * out of the section plane, which only *shortens* its in-plane reach (`× cosβ`) — it does not
 * bend it in the section. So the test is one 2D ray per cut, no per-part OCC:
 *
 *   path = material the beam bores at that point
 *   clean ⟺ path / cosβ ≤ MAX_CUT_THICKNESS_MM (and no further wall is within that reach)
 *
 * Every cut is tested (a near-square pass through a *thick/deep-backed* region is just as
 * unreachable as a bevel): a PFC end cut across the flange over the web, or an angle across its
 * other leg, flags; an RHS/SHS cut only ever meets a thin wall, so it clears. Samples that lie in
 * the grazing band around a section vertex, or off the outline (on a rounded corner), are dropped
 * — the kerf/nozzle absorbs a feature that close to the cut line (see `CORNER_BAND_MM`).
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
 * Corner band (mm): a sample closer than this to a section vertex is skipped, because the local
 * wall is ill-defined there and any ray grazes — the kerf/spot physically absorbs a feature that
 * close to the cut line. Derived from the assist-gas nozzle (a real machine dimension): half the
 * aperture. Distinct from the kerf (the focused slot), which is what `LASER_KERF` models.
 */
const CORNER_BAND_MM = MACHINE.envelope.nozzleMm / 2

/**
 * Spacing (mm) between samples taken along a cut edge. Fine enough to bound the ends of an
 * uncuttable subsection to ~1 mm, which is what the red span marker is drawn from.
 */
const SAMPLE_STEP_MM = 1

export interface CutReachFailure {
  /**
   * `reach`: the beam bottoms out inside the material. `wall`: it would cut a wall behind.
   * `corner`: the cut is nominally on the flat face but a ±tolerance shift carries it onto the
   * section's corner radius, where the beam meets the curved surface at a bevel with no flat escape.
   */
  reason: 'reach' | 'wall' | 'corner'
  face: NcFace
  /** start of the uncuttable subsection of the cut, in NC face coords `[X, Y]` */
  from: [number, number]
  /** end of the uncuttable subsection of the cut, in NC face coords `[X, Y]` */
  to: [number, number]
  /** length of the uncuttable subsection along the cut (mm) */
  spanMm: number
  /** where along the member the beam enters (NC X) at the representative (worst) sample */
  x: number
  /** section-frame point the beam enters at (on the face plane), at the worst sample */
  entry: [number, number]
  /** section-frame unit direction the beam travels (the face's inward normal) */
  dir: [number, number]
  /** section-frame point the beam leaves the material (entry + path·dir), at the worst sample */
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
 * Distance from `point` to the nearest section vertex (corner). Used to exclude the grazing band
 * around a junction, where the local wall is ill-defined.
 */
export function nearestVertexDistance(points: [number, number][], point: [number, number]): number {
  let best = Number.POSITIVE_INFINITY
  for (const v of points) {
    const d = Math.hypot(point[0] - v[0], point[1] - v[1])
    if (d < best) best = d
  }
  return best
}

/**
 * Distance from `point` to the section boundary. A face-plane point belongs to a flat wall only
 * where the outline actually reaches the face plane; on a rounded corner the outline curves
 * inside it, so the point sits off the material — the beam there grazes and must not be tested.
 */
export function distanceToOutline(points: [number, number][], point: [number, number]): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < points.length; i++) {
    const d = distanceToSegment(
      point,
      points[i] ?? [0, 0],
      points[(i + 1) % points.length] ?? [0, 0],
    )
    if (d < best) best = d
  }
  return best
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
  return (
    a.reason === b.reason &&
    a.face === b.face &&
    Math.hypot(a.from[0] - b.from[0], a.from[1] - b.from[1]) < 1 &&
    Math.hypot(a.to[0] - b.to[0], a.to[1] - b.to[1]) < 1
  )
}

/** One probe along a cut edge: its status and (for a failure) the bore it would need. */
interface Probe {
  x: number
  y: number
  cross: [number, number]
  status: 'clean' | 'reach' | 'wall' | 'corner' | 'skip'
  path: number
  entry: [number, number]
  exit: [number, number]
}

export interface CutReachOptions {
  /**
   * Placement tolerance (mm) applied **perpendicular to the cut direction**, in the face plane.
   * Only the across-face component moves the ray entry in the section (it is prismatic along the
   * member). Each sample is tested at `0, ±tol` (and the midpoints); a cut that is nominally on
   * the flat face but whose shifted copy lands on the corner radius is a **corner** failure.
   * Defaults to `0` (the line exactly); production passes `MACHINE.placementToleranceMm`.
   */
  toleranceMm?: number
}

/** Failure status ordering: a failure beats a clean cut beats an off-material / curve sample. */
function probeRank(status: Probe['status']): number {
  return status === 'skip' ? 0 : status === 'clean' ? 1 : 2
}

/** Runs the profile cut-reach analysis over an NC file's outer (cut) contours. */
export function assessCutReach(
  ncText: string,
  section: [number, number][],
  holes: [number, number][][] = [],
  options: CutReachOptions = {},
): CutReachFailure[] {
  return assessCutReachGeometry(parseNcGeometry(ncText), section, holes, options)
}

/** As {@link assessCutReach} but on already-parsed NC geometry. */
export function assessCutReachGeometry(
  nc: NcGeometry,
  section: [number, number][],
  holes: [number, number][][] = [],
  options: CutReachOptions = {},
): CutReachFailure[] {
  if (section.length < 3) return []
  const frame = resolveNcFaceFrame(section, nc)
  const failures: CutReachFailure[] = []
  const tol = options.toleranceMm ?? 0
  const offsets = tol > 0 ? [-tol, -tol / 2, 0, tol / 2, tol] : [0]

  for (const contour of nc.contours) {
    if (contour.kind !== 'outer') continue
    const face = contour.face
    const normal = faceNormal(frame, face)
    const dir = unitComponent(normal.axis, -normal.sign)
    const outward = unitComponent(normal.axis, normal.sign)
    const span = faceSpanAxis(frame, face)
    const points = contour.points
    const count = points.length

    /** Classify one ray entry point on the face plane. */
    const classify = (
      cross: [number, number],
      x: number,
      y: number,
      budget: number,
      cosBevel: number,
    ): Probe => {
      const skip: Probe = { x, y, cross, status: 'skip', path: 0, entry: cross, exit: cross }
      // Near a section vertex the wall is ill-defined and the ray grazes; the kerf/nozzle
      // absorbs a feature that close to the cut line.
      if (nearestVertexDistance(section, cross) < CORNER_BAND_MM) return skip
      // On a rounded corner the face plane runs outside the material — the entry is on the curve.
      if (distanceToOutline(section, cross) > 0.3) {
        return { x, y, cross, status: 'corner', path: 0, entry: cross, exit: cross }
      }
      // Only where the profile boundary actually faces this way (not an adjacent wall).
      const local = nearestEdgeOutwardNormal(section, cross)
      if (local[0] * outward[0] + local[1] * outward[1] < FACE_ALIGN_DOT) return skip
      const spans = materialSpans(section, holes, cross, dir)
      const first = spans[0]
      if (!first) return skip
      if (first[1] > budget + 1e-6) {
        return {
          x,
          y,
          cross,
          status: 'reach',
          path: first[1] / cosBevel,
          entry: cross,
          exit: [cross[0] + first[1] * dir[0], cross[1] + first[1] * dir[1]],
        }
      }
      if (spans[1] && (spans[1] as [number, number])[0] < budget - 1e-6) {
        const second = spans[1] as [number, number]
        return {
          x,
          y,
          cross,
          status: 'wall',
          path: (second[0] - first[1]) / cosBevel,
          entry: cross,
          exit: [cross[0] + second[0] * dir[0], cross[1] + second[0] * dir[1]],
        }
      }
      return { x, y, cross, status: 'clean', path: first[1] / cosBevel, entry: cross, exit: cross }
    }

    for (let i = 0; i < count; i++) {
      const a = points[i] ?? [0, 0]
      const b = points[(i + 1) % count] ?? [0, 0]
      const bevel = Math.max(bevelAt(contour, i), bevelAt(contour, (i + 1) % count))
      // Skip degenerate (duplicate-point) edges, then keep only transverse cuts (end / mitre /
      // bevel across a face). A long edge running along the member is the section's own
      // silhouette (or a longitudinal split) — its beam belongs to another face, so probing it
      // here would measure the wrong wall.
      if (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) < 1e-9) continue
      if (Math.abs(b[1] - a[1]) < Math.abs(b[0] - a[0])) continue
      const budget = MAX_CUT_THICKNESS_MM * Math.cos((bevel * Math.PI) / 180)
      const cosBevel = Math.cos((bevel * Math.PI) / 180)

      // Dense sample along the edge, then group the failing probes into contiguous runs — each
      // run is the subsection of the cut that is unreachable.
      const edgeLen = Math.hypot(b[0] - a[0], b[1] - a[1])
      // Placement error is perpendicular to the cut direction, in the face plane. Only its
      // across-face component moves the ray entry in the section — the component along the
      // member does not, because the section is prismatic. A transverse end cut (Δx≈0) therefore
      // barely shifts; a longitudinal cut (Δy≈0) gets the full shift.
      const perpWeight = edgeLen > 0 ? Math.abs(b[0] - a[0]) / edgeLen : 0
      const steps = Math.min(400, Math.max(4, Math.round(edgeLen / SAMPLE_STEP_MM)))
      const probes: Probe[] = []
      for (let k = 0; k <= steps; k++) {
        const t = k / steps
        const x = a[0] + (b[0] - a[0]) * t
        const y = a[1] + (b[1] - a[1]) * t
        const base = placeNcFace(frame, face, x, y).cross
        const baseProbe = classify(base, x, y, budget, cosBevel)
        // A cut already on the curve at the nominal position is a legitimate fillet crossing
        // (e.g. a transverse end cut); it is not a tolerance failure, so it is exempt.
        const baseOnCurve = baseProbe.status === 'corner'
        let chosen: Probe = baseOnCurve ? { ...baseProbe, status: 'skip' } : baseProbe
        for (const off of offsets) {
          if (off === 0) continue
          const cross: [number, number] = [base[0], base[1]]
          cross[span] += off * perpWeight
          const probe = classify(cross, x, y, budget, cosBevel)
          // Off the flat face: a failure only when the nominal cut was on the flat — i.e. when the
          // tolerance itself carried the cut onto the corner radius.
          const status: Probe['status'] =
            probe.status === 'corner' ? (baseOnCurve ? 'skip' : 'corner') : probe.status
          const candidate: Probe = { ...probe, status }
          if (
            probeRank(status) > probeRank(chosen.status) ||
            (probeRank(status) === 2 &&
              probeRank(chosen.status) === 2 &&
              candidate.path > chosen.path)
          ) {
            chosen = candidate
          }
        }
        probes.push(chosen)
      }

      // Contiguous failing runs → one failure per uncuttable subsection.
      let run: Probe[] = []
      const flush = () => {
        if (run.length === 0) return
        const worst = run.reduce((p, q) => (q.path > p.path ? q : p))
        const first = run[0] as Probe
        const last = run[run.length - 1] as Probe
        const spanMm = Math.hypot(last.x - first.x, last.y - first.y)
        const failure: CutReachFailure = {
          reason: worst.status === 'wall' ? 'wall' : worst.status === 'corner' ? 'corner' : 'reach',
          face,
          from: [first.x, first.y],
          to: [last.x, last.y],
          spanMm,
          x: worst.x,
          entry: worst.entry,
          dir,
          exit: worst.exit,
          path: worst.path,
          bevel,
        }
        if (!failures.some((existing) => sameFailure(existing, failure))) failures.push(failure)
        run = []
      }
      for (const probe of probes) {
        if (probe.status === 'reach' || probe.status === 'wall' || probe.status === 'corner') {
          run.push(probe)
        } else flush()
      }
      flush()
    }
  }

  return failures
}
