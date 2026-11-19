import { Box3, Matrix4, Quaternion, Vector3 } from 'three'
import { detectOrientation, orientationFit } from '@/lib/sections/orient'
import { principalAxes } from '@/lib/sections/pca'
import type { BrepFace } from './mesh'
import {
  faceArea,
  faceFlats,
  fitSectionPlanes,
  ransacSectionPose,
  recentreSeat,
  type SeatScore,
  scoreSeat,
  sectionFlats,
  sectionRotationMatrix,
  sectionTranslation,
} from './seatFit'

/**
 * Canonical seating shared by the viewer and the overlay diff.
 *
 * The viewer places the manufactured (NC-built) and STEP models in the section's canonical frame:
 * the member runs along +X and the cross-section is rolled so the section's `+y` (the machine
 * "up" the stance is defined on) points world +Y. {@link seatedPair} returns the two world
 * matrices that do this, so the overlay diff can align the STEP to the manufactured model in the
 * *same* frame the view already draws them in — the diff never reorients independently.
 */

/** Roll about the length axis for each `detectOrientation` result (world YZ → profile-local). */
export const SEAT_ANGLES = [0, -Math.PI / 2, Math.PI, Math.PI / 2]

const UNIT = new Vector3(1, 1, 1)

export function unit(axis: number, sign: number): Vector3 {
  const vector = new Vector3()
  vector.setComponent(axis, sign)
  return vector
}

export function bboxOfVertices(vertices: number[]): Box3 {
  const box = new Box3()
  const point = new Vector3()
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    box.expandByPoint(point.set(vertices[i], vertices[i + 1], vertices[i + 2]))
  }
  return box
}

export function transformVertices(vertices: number[], matrix: Matrix4): number[] {
  const out = new Array<number>(vertices.length)
  const point = new Vector3()
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    point.set(vertices[i], vertices[i + 1], vertices[i + 2]).applyMatrix4(matrix)
    out[i] = point.x
    out[i + 1] = point.y
    out[i + 2] = point.z
  }
  return out
}

/** The cross-section's 2-D points, projected onto (y, z) and subsampled, in `seated`. */
function projectedPoints(seated: number[], stride: number): [number, number][] {
  const points: [number, number][] = []
  for (let i = 0; i + 2 < seated.length; i += stride) {
    points.push([seated[i + 1] as number, seated[i + 2] as number])
  }
  return points
}

/** The 2-D principal-axis angle of a point set in the (y, z) plane. */
function principalAngle2D(points: [number, number][]): number {
  let meanY = 0
  let meanZ = 0
  for (const [y, z] of points) {
    meanY += y
    meanZ += z
  }
  meanY /= points.length || 1
  meanZ /= points.length || 1
  let yy = 0
  let zz = 0
  let yz = 0
  for (const [y, z] of points) {
    const dy = y - meanY
    const dz = z - meanZ
    yy += dy * dy
    zz += dz * dz
    yz += dy * dz
  }
  return 0.5 * Math.atan2(2 * yz, yy - zz)
}

/**
 * Seats a model in `profile`'s canonical frame: rotate its member (length) axis to X, roll the
 * cross-section onto the profile's own principal angle, and settle the 90° multiples. Manufactured
 * (NC-built) and STEP models land in the *same* orientation.
 *
 * The member axis is **not** simply the longest bounding-box extent: a short part (an angle cut to
 * 20 mm, legs 50 mm) has a cross-section dimension longer than its length, and a rotated STEP export
 * puts the member on no world axis at all. So the member axis is taken from the part's **principal
 * axes** (PCA), and the in-plane roll is fixed by matching the cross-section's 2-D principal angle to
 * the profile's — a free roll sweep is ambiguous (a symmetric section fits many ways), but the
 * principal angle is a fixed property of the shape.
 */
