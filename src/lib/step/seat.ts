import { Box3, Matrix4, Quaternion, Vector3 } from 'three'
import { detectOrientation, orientationFit } from '@/lib/sections/orient'
import { principalAxes } from '@/lib/sections/pca'

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
  return {
    primary: new Matrix4().multiplyMatrices(
      inner.primary,
      new Matrix4().multiplyMatrices(memberAlign, new Matrix4().makeRotationFromQuaternion(align)),
    ),
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
  return {
    primary: new Matrix4().multiplyMatrices(inner.primary, align),
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
