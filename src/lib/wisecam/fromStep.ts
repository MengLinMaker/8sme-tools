import { Matrix4, Quaternion, Vector3 } from 'three'
import { frameForProfile } from '@/lib/parsers/ncFaces'
import { profileFamily } from '@/lib/sections/canonical'
import type { SeatedBrepFace, Vec3 } from '@/lib/step/cutEdges'
import type { MeshedStep } from '@/lib/step/mesh'
import { seatedStepProfile, transformVertices } from '@/lib/step/seat'
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

/** Seat a meshed STEP to the stock section and flatten its B-rep into the model frame. */
export function seatedStepGeometry(
  meshed: MeshedStep,
  section: [number, number][],
): SeatedStepGeometry {
  const seated = seatedStepProfile(meshed.vertices, section)
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