export function seatQuaternion(
  vertices: number[],
  profile: [number, number][] | undefined,
): Quaternion {
  if (!profile || profile.length < 3 || vertices.length < 9) return new Quaternion()
  const frame = principalAxes(vertices)
  const candidates: [number, number, number][] = frame
    ? frame.axes
    : [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]
  // Subsample for the fit — the mesh can be huge and the fit only needs the shape.
  const stride = Math.max(3, Math.floor(vertices.length / 3 / 1500) * 3)
  const profileAngle = principalAngle2D(profile)

  let best = new Quaternion()
  let bestFit = -1
  for (const axis of candidates) {
    for (const sign of [1, -1]) {
      const direction = new Vector3(axis[0] * sign, axis[1] * sign, axis[2] * sign)
      const toX = new Quaternion().setFromUnitVectors(direction, unit(0, 1))
      const seated = transformVertices(vertices, new Matrix4().makeRotationFromQuaternion(toX))
      const points = projectedPoints(seated, stride)
      // Roll the cross-section so its principal angle meets the profile's.
      const rollAngle = profileAngle - principalAngle2D(points)
      const rollQuaternion = new Quaternion().setFromAxisAngle(unit(0, 1), rollAngle)
      const rolled = transformVertices(
        seated,
        new Matrix4().makeRotationFromQuaternion(rollQuaternion),
      )
      const seatCentre = bboxOfVertices(rolled).getCenter(new Vector3())
      const centre: [number, number, number] = [0, seatCentre.y, seatCentre.z]
      const orientation = detectOrientation(profile, rolled, 1, 2, centre)
      const fit = orientationFit(profile, orientation, rolled, 1, 2, centre)
      if (fit > bestFit) {
        bestFit = fit
        const finalRoll = new Quaternion().setFromAxisAngle(
          unit(0, 1),
          rollAngle + SEAT_ANGLES[orientation],
        )
        best = new Quaternion().multiplyQuaternions(finalRoll, toX)
      }
    }
  }
  return best
}

/**
 * A model face the seating can trust: structural, so a meshed STEP's `BrepFace` passes straight in
 * (planar, outward normal, a point on it, and its wires for area). A long stock face carries far
 * more weight than a cut end or a hole rim.
 */
export interface SeatFace {
  planar: boolean
  normal: [number, number, number]
  center: [number, number, number]
  wires?: { edges: { points: number[] }[] }[]
}

const CANONICAL_MEMBER = unit(0, 1)
/** Largest stock-frame correction accepted; anything bigger is a mis-read frame (cut vs stock). */
const MAX_STOCK_FIX_RAD = (10 * Math.PI) / 180
/** Damped plane-ICP: fraction of each step taken, and the per-step roll cap (rad). */
const ICP_DAMPING = 0.5
const ICP_MAX_STEP_RAD = 0.12
/**
 * RANSAC inlier thresholds, tightest first (mm). 0.01 mm is achievable on exact geometry — the
 * J12095 UBs score 0.000 mm on every stock plane — but a Tekla flange can sit 0.05–0.12 mm off the
 * catalogue's rounded dims, so the ladder only relaxes when a threshold leaves too few planes to
 * trust. A tight threshold makes the consensus *discriminative*: on item11 the planed flange
 * (4.17–4.22 mm) is excluded at every level, so the pose is decided by the surfaces that agree.
 */
const INLIER_LADDER_MM = [0.1, 0.5, 3]

/**
 * Re-seats a model onto the catalogue **stock planes**.
 *
 * Two stages, both from the geometry rather than the vertex cloud:
 *  1. the section cross comes from the stock faces' normals (a stock face *is* a section plane), and
 *  2. a damped roll/translation ICP then lands those planes on the catalogue's planes.
 *
 * PCA over the mesh vertices mixes in cut faces and tessellation: on a real `UB250*31` it tilted the
 * member 0.14° (12.8 mm of false depth over 5.3 m), and on J12095 item12 it left the part ~9° rolled.
 *
 * The refined seat is only returned when it **scores better** than the seat it started from, so a
 * mis-read frame (a cut face taken for stock, an open section with one dominant face) can never
 * make a part worse — batch 1 of `docs/seat-alignment.md` found exactly that regression with
 * boundary-length weighting on a PFC.
 */
