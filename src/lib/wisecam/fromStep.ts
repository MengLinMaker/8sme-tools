import { Matrix4, Quaternion, Vector3 } from 'three'
import { frameForProfile } from '@/lib/parsers/ncFaces'
import { profileFamily } from '@/lib/sections/canonical'
import type { SeatedBrepFace, Vec3 } from '@/lib/step/cutEdges'
import type { MeshedStep } from '@/lib/step/mesh'
import {
  type SectionSeat,
  seatedFromSeat,
  seatedStepProfile,
  transformVertices,
} from '@/lib/step/seat'
import { unrolledLayout } from './layout'
import { buildNcex, type NcexCut, type NcexPart } from './ncex'
import { developStepCutEdges, type StepSurfaceInput } from './surface'

/**
 * STEP → NCEP — the second consumer of the shared **surface** layer.
 *
 * The STEP path starts from the real part's cut edges, projects them onto the stock faces
 * (`projectCutEdgesToFaces`, the same "on the surface / on the stock face" rule the viewer uses),
 * and then develops those face-space traces with the same `developFaceSegments` used by the NC
 * path. This file is the **scaffold**: cut boundaries are developed; holes/marks and the shaped
 * start/end trim extraction follow once the NC path has settled on the shared representation.
 *
 * Pure (no OCC): the caller seats the STEP and passes its B-rep faces. That keeps the conversion
 * testable and debuggable separately from the worker/kernel plumbing.
 */

const TYPE_CODE: Record<string, number> = { I: 8200, U: 8199, M: 8195 }

/** DSTV profile letter for a catalogue profile code (`200UB25.4`, `PFC250*90`, `SHS89*89*5`). */
export function profileTypeFor(profile: string): string {
  switch (profileFamily(profile)) {
    case 'i':
      return 'I'
    case 'channel':
      return 'U'
    case 'tube':
      return 'M'
    case 'tee':
      return 'T'
    case 'angle':
      return 'L'
    case 'round':
      return 'RO'
    default:
      return 'M'
  }
}

export interface FromStepOptions {
  /** Part mark written into the NCEP. */
  mark: string
  /** Catalogue profile code, e.g. `SHS89*89*5`. */
  profile: string
  /** DSTV-header dimensions (`[depth, flange, tf, tw, r]` for I/U; `[w, h, wall, wall, r]` for M). */
  dimensions: number[]
  /** Member length (mm). */
  length: number
  quantity?: number
  /** Outer stock section in the canonical stance. */
  section: [number, number][]
  /** Inner stock section for hollows, when known. */
  innerSection?: [number, number][]
  /** Outer corner radius (mm) for rounded-corner cut projection. */
  radius?: number
  /** Origin shift from the seated model to the piece start (usually `-minAlong`). */
  alongOffset?: number
  stockLength?: number
}

/**
 * Develop a seated STEP part's cut edges onto the unrolled NCEP surface. This is the shared STEP
 * core: no NCEP part is assembled yet, so it can be used on its own for a surface overlay/debug.
 */
export function developStepSurface(
  input: StepSurfaceInput,
  options: FromStepOptions,
): NcexCut[] | null {
  const profileType = profileTypeFor(options.profile)
  const layout = unrolledLayout(profileType, options.dimensions)
  if (!layout) return null
  return developStepCutEdges(
    { ...input, layout },
    { radius: options.radius, alongOffset: options.alongOffset },
  )
}

/** A STEP's B-rep seated into the canonical profile stance, ready for surface development. */
export interface SeatedStepGeometry {
  faces: SeatedBrepFace[]
  xAxis: Vec3
  yAxis: Vec3
  memberAxis: Vec3
  /** `-minAlong`: maps the centred seated model onto the piece's 0…length axis. */
  alongOffset: number
  length: number
}

