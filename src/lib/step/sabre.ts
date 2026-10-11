import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from 'three'
import { MAX_CUT_THICKNESS_MM } from '@/lib/audit/cutReach'
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
  /** material depth (mm) the beam must travel through at this point */
  thickness: number
  /** area (mm²) of the offending surface patch */
  area: number
  /** failing triangle corners in STEP native coordinates — paints the red surface patch */
  tri: [[number, number, number], [number, number, number], [number, number, number]]
  /** where the beam enters the material (on the surface it was fired at) */
  entry: [number, number, number]
  /** where the beam exits the far wall — the other end of the material it bores through */
  exit: [number, number, number]
}

/**
 * A connected patch of failing surface, localizing *where* the beam cannot cut. Failing
 * triangles that share a vertex belong to the same region (mirror flanges, opposite ends and
 * separate cuts are distinct). The `bores` are the actual entry→exit paths through the
 * material, so the region is the surface patch *and* the material each beam traverses.
 */
export interface SabreRegion {
  /** area-weighted centre of the failing surface patch (STEP native coordinates) */
  point: [number, number, number]
  /** failing triangles making up the region */
  triangles: number
  /** total surface area of the failing patch (mm²) */
  area: number
  /** deepest material path in the region (mm) */
  depth: number
  /** bore segments (entry → exit) traversing the material */
  bores: [[number, number, number], [number, number, number]][]
}

/**
 * Groups failures into connected surface regions (shared-vertex union), so a problem is
 * reported as *one* localized patch with its material bores rather than N loose triangles.
 * Regions are returned largest-area first.
 */
export function sabreRegions(failures: SabreFailure[]): SabreRegion[] {
  const parent = failures.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root
    let cur = i
    while ((parent[cur] ?? cur) !== root) {
      const next = parent[cur] ?? cur
      parent[cur] = root
      cur = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  const owner = new Map<string, number>()
  failures.forEach((failure, i) => {
    for (const vertex of failure.tri) {
      const key = vertexKey(vertex)
      const previous = owner.get(key)
      if (previous === undefined) owner.set(key, i)
      else union(previous, i)
    }
  })

  const groups = new Map<number, number[]>()
  failures.forEach((_, i) => {
    const root = find(i)
    const list = groups.get(root) ?? []
    list.push(i)
    groups.set(root, list)
  })

  return [...groups.values()]
    .map((indices) => {
      let area = 0
      let depth = 0
      let x = 0
      let y = 0
      let z = 0
      const bores: [[number, number, number], [number, number, number]][] = []
      for (const i of indices) {
        const failure = failures[i]
        if (!failure) continue
        area += failure.area
        depth = Math.max(depth, failure.thickness)
        x += failure.point[0]
        y += failure.point[1]
        z += failure.point[2]
        bores.push([failure.entry, failure.exit])
      }
      const count = indices.length || 1
      return {
        point: [x / count, y / count, z / count] as [number, number, number],
        triangles: indices.length,
        area,
        depth,
        bores,
      }
    })
    .sort((a, b) => b.area - a.area)
}

export interface SabreResult {
  ok: boolean
  /** triangles tested */
  checked: number
  failures: SabreFailure[]
}

/** A cut line: one boundary edge of the guilty region, with its face normal. */
export interface SabreEdge {
  a: [number, number, number]
  b: [number, number, number]
  normal: [number, number, number]
}

function vertexKey(point: [number, number, number]): string {
  return `${Math.round(point[0] * 1000)},${Math.round(point[1] * 1000)},${Math.round(point[2] * 1000)}`
}

/**
 * Cut lines for the overlay: edges belonging to exactly one failing triangle. Edges shared
 * by two failing triangles are internal tessellation diagonals — drawing them turns a guilty
 * patch into a zigzag hatch that reads as a surface. The survivors form the patch perimeter:
 * one clean loop per guilty face.
 */
export function sabreBoundary(failures: SabreFailure[]): SabreEdge[] {
  const edges = new Map<string, { edge: SabreEdge; count: number }>()
  for (const failure of failures) {
    const [a, b, c] = failure.tri
    const candidates: SabreEdge[] = [
      { a, b, normal: failure.normal },
      { a: b, b: c, normal: failure.normal },
      { a: c, b: a, normal: failure.normal },
    ]
    for (const edge of candidates) {
      const ka = vertexKey(edge.a)
      const kb = vertexKey(edge.b)
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
      const entry = edges.get(key)
      if (entry) entry.count += 1
      else edges.set(key, { edge, count: 1 })
    }
  }
  const out: SabreEdge[] = []
  for (const { edge, count } of edges.values()) {
    if (count === 1) out.push(edge)
  }
  return out
}

/** The minimum a shape must expose to be light-sabre tested — an already-imported OCC shape. */
export interface MeshableShape {
  mesh: (options?: unknown) => { vertices: number[]; triangles: number[] }
}

/** The beam's usable length equals the head's max pierce depth (`MAX_CUT_THICKNESS_MM`). */
const SABRE_LENGTH = MAX_CUT_THICKNESS_MM
/** Cap on the number of triangle samples probed (largest first). */
const MAX_SAMPLES = 400
/**
 * Ignore tessellation slivers below this area (mm²). An *absolute* floor — not a fraction of the
 * largest triangle — because on a long beam a single side face can be ~10⁵ mm², which pushes a
 * proportional threshold far past the small end/cut faces we actually need to test (a mitred end
 * meshes into many tens-of-mm² triangles).
 */
const MIN_TRIANGLE_AREA = 20

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
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as MeshableShape & { delete: () => void }
  try {
    return sabreShape(shape, length)
  } finally {
    shape.delete()
  }
}