export function seatFromStockFaces(
  vertices: number[],
  faces: readonly SeatFace[],
  matrix: Matrix4,
  section: [number, number][],
): Matrix4 | null {
  if (faces.length < 2 || section.length < 3 || vertices.length < 9) return null
  const catalogue = sectionFlats(section)
  if (catalogue.length < 2) return null
  const brep = faces.map((face) => ({
    ...face,
    wires: face.wires ?? [],
  })) as unknown as BrepFace[]
  const scoreOf = (candidate: Matrix4): SeatScore =>
    scoreSeat(catalogue, faceFlats(brep, candidate))

  /**
   * Every stage below is a *proposal*. Keep the best-scoring one instead of letting the last stage
   * win: measured on J12095, plain ICP after a good RANSAC pose tilts items 11/13 by 2.0–2.5° while
   * leaving the offset identical — the robust pass then has to undo it. Offset is the primary
   * criterion; tilt breaks near-ties (a plane fit's translation null space can keep the offset
   * while the part rotates).
   */
  const better = (candidate: SeatScore, incumbent: SeatScore): boolean =>
    candidate.offset < incumbent.offset - 0.01 ||
    (Math.abs(candidate.offset - incumbent.offset) <= 0.01 &&
      candidate.tilt < incumbent.tilt - 0.05)

  let best = matrix.clone()
  let bestScore = scoreOf(best)
  const consider = (proposal: Matrix4): void => {
    const score = scoreOf(proposal)
    if (better(score, bestScore)) {
      best = proposal
      bestScore = score
    }
  }

  // 1. Global pose: exhaustive plane-pair RANSAC. This is the stage that survives a badly wrong
  // start pose — with a 25 deg roll it still finds 7-8 of 8 stock planes, where ICP cannot move at
  // all (its residual is translation-invariant along the planes it has already matched).
  let global: ReturnType<typeof ransacSectionPose> = null
  for (const inlierMm of INLIER_LADDER_MM) {
    const attempt = ransacSectionPose(catalogue, brep, vertices, matrix, inlierMm)
    if (!global || (attempt?.inliers ?? 0) > global.inliers) global = attempt
    // Tight enough to be meaningful and still backed by at least three surfaces: take it.
    if (attempt && attempt.inliers >= 3 && attempt.matrix) break
  }
  const globalPose = Boolean(global && global.inliers >= 3)
  if (globalPose && global) consider(global.matrix)

  // 2. Member axis + roll straight from the stock-face normals.
  for (const frameSeat of stockFrameSeats(vertices, faces, best)) consider(frameSeat)

  // 3. ICP is now an **escape hatch only**. Measured across all 36 J12095 items, RANSAC alone gives
  // mean offset 0.184 mm / tilt 0.000°; adding the tight-gate ICP leaves the offset identical and
  // the tilt at 0.003° (it never helped once, and degraded item12/13 slightly). So when RANSAC has
  // consensus, nothing is refined — its plane pair is already exact. With no consensus the wide
  // gate is the only way to move at all, and the gate has to stay wide because the start is poor.
  const icp = (start: Matrix4, maxResidual: number, steps: number): Matrix4 => {
    let candidate = start
    for (let iteration = 0; iteration < steps; iteration++) {
      const fit = fitSectionPlanes(catalogue, faceFlats(brep, candidate), 20, maxResidual)
      if (!fit) break
      const step = Math.max(-ICP_MAX_STEP_RAD, Math.min(ICP_MAX_STEP_RAD, fit.angle)) * ICP_DAMPING
      const correction = sectionTranslation(fit.tu, fit.tv).multiply(sectionRotationMatrix(step))
      candidate = recentreSeat(vertices, new Matrix4().copy(correction).multiply(candidate))
      if (Math.abs(fit.angle) < 1e-4 && Math.hypot(fit.tu, fit.tv) < 1e-3) break
    }
    return candidate
  }
  if (!globalPose) consider(icp(best, 25, 24))

  // 4. Robust polish, for the same no-consensus case: drop planes far from the pack and refit on
  // the consistent majority.
  if (!globalPose) {
    const median = medianOf(bestScore.residuals)
    consider(icp(best, Math.max(0.1, median * 2), 6))
  }

  return best
}