/** Fit the seated stock faces onto the spec section planes with a scale-1 rigid transform. */
function fitStockFacesToSection(
  faces: SeatedBrepFace[],
  section: [number, number][],
  xAxis: Vec3,
  yAxis: Vec3,
): void {
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of section) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const planes: { normal: Vec3; offset: number }[] = [
    { normal: xAxis, offset: maxX },
    { normal: [-xAxis[0], -xAxis[1], -xAxis[2]], offset: -minX },
    { normal: yAxis, offset: maxY },
    { normal: [-yAxis[0], -yAxis[1], -yAxis[2]], offset: -minY },
  ]
  const solve3 = (matrix: number[][], rhs: number[]): number[] | null => {
    const a = matrix.map((row, index) => [...row, rhs[index] as number])
    for (let column = 0; column < 3; column++) {
      let pivot = column
      for (let row = column + 1; row < 3; row++)
        if (Math.abs(a[row]?.[column] as number) > Math.abs(a[pivot]?.[column] as number))
          pivot = row
      if (Math.abs(a[pivot]?.[column] as number) < 1e-10) return null
      ;[a[column], a[pivot]] = [a[pivot] as number[], a[column] as number[]]
      const divisor = a[column]?.[column] as number
      for (let k = column; k <= 3; k++)
        (a[column] as number[])[k] = (a[column] as number[])[k]! / divisor
      for (let row = 0; row < 3; row++) {
        if (row === column) continue
        const factor = a[row]?.[column] as number
        for (let k = column; k <= 3; k++)
          (a[row] as number[])[k] = (a[row] as number[])[k]! - factor * (a[column] as number[])[k]!
      }
    }
    return a.map((row) => row[3] as number)
  }
  const apply = (quaternion: Quaternion, translation: Vector3): void => {
    const transform = (value: Vec3): Vec3 => {
      const rotated = new Vector3(value[0], value[1], value[2]).applyQuaternion(quaternion)
      return [rotated.x + translation.x, rotated.y + translation.y, rotated.z + translation.z]
    }
    for (const face of faces) {
      face.center = transform(face.center)
      face.normal = new Vector3(face.normal[0], face.normal[1], face.normal[2])
        .applyQuaternion(quaternion)
        .toArray() as Vec3
      const samples: number[] = []
      for (let index = 0; index + 2 < face.samples.length; index += 3) {
        const point = transform([
          face.samples[index] as number,
          face.samples[index + 1] as number,
          face.samples[index + 2] as number,
        ])
        samples.push(point[0], point[1], point[2])
      }
      face.samples = samples
      if (face.cylinder)
        face.cylinder = {
          ...face.cylinder,
          center: transform(face.cylinder.center),
          axis: new Vector3(face.cylinder.axis[0], face.cylinder.axis[1], face.cylinder.axis[2])
            .applyQuaternion(quaternion)
            .toArray() as Vec3,
        }
      for (const wire of face.wires)
        for (const edge of wire.edges) {
          const points: number[] = []
          for (let index = 0; index + 2 < edge.points.length; index += 3) {
            const point = transform([
              edge.points[index] as number,
              edge.points[index + 1] as number,
              edge.points[index + 2] as number,
            ])
            points.push(point[0], point[1], point[2])
          }
          edge.points = points
        }
    }
  }

  for (let iteration = 0; iteration < 3; iteration++) {
    const pairs: { normal: Vec3; offset: number; center: Vec3 }[] = []
    for (const face of faces) {
      if (!face.planar) continue
      if (Math.abs(dot(face.normal, xAxis)) < 0.98 && Math.abs(dot(face.normal, yAxis)) < 0.98)
        continue
      let plane: (typeof planes)[number] | null = null
      let score = 0.98
      for (const entry of planes) {
        const alignment = dot(face.normal, entry.normal)
        if (alignment > score) {
          score = alignment
          plane = entry
        }
      }
      if (!plane) continue
      if (Math.abs(dot(face.center, plane.normal) - plane.offset) > 3) continue
      pairs.push({ normal: plane.normal, offset: plane.offset, center: face.center })
    }
    if (pairs.length < 3) return
    const normalMatrix: number[][] = Array.from({ length: 3 }, () => [0, 0, 0])
    const normalRhs = [0, 0, 0]
    for (const face of faces) {
      if (!face.planar) continue
      let pair: (typeof pairs)[number] | null = null
      for (const entry of pairs)
        if (dot(face.normal, entry.normal) > 0.98) {
          pair = entry
          break
        }
      if (!pair) continue
      const n = face.normal
      const r: Vec3 = [pair.normal[0] - n[0], pair.normal[1] - n[1], pair.normal[2] - n[2]]
      const rows = [
        [0, -n[2], n[1]],
        [n[2], 0, -n[0]],
        [-n[1], n[0], 0],
      ]
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
          for (let other = 0; other < 3; other++)
            normalMatrix[column]![other]! +=
              (rows[row] as number[])[column]! * (rows[row] as number[])[other]!
        }
        for (let column = 0; column < 3; column++)
          normalRhs[column]! += (rows[row] as number[])[column]! * r[row]!
      }
    }
    const solved = solve3(normalMatrix, normalRhs)
    if (!solved) return
    const omega = solved.map((value) => -(value as number))
    const angle = Math.hypot(omega[0] as number, omega[1] as number, omega[2] as number)
    if (angle > 0.05) return
    const axis =
      angle > 1e-12
        ? new Vector3(
            (omega[0] as number) / angle,
            (omega[1] as number) / angle,
            (omega[2] as number) / angle,
          )
        : new Vector3(0, 1, 0)
    const quaternion = new Quaternion().setFromAxisAngle(axis, angle)

    const translationMatrix: number[][] = Array.from({ length: 3 }, () => [0, 0, 0])
    const translationRhs = [0, 0, 0]
    for (const pair of pairs) {
      const rotated = new Vector3(pair.center[0], pair.center[1], pair.center[2]).applyQuaternion(
        quaternion,
      )
      const b = pair.offset - dot(pair.normal, [rotated.x, rotated.y, rotated.z])
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++)
          translationMatrix[row]![column]! += pair.normal[row]! * pair.normal[column]!
        translationRhs[row]! += pair.normal[row]! * b
      }
    }
    // Planes do not constrain translation along the member; regularise that null direction.
    for (let index = 0; index < 3; index++) (translationMatrix[index] as number[])[index]! += 1e-6
    const translation = solve3(translationMatrix, translationRhs)
    if (!translation) return
    apply(
      quaternion,
      new Vector3(translation[0] as number, translation[1] as number, translation[2] as number),
    )
  }
}

