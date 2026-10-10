import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from 'three'
import { ensureOc } from './occInit'

/**
 * The "light sabre" test.
 *
 * The laser is a straight beam ~3–4 cm long. Aimed perpendicular at a surface point it must
 * **pass through the material exactly once** and its far end must land outside the part. If the
 * beam's end finishes *inside* the body (e.g. a wall thicker than its reach, or a shaved surface
 * whose normal drives the head into the part), or if it cuts more than one wall, the surface is
 * not manufacturable — and it cannot be fixed by editing the NC.
 *
 * Implemented by triangulating the solid and ray-casting a segment of `length` from just outside
 * each sampled face, counting material crossings. Two crossings (enter + exit) is a clean single
 * pass; anything else fails.
 */

export interface SabreFailure {
  /** surface point the beam was fired at */
  point: [number, number, number]
  /** outward face normal (beam fires along its negation) */
  normal: [number, number, number]
  /** material boundary crossings within the beam length */
  crossings: number
  /** area (mm²) of the offending surface patch */
  area: number
}

export interface SabreResult {
  ok: boolean
  /** triangles tested */
  checked: number
  failures: SabreFailure[]
}

const SABRE_LENGTH = 35
const MAX_SAMPLES = 400
const MIN_AREA_FRACTION = 0.002

interface Tri {
  a: Vector3
  b: Vector3
  c: Vector3
  area: number
  centroid: Vector3
  normal: Vector3
}

function triangles(vertices: number[], indices: number[]): Tri[] {
  const out: Tri[] = []
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const ia = indices[i] * 3
    const ib = indices[i + 1] * 3
    const ic = indices[i + 2] * 3
    const a = new Vector3(vertices[ia], vertices[ia + 1], vertices[ia + 2])
    const b = new Vector3(vertices[ib], vertices[ib + 1], vertices[ib + 2])
    const c = new Vector3(vertices[ic], vertices[ic + 1], vertices[ic + 2])
    const cross = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a))
    const area = cross.length() / 2
    if (area < 1e-6) continue
    out.push({
      a,
      b,
      c,
      area,
      centroid: new Vector3()
        .addVectors(a, b)
        .add(c)
        .multiplyScalar(1 / 3),
      normal: cross.normalize(),
    })
  }
  return out
}

function bounds(vertices: number[]): {
  min: [number, number, number]
  max: [number, number, number]
} {
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ]
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], vertices[i + a])
      max[a] = Math.max(max[a], vertices[i + a])
    }
  }
  return { min, max }
}

function longAxis(vertices: number[]): Vector3 {
  const { min, max } = bounds(vertices)
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const longest = ext.indexOf(Math.max(...ext))
  return new Vector3().setComponent(longest, 1)
}

export async function sabreTest(bytes: Uint8Array, length = SABRE_LENGTH): Promise<SabreResult> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const shape = await importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' }))
  const mesh = (
    shape as unknown as {
      mesh: (o?: unknown) => { vertices: number[]; triangles: number[] }
    }
  ).mesh({ tolerance: 0.1, angularTolerance: 0.3 })

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(mesh.vertices), 3))
  geometry.setIndex(new BufferAttribute(Uint32Array.from(mesh.triangles), 1))
  const target = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }))

  const tris = triangles(mesh.vertices, mesh.triangles)
  const axis = longAxis(mesh.vertices)
  const maxArea = tris.reduce((max, t) => Math.max(max, t.area), 0)
  const minArea = maxArea * MIN_AREA_FRACTION
  const sampled = tris
    .filter((t) => t.area >= minArea && Math.abs(t.normal.dot(axis)) < 0.4)
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_SAMPLES)

  const raycaster = new Raycaster()
  const direction = new Vector3()
  const origin = new Vector3()
  const failures: SabreFailure[] = []

  for (const tri of sampled) {
    // Start just outside the surface and fire straight in (opposite the outward normal).
    origin.copy(tri.centroid).addScaledVector(tri.normal, 0.05)
    direction.copy(tri.normal).negate()
    raycaster.set(origin, direction)
    raycaster.near = 0
    raycaster.far = length + 0.05
    const crossings = raycaster
      .intersectObject(target, false)
      .filter((hit) => hit.distance > 0.01 && hit.distance <= length).length
    // One clean pass = enter + exit = 2 crossings.
    if (crossings !== 2) {
      failures.push({
        point: [tri.centroid.x, tri.centroid.y, tri.centroid.z],
        normal: [tri.normal.x, tri.normal.y, tri.normal.z],
        crossings,
        area: tri.area,
      })
    }
  }

  geometry.dispose()
  return { ok: failures.length === 0, checked: sampled.length, failures }
}
