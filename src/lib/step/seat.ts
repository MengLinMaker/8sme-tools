import { Box3, Matrix4, Quaternion, Vector3 } from 'three'
import { detectOrientation } from '@/lib/sections/orient'

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

/**
 * Seats a model in `profile`'s canonical frame: rotate its length axis to X, then roll about X
 * so the cross-section matches the profile. Manufactured (NC-built) and STEP models therefore
 * land in the *same* orientation.
 */
export function seatQuaternion(
  vertices: number[],
  profile: [number, number][] | undefined,
): Quaternion {
  if (!profile || profile.length < 3 || vertices.length < 9) return new Quaternion()
  const box = bboxOfVertices(vertices)
  const size = box.getSize(new Vector3())
  const centre = box.getCenter(new Vector3())
  const extents = [size.x, size.y, size.z]
  const longAxis = extents.indexOf(Math.max(...extents))

  const toX = new Quaternion()
  if (longAxis !== 0) toX.setFromUnitVectors(unit(longAxis, 1), unit(0, 1))

  const seated = transformVertices(
    vertices.map((value, index) =>
      // centre first (every 3rd component set is a point)
      index % 3 === 0 ? value - centre.x : index % 3 === 1 ? value - centre.y : value - centre.z,
    ),
    new Matrix4().makeRotationFromQuaternion(toX),
  )
  const roll = new Quaternion().setFromAxisAngle(
    unit(0, 1),
    SEAT_ANGLES[detectOrientation(profile, seated, 1, 2, [0, 0, 0])],
  )
  return new Quaternion().multiplyQuaternions(roll, toX)
}

interface BaseSeat {
  quaternion: Quaternion
  position: Vector3
  matrix: Matrix4
}

/** The seat before the canonical display roll: length to X, rolled to the section, bbox centred. */
function baseSeat(vertices: number[], profile: [number, number][] | undefined): BaseSeat {
  const quaternion = seatQuaternion(vertices, profile)
  const centre = bboxOfVertices(vertices).getCenter(new Vector3())
  const position = centre.clone().applyQuaternion(quaternion).negate()
  return { quaternion, position, matrix: new Matrix4().compose(position, quaternion, UNIT) }
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
): SeatedPair {
  const primary = baseSeat(primaryVertices, profile)
  const compare = compareVertices ? baseSeat(compareVertices, profile) : null
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
  const rolled = (seat: BaseSeat): Matrix4 =>
    new Matrix4().compose(
      seat.position,
      new Quaternion().multiplyQuaternions(roll, seat.quaternion),
      UNIT,
    )
  return {
    primary: rolled(primary),
    compare: compare ? rolled(compare) : null,
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
): Matrix4 {
  const pair = seatedPair(primaryVertices, compareVertices, profile)
  if (!pair.compare) return new Matrix4()
  return new Matrix4().copy(pair.primary).invert().multiply(pair.compare)
}