/** Seat a meshed STEP to the stock section and flatten its B-rep into the model frame. */
export function seatedStepGeometry(
  meshed: MeshedStep,
  section: [number, number][],
  seat?: SectionSeat | null,
): SeatedStepGeometry {
  const seated = seat
    ? seatedFromSeat(meshed.vertices, seat, section)
    : seatedStepProfile(meshed.vertices, section)
  const quaternion = new Quaternion()
  const position = new Vector3()
  const scale = new Vector3()
  seated.primary.decompose(position, quaternion, scale)
  const rotation = new Matrix4().makeRotationFromQuaternion(quaternion)
  const transformed = transformVertices(meshed.vertices, seated.primary)
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  for (let i = 0; i + 2 < transformed.length; i += 3) {
    minX = Math.min(minX, transformed[i] as number)
    maxX = Math.max(maxX, transformed[i] as number)
  }
  const faces: SeatedBrepFace[] = meshed.bodies.flatMap((body) =>
    (body.brep ?? []).map((face) => {
      const normal = new Vector3(...face.normal).applyQuaternion(quaternion)
      const center = new Vector3(...face.center).applyMatrix4(seated.primary)
      const cylinder = face.cylinder
        ? {
            center: new Vector3(...face.cylinder.center).applyMatrix4(seated.primary).toArray() as [
              number,
              number,
              number,
            ],
            axis: new Vector3(...face.cylinder.axis).applyQuaternion(quaternion).toArray() as [
              number,
              number,
              number,
            ],
            radius: face.cylinder.radius,
          }
        : undefined
      return {
        normal: [normal.x, normal.y, normal.z],
        cylinder,
        center: [center.x, center.y, center.z],
        planar: face.planar,
        samples: transformVertices(face.samples, seated.primary),
        wires: face.wires.map((wire) => ({
          enclosed: wire.enclosed,
          edges: wire.edges.map((edge) => ({
            points: transformVertices(edge.points, seated.primary),
            neighbours: edge.neighbours,
            curveType: edge.curveType,
            neighbourNormals: edge.neighbourNormals?.map((normals) =>
              normals ? transformVertices(normals, rotation) : undefined,
            ),
          })),
        })),
      }
    }),
  )
  fitStockFacesToSection(
    faces,
    section,
    [seated.xAxis.x, seated.xAxis.y, seated.xAxis.z],
    [seated.yAxis.x, seated.yAxis.y, seated.yAxis.z],
  )
  // Normalise every cylindrical cut centre to the point where its axis meets the entry stock
  // face. The raw OCC centre is somewhere on the axis (mid-wall/arbitrary station); the NC and the
  // IR both mean the face intersection.
  const xAxis3: Vec3 = [seated.xAxis.x, seated.xAxis.y, seated.xAxis.z]
  const yAxis3: Vec3 = [seated.yAxis.x, seated.yAxis.y, seated.yAxis.z]
  let centroidX = 0
  let centroidY = 0
  for (const point of section) {
    centroidX += point[0]
    centroidY += point[1]
  }
  centroidX /= section.length || 1
  centroidY /= section.length || 1
  const centroid3: Vec3 = [
    centroidX * xAxis3[0] + centroidY * yAxis3[0],
    centroidX * xAxis3[1] + centroidY * yAxis3[1],
    centroidX * xAxis3[2] + centroidY * yAxis3[2],
  ]
  const normals: Vec3[] = [
    xAxis3,
    [-xAxis3[0], -xAxis3[1], -xAxis3[2]],
    yAxis3,
    [-yAxis3[0], -yAxis3[1], -yAxis3[2]],
  ]
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const facePlanes = normals.map((normal) => {
    let offset = Number.NEGATIVE_INFINITY
    for (const point of section) {
      const value = point[0] * dot(xAxis3, normal) + point[1] * dot(yAxis3, normal)
      offset = Math.max(offset, value)
    }
    return { normal, offset }
  })
  faces.forEach((face) => {
    if (!face.cylinder) return
    const center = face.cylinder.center
    // Prefer the actual adjacent planar stock face. Its plane is exact; the bbox plane is only a
    // fallback when topology is unavailable.
    const neighbours = new Set<number>()
    for (const wire of face.wires)
      for (const edge of wire.edges)
        for (const neighbour of edge.neighbours ?? []) neighbours.add(neighbour)
    let bestNormal: Vec3 | null = null
    let bestOffset = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (const neighbourIndex of neighbours) {
      const neighbour = faces[neighbourIndex]
      if (!neighbour?.planar) continue
      const normal = neighbour.normal as Vec3
      const alignment = Math.abs(dot(normal, face.cylinder.axis))
      if (alignment < 0.5) continue
      const outward = dot(normal, [
        center[0] - centroid3[0],
        center[1] - centroid3[1],
        center[2] - centroid3[2],
      ])
      const score = alignment + outward * 0.001
      if (score > bestScore) {
        bestScore = score
        bestNormal = normal
        bestOffset = dot(neighbour.center, normal)
      }
    }
    if (!bestNormal) {
      const fallback = facePlanes[0] as (typeof facePlanes)[number]
      let fallbackScore = Number.NEGATIVE_INFINITY
      for (const plane of facePlanes) {
        const score = dot(plane.normal, [
          center[0] - centroid3[0],
          center[1] - centroid3[1],
          center[2] - centroid3[2],
        ])
        if (score > fallbackScore) {
          fallbackScore = score
          bestNormal = plane.normal
          bestOffset = plane.offset
        }
      }
      void fallback
    }
    if (!bestNormal) return
    const denom = dot(face.cylinder.axis, bestNormal)
    if (Math.abs(denom) < 0.05) return
    const t = (bestOffset - dot(center, bestNormal)) / denom
    face.cylinder.center = [
      center[0] + t * face.cylinder.axis[0],
      center[1] + t * face.cylinder.axis[1],
      center[2] + t * face.cylinder.axis[2],
    ]
  })
  return {
    faces,
    xAxis: [seated.xAxis.x, seated.xAxis.y, seated.xAxis.z],
    yAxis: [seated.yAxis.x, seated.yAxis.y, seated.yAxis.z],
    memberAxis: [1, 0, 0],
    alongOffset: -minX,
    length: maxX - minX,
  }
}