/**
 * Candidate seats from the part's stock faces. A stock face's normal is a section axis exactly, and
 * two perpendicular normals span the cross, so `u × v` is the true member direction. Returns one
 * candidate per plausible axis assignment (either of the two heaviest perpendicular normals as the
 * section `x`); the caller scores them, because "heaviest" alone is ambiguous on an open section.
 */
function stockFrameSeats(
  vertices: number[],
  faces: readonly SeatFace[],
  matrix: Matrix4,
): Matrix4[] {
  const rotation = new Quaternion()
  const position = new Vector3()
  const scale = new Vector3()
  matrix.decompose(position, rotation, scale)
  const member = CANONICAL_MEMBER.clone().applyQuaternion(rotation).normalize()

  const groups: { normal: Vector3; weight: number }[] = []
  for (const face of faces) {
    if (!face.planar) continue
    const normal = new Vector3(...face.normal).applyQuaternion(rotation).normalize()
    if (Math.abs(normal.dot(member)) > 0.1) continue
    const weight = Math.max(1, oneFaceArea(face))
    const hit = groups.find((group) => group.normal.dot(normal) > 0.999)
    if (hit) hit.weight += weight
    else groups.push({ normal, weight })
  }
  groups.sort((a, b) => b.weight - a.weight)
  if (groups.length < 2) return []

  const candidates: Matrix4[] = []
  for (const first of groups.slice(0, 3)) {
    const crossing = groups.find(
      (group) => group !== first && Math.abs(group.normal.dot(first.normal)) < 0.3,
    )
    if (!crossing) continue
    const u = first.normal.clone()
    if (u.dot(CANONICAL_X_AXIS) < 0) u.negate()
    const m = new Vector3().crossVectors(first.normal, crossing.normal).normalize()
    if (m.dot(member) < 0) m.negate()
    const v = new Vector3().crossVectors(m, u).normalize()
    const memberAxis = new Vector3().crossVectors(u, v).normalize()
    const target = new Matrix4().makeBasis(CANONICAL_X_AXIS, CANONICAL_Y_AXIS, CANONICAL_MEMBER)
    const source = new Matrix4().makeBasis(u, v, memberAxis)
    const correction = new Matrix4().multiplyMatrices(target, new Matrix4().copy(source).invert())
    const delta = new Quaternion().setFromRotationMatrix(correction)
    const deltaAngle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)))
    if (deltaAngle > MAX_STOCK_FIX_RAD) continue
    const rotated = new Matrix4().copy(correction).multiply(matrix)
    const centre = bboxOfVertices(transformVertices(vertices, rotated))
      .getCenter(new Vector3())
      .negate()
    candidates.push(new Matrix4().compose(centre, delta.multiply(rotation), scale))
  }
  return candidates
}

/** Median of a list (0 when empty). */
function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] as number
}

/** Area of a structural face (planar): outer wire minus inner wires, via its own normal. */
function oneFaceArea(face: SeatFace): number {
  if (!face.wires || face.wires.length === 0) return 1
  return faceArea({ ...face, wires: face.wires } as unknown as BrepFace)
}

/** A rigid transform split into the rotate+translate calls replicad/OCC shapes expose. */
export interface RigidTransform {
  /** Rotation angle (deg) about `axis` through the origin, applied before the translation. */
  angleDeg: number
  axis: [number, number, number]
  position: [number, number, number]
}

