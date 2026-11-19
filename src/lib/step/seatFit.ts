import { Matrix4, Quaternion, Vector3 } from 'three'
import type { BrepFace } from './mesh'

/**
 * Stock-plane fitting for seating — the batch-2/3 winner from `docs/seat-alignment.md`.
 *
 * The model's stock faces and the catalogue section's faces are two descriptions of the *same*
 * planes, so seating is a rigid-plane fit, not a shape search. This module is the one place that
 * knows how to
 *   - read a section outline as **flats** (maximal collinear runs, outward normals),
 *   - read a seated model's planar faces the same way, in the viewer's section frame
 *     (`u` = −world Z, `v` = +world Y — the `CANONICAL_X_AXIS` / `CANONICAL_Y_AXIS` frame),
 *   - score a seat (length-weighted offset + normal error), and
 *   - solve one damped roll/translation step.
 *
 * Conventions that cost real debugging, do not change them casually:
 *   - `Flat.point` must be a point **on the face away from its foot point** (a centroid or run
 *     midpoint). The rotation term `n·(δ × p)` is identically zero for the foot point `n·d`, which
 *     leaves the roll unconstrained and made the first solver diverge on item11 (−210°).
 *   - `fitSectionPlanes` returns the **error**, not the correction: apply `−angle`. Feeding it back
 *     with a positive sign doubles the misalignment (item10 fell from perfect to 20 mm).
 */

/** A flat run of a section outline (or of the seated model): outward normal + offset + length. */
export interface Flat {
  /** Outward unit normal in section coordinates `[u, v]`. */
  normal: [number, number]
  /** Signed distance from the section origin along `normal` (mm). */
  offset: number
  /** Length (mm) — the score weight. */
  length: number
  /** A point on the face, away from the plane's foot point (see module note). */
  point: [number, number]
}

/** Polygon area sign: +1 counter-clockwise. */
export function orientation(points: [number, number][]): number {
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as [number, number]
    const b = points[(i + 1) % points.length] as [number, number]
    twice += a[0] * b[1] - b[0] * a[1]
  }
  return twice >= 0 ? 1 : -1
}

/**
 * The catalogue stock faces: maximal runs of collinear outline edges, outward normals only. Arcs
 * (root fillets, tube corners) break the runs, so a UB yields its four outer faces, the two flange
 * undersides and the two web faces — exactly the planes the stock is cut from.
 */
export function sectionFlats(points: [number, number][], minLength = 3): Flat[] {
  const sign = orientation(points)
  const runs: Flat[] = []
  for (let index = 0; index < points.length; index++) {
    const a = points[index] as [number, number]
    const b = points[(index + 1) % points.length] as [number, number]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const length = Math.hypot(dx, dy)
    if (length < 1e-6) continue
    const normal: [number, number] = [(sign * dy) / length, (-sign * dx) / length]
    const offset = normal[0] * a[0] + normal[1] * a[1]
    const last = runs[runs.length - 1]
    if (
      last &&
      Math.abs(last.normal[0] * normal[0] + last.normal[1] * normal[1] - 1) < 1e-5 &&
      Math.abs(last.offset - offset) < 1e-3
    ) {
      last.length += length
      last.point = [
        (last.point[0] + (a[0] + b[0]) / 2) / 2,
        (last.point[1] + (a[1] + b[1]) / 2) / 2,
      ]
    } else {
      runs.push({ normal, offset, length, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] })
    }
  }
  return runs.filter((run) => run.length >= minLength)
}