/**
 * Build a partial NCEP part from STEP cut boundaries. Holes, marks and shaped end trims are the
 * next step; until then the writer falls back to straight start/end cuts.
 */
export function partFromStepSurface(
  input: StepSurfaceInput,
  options: FromStepOptions,
): NcexPart | null {
  const profileType = profileTypeFor(options.profile)
  const layout = unrolledLayout(profileType, options.dimensions)
  if (!layout) return null
  const cuts = developStepCutEdges(
    { ...input, layout },
    { radius: options.radius, alongOffset: options.alongOffset },
  )
  const [, , legThickness, thickness] = options.dimensions
  return {
    mark: options.mark,
    profile: options.profile,
    profileType,
    typeCode: TYPE_CODE[profileType] ?? 8195,
    length: options.length,
    quantity: options.quantity ?? 1,
    thickness: thickness ?? 0,
    legThickness: profileType === 'M' ? 2 : (legThickness ?? 0),
    section: options.section,
    innerSection: options.innerSection,
    holes: [],
    marks: [],
    cuts,
    unrolledPerimeter: layout.seam,
    unrolled: layout,
    stockLength: options.stockLength,
    rCornerMaxRadius: profileType === 'M' ? (options.radius ?? 0) : 5,
    rootRadius: options.radius ?? 0,
  }
}