/**
 * Splits a rigid {@link Matrix4} (rotation + translation, unit scale) into an axis/angle rotation
 * plus a translation. OCC shapes have no arbitrary-matrix transform, but `rotate` then `translate`
 * reproduces `T · R` exactly — which is what a canonical seat matrix is.
 */
export function rigidFromMatrix(matrix: Matrix4): RigidTransform {
  const position = new Vector3()
  const quaternion = new Quaternion()
  const scale = new Vector3()
  matrix.decompose(position, quaternion, scale)
  const { x, y, z, w } = quaternion
  const sinHalf = Math.hypot(x, y, z)
  const angle = 2 * Math.atan2(sinHalf, w)
  const axis: [number, number, number] =
    sinHalf < 1e-9 ? [0, 0, 1] : [x / sinHalf, y / sinHalf, z / sinHalf]
  return {
    angleDeg: (angle * 180) / Math.PI,
    axis,
    position: [position.x, position.y, position.z],
  }
}

interface BaseSeat {
  quaternion: Quaternion
  position: Vector3
  matrix: Matrix4
}

/** The seat before the canonical display roll: length to X, rolled to the section, bbox centred. */
function baseSeat(vertices: number[], profile: [number, number][] | undefined): BaseSeat {
  const quaternion = seatQuaternion(vertices, profile)
  // Centre on the **seated** bbox: once the member axis is rotated onto X the bbox is the oriented
  // one, so this is the true centre. Centring the raw AABB and *then* rotating would shift a
  // rotated part by the AABB-vs-OBB difference.
  const rotated = transformVertices(vertices, new Matrix4().makeRotationFromQuaternion(quaternion))
  const position = bboxOfVertices(rotated).getCenter(new Vector3()).negate()
  return { quaternion, position, matrix: new Matrix4().compose(position, quaternion, UNIT) }
}

/** Seats `vertices` with `primary`'s rotation, centred on its own geometry (compare model). */
function seatLikePrimary(primary: BaseSeat, vertices: number[]): BaseSeat {
  const rotated = transformVertices(
    vertices,
    new Matrix4().makeRotationFromQuaternion(primary.quaternion),
  )
  const position = bboxOfVertices(rotated).getCenter(new Vector3()).negate()
  return {
    quaternion: primary.quaternion,
    position,
    matrix: new Matrix4().compose(position, primary.quaternion, UNIT),
  }
}

/**
 * Rotation from the NC build frame (section on Y,Z — `reconstructFromNc` extrudes the section this
 * way) to the viewer's canonical display frame: member stays +X, section +x → −Z, section +y → +Y
 * (machine up). A negative quarter-turn about the member.
 */
const CANONICAL_ROLL = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)
/** The display axes that go with {@link CANONICAL_ROLL}. */
export const CANONICAL_X_AXIS = new Vector3(0, 0, -1)
export const CANONICAL_Y_AXIS = new Vector3(0, 1, 0)

/**
 * The analytic seat for an **NC-built** model: the build frame is known, so this is exact — no PCA
 * or profile guess that can tilt/flip it against the stock and the projected cuts.
 */
function canonicalSeat(vertices: number[]): BaseSeat {
  const rotated = transformVertices(
    vertices,
    new Matrix4().makeRotationFromQuaternion(CANONICAL_ROLL),
  )
  const position = bboxOfVertices(rotated).getCenter(new Vector3()).negate()
  return {
    quaternion: CANONICAL_ROLL,
    position,
    matrix: new Matrix4().compose(position, CANONICAL_ROLL, UNIT),
  }
}

/** Grid cell size (mm) for the coarse registration score. */
const SEAT_GRID = 3

function gridKey(x: number, y: number, z: number): string {
  return `${Math.round(x / SEAT_GRID)},${Math.round(y / SEAT_GRID)},${Math.round(z / SEAT_GRID)}`
}