/**
 * Runs the light-sabre test on an already-imported OCC shape. Split out from {@link sabreTest} so
 * a worker can import a STEP once and reuse the same shape for several checks (measure + sabre).
 */
export function sabreShape(shape: MeshableShape, length = SABRE_LENGTH): SabreResult {
  const mesh = shape.mesh({ tolerance: 0.1, angularTolerance: 0.3 })

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(mesh.vertices), 3))
  geometry.setIndex(new BufferAttribute(Uint32Array.from(mesh.triangles), 1))
  const target = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }))

  const tris = triangles(mesh.vertices, mesh.triangles)
  const axis = longAxis(mesh.vertices)
  // Only *tilted* faces (mitres, shaves) are cut with a non-radial beam — the surfaces where an
  // axial beam could end inside the body. Square ends (|n·axis|≈1) are traced by the perimeter
  // and side walls (|n·axis|≈0) are cut radially through their thin wall; neither is a risk.
  const sampled = tris
    .filter((t) => {
      const axial = Math.abs(t.normal.dot(axis))
      return t.area >= MIN_TRIANGLE_AREA && axial > 0.05 && axial < 0.98
    })
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_SAMPLES)

  const raycaster = new Raycaster()
  const probe = new Raycaster()
  const direction = new Vector3()
  const origin = new Vector3()
  const flipDir = new Vector3(0.123, 0.456, 0.789).normalize()
  const failures: SabreFailure[] = []

  // OCC triangulation normals are not guaranteed outward; a beam fired the wrong way "never
  // exits" and looks like a failure. Probe a point just outside along the normal: if it is
  // inside the solid, the normal points inward, so flip it.
  const orientOutward = (tri: Tri): void => {
    origin.copy(tri.centroid).addScaledVector(tri.normal, 0.3)
    probe.set(origin, flipDir)
    probe.near = 0
    probe.far = Number.POSITIVE_INFINITY
    const inside = probe.intersectObject(target, false).length % 2 === 1
    if (inside) tri.normal.negate()
  }

  for (const tri of sampled) {
    orientOutward(tri)
    // Start just outside the surface and fire straight in (opposite the outward normal).
    origin.copy(tri.centroid).addScaledVector(tri.normal, 0.05)
    direction.copy(tri.normal).negate()
    raycaster.set(origin, direction)
    raycaster.near = 0
    raycaster.far = 2000
    const hits = raycaster
      .intersectObject(target, false)
      .filter((hit) => hit.distance > 0.01)
      .sort((a, b) => a.distance - b.distance)
    // First hit is the surface entering the material, the next is where the beam exits. The
    // distance between them is the material the beam must travel through.
    const entryHit = hits[0]
    const exitHit = hits[1]
    const thickness =
      entryHit && exitHit ? exitHit.distance - entryHit.distance : Number.POSITIVE_INFINITY
    if (thickness > length) {
      const entry: [number, number, number] = entryHit
        ? [entryHit.point.x, entryHit.point.y, entryHit.point.z]
        : [tri.centroid.x, tri.centroid.y, tri.centroid.z]
      const exit: [number, number, number] = exitHit
        ? [exitHit.point.x, exitHit.point.y, exitHit.point.z]
        : entry
      failures.push({
        point: [tri.centroid.x, tri.centroid.y, tri.centroid.z],
        normal: [tri.normal.x, tri.normal.y, tri.normal.z],
        thickness,
        area: tri.area,
        tri: [
          [tri.a.x, tri.a.y, tri.a.z],
          [tri.b.x, tri.b.y, tri.b.z],
          [tri.c.x, tri.c.y, tri.c.z],
        ],
        entry,
        exit,
      })
    }
  }

  geometry.dispose()
  return { ok: failures.length === 0, checked: sampled.length, failures }
}