/** Area of a planar face, from its outer minus inner wires (projected, shoelace). */
export function faceArea(face: BrepFace): number {
  if (face.wires.length === 0) return 0
  const normal = new Vector3(...face.normal).normalize()
  const basis = new Vector3(1, 0, 0)
  if (Math.abs(normal.dot(basis)) > 0.9) basis.set(0, 1, 0)
  const u = new Vector3().crossVectors(normal, basis).normalize()
  const v = new Vector3().crossVectors(normal, u).normalize()
  const areaOf = (wire: { edges: { points: number[] }[] }): number => {
    const points: [number, number][] = []
    for (const edge of wire.edges)
      for (let i = 0; i + 2 < edge.points.length; i += 3) {
        const point = new Vector3(
          edge.points[i] as number,
          edge.points[i + 1] as number,
          edge.points[i + 2] as number,
        )
        points.push([point.dot(u), point.dot(v)])
      }
    if (points.length < 3) return 0
    let twice = 0
    for (let i = 0; i < points.length; i++) {
      const a = points[i] as [number, number]
      const b = points[(i + 1) % points.length] as [number, number]
      twice += a[0] * b[1] - b[0] * a[1]
    }
    return Math.abs(twice) / 2
  }
  const [outer, ...inner] = face.wires
  if (!outer) return 0
  return Math.max(0, areaOf(outer) - inner.reduce((sum, wire) => sum + areaOf(wire), 0))
}

/** Planar model faces as section flats, in the frame produced by `matrix`. */
export function faceFlats(faces: readonly BrepFace[], matrix: Matrix4): Flat[] {
  const rotation = new Quaternion().setFromRotationMatrix(matrix)
  const flats: Flat[] = []
  for (const face of faces) {
    if (!face.planar) continue
    const normal = new Vector3(...face.normal).applyQuaternion(rotation)
    // Stock faces run along the member; anything transverse is an end cut.
    if (Math.abs(normal.x) > 0.1) continue
    // Section frame: `u` = world −Z, `v` = world +Y (the viewer's canonical axes). Projecting onto
    // (y, z) instead reads the part 90° round and scores a perfect seat as broken.
    const u = -normal.z
    const v = normal.y
    const length = Math.hypot(u, v)
    if (length < 1e-6) continue
    const flat: [number, number] = [u / length, v / length]
    const centre = new Vector3(...face.center).applyMatrix4(matrix)
    flats.push({
      normal: flat,
      offset: flat[0] * -centre.z + flat[1] * centre.y,
      length: Math.max(0.001, faceArea(face)),
      point: [-centre.z, centre.y],
    })
  }
  return flats
}

export interface SeatScore {
  /** Length-weighted mean plane offset error (mm). */
  offset: number
  /** Worst plane offset error (mm). */
  worst: number
  /** Length-weighted mean normal error (deg). */
  tilt: number
  /** Catalogue flats with no model face within 20 mm. */
  missing: number
  /** Flats the score was taken over. */
  matched: number
  /** Per-catalogue-flat residuals (mm), in catalogue order — the robust pass filters on these. */
  residuals: number[]
}

const NORMAL_TOL_DEG = 10
const MATCH_TOL_MM = 20

/** Scores a seat against the catalogue stock faces. Lower is better on every field. */
export function scoreSeat(
  catalogue: readonly Flat[],
  model: readonly Flat[],
  normalTolDeg = NORMAL_TOL_DEG,
): SeatScore {
  const cosTol = Math.cos((normalTolDeg * Math.PI) / 180)
  let weighted = 0
  let weight = 0
  let worst = 0
  let tiltWeighted = 0
  let missing = 0
  let matched = 0
  const residuals: number[] = []
  for (const flat of catalogue) {
    let best: { residual: number; angle: number } | null = null
    for (const candidate of model) {
      const dot = flat.normal[0] * candidate.normal[0] + flat.normal[1] * candidate.normal[1]
      if (dot < cosTol) continue
      const residual = Math.abs(candidate.offset - flat.offset)
      if (!best || residual < best.residual)
        best = { residual, angle: (Math.acos(Math.min(1, dot)) * 180) / Math.PI }
    }
    if (!best || best.residual > MATCH_TOL_MM) {
      residuals.push(MATCH_TOL_MM)
      missing++
      weighted += flat.length * MATCH_TOL_MM
      tiltWeighted += flat.length * normalTolDeg
      weight += flat.length
      worst = Math.max(worst, MATCH_TOL_MM)
      continue
    }
    matched++
    residuals.push(best.residual)
    weight += flat.length
    weighted += flat.length * best.residual
    tiltWeighted += flat.length * best.angle
    worst = Math.max(worst, best.residual)
  }
  return {
    offset: weight > 0 ? weighted / weight : Number.POSITIVE_INFINITY,
    worst,
    tilt: weight > 0 ? tiltWeighted / weight : Number.POSITIVE_INFINITY,
    missing,
    matched,
    residuals,
  }
}