/** A coarse occupancy grid of a vertex cloud. */
function nearSurfaceGrid(vertices: number[]): Set<string> {
  const set = new Set<string>()
  const stride = Math.max(3, Math.floor(vertices.length / 3 / 4000) * 3)
  for (let i = 0; i + 2 < vertices.length; i += stride) {
    set.add(gridKey(vertices[i] as number, vertices[i + 1] as number, vertices[i + 2] as number))
  }
  return set
}

/** Fraction of `vertices` sitting within a cell of `grid` (neighbourhood check). */
function nearSurfaceHit(vertices: number[], grid: Set<string>): number {
  let hit = 0
  let n = 0
  const stride = Math.max(3, Math.floor(vertices.length / 3 / 4000) * 3)
  for (let i = 0; i + 2 < vertices.length; i += stride) {
    n++
    const cx = Math.round((vertices[i] as number) / SEAT_GRID)
    const cy = Math.round((vertices[i + 1] as number) / SEAT_GRID)
    const cz = Math.round((vertices[i + 2] as number) / SEAT_GRID)
    let found = false
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dz = -1; dz <= 1 && !found; dz++) {
          if (grid.has(`${cx + dx},${cy + dy},${cz + dz}`)) found = true
        }
      }
    }
    if (found) hit++
  }
  return n > 0 ? hit / n : 0
}