/**
 * Convenience wrapper for already-meshed STEP bytes (the viewer's exporter uses this): seat the
 * geometry, build the face frame from the catalogue section, then run the same surface core.
 */
export function partFromStepMesh(meshed: MeshedStep, options: FromStepOptions): NcexPart | null {
  const profileType = profileTypeFor(options.profile)
  const layout = unrolledLayout(profileType, options.dimensions)
  if (!layout) return null
  const seated = seatedStepGeometry(meshed, options.section)
  const frame = frameForProfile(options.profile, options.section)
  return partFromStepSurface(
    { ...seated, section: options.section, frame, layout },
    {
      ...options,
      length: options.length || seated.length,
      alongOffset: options.alongOffset ?? seated.alongOffset,
    },
  )
}

/** Scaffold STEP→NCEP writer. Shaped ends/holes/marks are not generated yet. */
export function buildNcepFromStepSurface(
  input: StepSurfaceInput,
  options: FromStepOptions,
): Uint8Array | null {
  const part = partFromStepSurface(input, options)
  return part ? buildNcex([part], { flavour: 'ncep' }) : null
}

/** Scaffold STEP→NCEP writer from meshed STEP bytes. */
export function buildNcepFromStepMesh(
  meshed: MeshedStep,
  options: FromStepOptions,
): Uint8Array | null {
  const part = partFromStepMesh(meshed, options)
  return part ? buildNcex([part], { flavour: 'ncep' }) : null
}