/** A section-plane rotation `angle` (u → v), as a world rotation about the member axis. */
export function sectionRotationMatrix(angle: number): Matrix4 {
  // u = −z, v = +y, so a section rotation by `angle` is a world rotation by −angle about +X.
  return new Matrix4().makeRotationX(-angle)
}

/** A section-plane translation `(tu, tv)`, in world coordinates. */
export function sectionTranslation(tu: number, tv: number): Matrix4 {
  return new Matrix4().makeTranslation(0, tv, -tu)
}

/**
 * One association + least-squares step of the section-plane rigid fit. Returns the **error**
 * (`angle` must be negated to apply). Association is by outward normal, then nearest offset, so a
 * parallel cut face cannot drag the fit: each catalogue flat picks its own nearest model plane.
 */
export function fitSectionPlanes(
  catalogue: readonly Flat[],
  model: readonly Flat[],
  normalTolDeg = 20,
  maxResidual = 25,
): { angle: number; tu: number; tv: number; pairs: number; residual: number } | null {
  const cosTol = Math.cos((normalTolDeg * Math.PI) / 180)
  const pairs: {
    normal: [number, number]
    target: number
    point: [number, number]
    weight: number
  }[] = []
  for (const flat of catalogue) {
    let best: { flat: Flat; residual: number } | null = null
    for (const candidate of model) {
      const dot = flat.normal[0] * candidate.normal[0] + flat.normal[1] * candidate.normal[1]
      if (dot < cosTol) continue
      const residual = Math.abs(candidate.offset - flat.offset)
      if (!best || residual < best.residual) best = { flat: candidate, residual }
    }
    if (!best || best.residual > maxResidual) continue
    pairs.push({
      normal: flat.normal,
      target: flat.offset,
      point: best.flat.point,
      weight: Math.max(1, best.flat.length),
    })
  }
  if (pairs.length < 3) return null
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const atb = [0, 0, 0]
  for (const pair of pairs) {
    const [nx, ny] = pair.normal
    const [px, py] = pair.point
    // 2-D rotation by δ moves p to p + δ(−py, px).
    const row = [nx * -py + ny * px, nx, ny]
    const residual = pair.target - (nx * px + ny * py)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) (ata[i] as number[])[j] += pair.weight * row[i]! * row[j]!
      atb[i] += pair.weight * row[i]! * residual
    }
  }
  for (let i = 0; i < 3; i++) (ata[i] as number[])[i] += 1e-9
  const m = ata.map((row, index) => [...row, atb[index] as number])
  for (let column = 0; column < 3; column++) {
    let pivot = column
    for (let row = column + 1; row < 3; row++)
      if (Math.abs(m[row]?.[column] as number) > Math.abs(m[pivot]?.[column] as number)) pivot = row
    if (Math.abs(m[pivot]?.[column] as number) < 1e-12) return null
    ;[m[column], m[pivot]] = [m[pivot] as number[], m[column] as number[]]
    const divisor = m[column]?.[column] as number
    for (let k = column; k <= 3; k++)
      (m[column] as number[])[k] = (m[column] as number[])[k]! / divisor
    for (let row = 0; row < 3; row++) {
      if (row === column) continue
      const factor = m[row]?.[column] as number
      for (let k = column; k <= 3; k++)
        (m[row] as number[])[k] = (m[row] as number[])[k]! - factor * (m[column] as number[])[k]!
    }
  }
  let residual = 0
  for (const pair of pairs) {
    const [nx, ny] = pair.normal
    residual = Math.max(residual, Math.abs(nx * pair.point[0] + ny * pair.point[1] - pair.target))
  }
  return {
    angle: m[0]?.[3] as number,
    tu: m[1]?.[3] as number,
    tv: m[2]?.[3] as number,
    pairs: pairs.length,
    residual,
  }
}