/** The 24 proper rotations of a cube (quarter-turn products about the world axes), deduped. */
const CUBE_ROTATIONS: Quaternion[] = (() => {
  const ex = new Vector3(1, 0, 0)
  const ey = new Vector3(0, 1, 0)
  const ez = new Vector3(0, 0, 1)
  const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]
  const out: Quaternion[] = []
  const seen = new Set<string>()
  for (const ax of angles) {
    for (const ay of angles) {
      for (const az of angles) {
        const q = new Quaternion()
          .multiply(new Quaternion().setFromAxisAngle(ex, ax))
          .multiply(new Quaternion().setFromAxisAngle(ey, ay))
          .multiply(new Quaternion().setFromAxisAngle(ez, az))
        const sign = q.w < 0 ? -1 : 1
        const key = `${(q.x * sign).toFixed(3)},${(q.y * sign).toFixed(3)},${(q.z * sign).toFixed(3)},${(q.w * sign).toFixed(3)}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(q)
      }
    }
  }
  return out
})()

/** Registers `compareVertices` onto the seated primary by the best of the 24 cubic orientations. */
function alignToPrimary(primaryWorld: number[], compareVertices: number[]): Matrix4 {
  const grid = nearSurfaceGrid(primaryWorld)
  let best = CUBE_ROTATIONS[0] as Quaternion
  let bestPosition = new Vector3()
  let bestHit = -1
  for (const quaternion of CUBE_ROTATIONS) {
    const rotated = transformVertices(
      compareVertices,
      new Matrix4().makeRotationFromQuaternion(quaternion),
    )
    const position = bboxOfVertices(rotated).getCenter(new Vector3()).negate()
    const moved = transformVertices(
      rotated,
      new Matrix4().makeTranslation(position.x, position.y, position.z),
    )
    const hit = nearSurfaceHit(moved, grid)
    if (hit > bestHit) {
      bestHit = hit
      best = quaternion
      bestPosition = position
    }
  }
  return new Matrix4().compose(bestPosition, best, UNIT)
}

/**
 * The seating frame from section detection (`SectionGuess.seat`): rotate by `rotation`, then the
 * member runs along world axis `memberAxis`.
 */
export interface SectionSeat {
  memberAxis: 0 | 1 | 2
  rotation: [number, number, number, number]
  centre: [number, number, number]
}

/**
 * Seats a STEP **on its own** using the section detector's frame (handles an **oblique** member,
 * which a bbox-longest guess cannot). Applies the detector's alignment, maps the member axis to +X,
 * then rolls the section to the profile and re-centres.
 */
export function seatedFromSeat(
  vertices: number[],
  seat: SectionSeat,
  profile: [number, number][] | undefined,
  faces?: readonly SeatFace[],
): SeatedPair {
  const align = new Quaternion(
    seat.rotation[0],
    seat.rotation[1],
    seat.rotation[2],
    seat.rotation[3],
  )
  const aligned = transformVertices(vertices, new Matrix4().makeRotationFromQuaternion(align))
  const toX = new Quaternion().setFromUnitVectors(unit(seat.memberAxis, 1), unit(0, 1))
  const memberAlign = new Matrix4().makeRotationFromQuaternion(toX)
  const inner = seatedPair(transformVertices(aligned, memberAlign), null, profile)
  const primary = new Matrix4().multiplyMatrices(
    inner.primary,
    new Matrix4().multiplyMatrices(memberAlign, new Matrix4().makeRotationFromQuaternion(align)),
  )
  return {
    primary: (faces && profile && seatFromStockFaces(vertices, faces, primary, profile)) || primary,
    compare: null,
    xAxis: inner.xAxis,
    yAxis: inner.yAxis,
    rollAngle: inner.rollAngle,
  }
}

/**
 * Seats a STEP **on its own** (no NC reference). The member axis is the longest bounding-box extent
 * — the same criterion the STEP section detector uses when it slices longest-first — mapped to +X,
 * then the section is rolled to the profile (or a stable principal axis when there is none) by the
 * standard seat. One deterministic rotation, no search.
 */
export function seatedStepProfile(
  vertices: number[],
  profile: [number, number][] | undefined,
  faces?: readonly SeatFace[],
): SeatedPair {
  if (vertices.length < 9) {
    return {
      primary: new Matrix4(),
      compare: null,
      xAxis: CANONICAL_X_AXIS.clone(),
      yAxis: CANONICAL_Y_AXIS.clone(),
      rollAngle: 0,
    }
  }
  const size = bboxOfVertices(vertices).getSize(new Vector3())
  const extents = [size.x, size.y, size.z]
  let member = 0
  if ((extents[1] as number) > (extents[member] as number)) member = 1
  if ((extents[2] as number) > (extents[member] as number)) member = 2
  const toX = new Quaternion().setFromUnitVectors(unit(member, 1), unit(0, 1))
  const align = new Matrix4().makeRotationFromQuaternion(toX)
  const inner = seatedPair(transformVertices(vertices, align), null, profile)
  const primary = new Matrix4().multiplyMatrices(inner.primary, align)
  return {
    primary: (faces && profile && seatFromStockFaces(vertices, faces, primary, profile)) || primary,
    compare: null,
    xAxis: inner.xAxis,
    yAxis: inner.yAxis,
    rollAngle: inner.rollAngle,
  }
}

/** The seated world matrices and the section display axes (`x` = member, `y` = machine up). */
export interface SeatedPair {
  primary: Matrix4
  compare: Matrix4 | null
  xAxis: Vector3
  yAxis: Vector3
  rollAngle: number
}

/**
 * The viewer's canonical seating for a primary model and an optional compare model: both world
 * matrices, plus the section's display axes. The roll is derived from the **primary** model and
 * applied to both, so the two never disagree. One source of truth for `PartViewer` and the overlay
 * diff (`viewerModel.diffForViewer`).
 */
export function seatedPair(
  primaryVertices: number[],
  compareVertices: number[] | null,
  profile: [number, number][] | undefined,
  primaryCanonical = false,
): SeatedPair {
  // An NC-built primary is placed analytically (its frame is known) — exact against the stock ghost
  // and the projected cuts. A STEP primary still needs the heuristic seat.
  const primary = primaryCanonical
    ? canonicalSeat(primaryVertices)
    : baseSeat(primaryVertices, profile)
  // The compare shares the *primary's* rotation (only its own centre) — seating each model from its
  // own vertices could pick different member axes for the same part (mesh density differs), leaving
  // the two models rotated apart in the overlay. One rotation, two centres: they always coincide.
  const compare = compareVertices ? seatLikePrimary(primary, compareVertices) : null
  if (primaryCanonical) {
    // The primary (NC) is exact. The STEP comes in whatever frame Tekla exported (per family it
    // differs: tubes are pre-roll, the tee is already display-oriented), so register it to the
    // primary by the best of the 24 cubic orientations rather than assuming one.
    const compareMatrix = compareVertices
      ? alignToPrimary(transformVertices(primaryVertices, primary.matrix), compareVertices)
      : null
    return {
      primary: primary.matrix,
      compare: compareMatrix,
      xAxis: CANONICAL_X_AXIS.clone(),
      yAxis: CANONICAL_Y_AXIS.clone(),
      rollAngle: 0,
    }
  }
  if (!profile || profile.length < 3 || primaryVertices.length < 9) {
    return {
      primary: primary.matrix,
      compare: compare?.matrix ?? null,
      xAxis: unit(0, 1),
      yAxis: unit(1, 1),
      rollAngle: 0,
    }
  }

  // `detectOrientation` anchors the roll to the model's native orientation, so the section's +y
  // can land on world Z and read on its side. Roll the whole display about the member axis so
  // section +y points world +Y (the viewer's screen up).
  const world = transformVertices(primaryVertices, primary.matrix)
  const orientation = detectOrientation(profile, world, 1, 2, [0, 0, 0])
  const eY = unit(1, 1)
  const eZ = unit(2, 1)
  const table: [Vector3, Vector3][] = [
    [eY, eZ],
    [eZ, eY.clone().negate()],
    [eY.clone().negate(), eZ.clone().negate()],
    [eZ.clone().negate(), eY],
  ]
  const [fx0, fy0] = table[orientation] as [Vector3, Vector3]
  const rollAngle = -Math.atan2(fy0.z, fy0.y)
  const about = new Vector3(1, 0, 0)
  const xAxis = fx0.clone().applyAxisAngle(about, rollAngle)
  const yAxis = fy0.clone().applyAxisAngle(about, rollAngle)
  if (Math.abs(rollAngle) < 1e-6) {
    return { primary: primary.matrix, compare: compare?.matrix ?? null, xAxis, yAxis, rollAngle }
  }
  const roll = new Quaternion().setFromAxisAngle(about, rollAngle)
  // Re-centre **after** the display roll: the roll is about X through the origin, and the base seat
  // had centred the *pre-roll* model, so a section whose rotated bbox-centre is off the member axis
  // (an asymmetric section, or a raw part exported off-origin) would otherwise be translated by the
  // stale pre-roll centre — an offset. Centre on the rolled model itself.
  const rolled = (seat: BaseSeat, verts: number[]): Matrix4 => {
    const quaternion = new Quaternion().multiplyQuaternions(roll, seat.quaternion)
    const rotated = transformVertices(verts, new Matrix4().makeRotationFromQuaternion(quaternion))
    const position = bboxOfVertices(rotated).getCenter(new Vector3()).negate()
    return new Matrix4().compose(position, quaternion, UNIT)
  }
  return {
    primary: rolled(primary, primaryVertices),
    compare: compare && compareVertices ? rolled(compare, compareVertices) : null,
    xAxis,
    yAxis,
    rollAngle,
  }
}

/** Relative transform mapping a compare model's raw frame onto the primary model's raw frame. */
export function relativeSeat(
  primaryVertices: number[],
  compareVertices: number[],
  profile: [number, number][] | undefined,
  primaryCanonical = false,
): Matrix4 {
  const pair = seatedPair(primaryVertices, compareVertices, profile, primaryCanonical)
  if (!pair.compare) return new Matrix4()
  return new Matrix4().copy(pair.primary).invert().multiply(pair.compare)
}
