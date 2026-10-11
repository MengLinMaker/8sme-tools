import { BufferGeometry, Float32BufferAttribute, type Matrix4, Vector3 } from 'three'
import { Brush, computeMeshVolume, Evaluator, SUBTRACTION } from 'three-bvh-csg'
import {
  createMeshQuery,
  diffFraction,
  type MeshQuery,
  pointTriangleDistanceSquared,
} from './diffHighlight'

/**
 * True boolean difference of the two overlay models, with the STEP treated as ideal.
 *
 * - `over` (red): overcut — the NC removed material the ideal keeps. Scrap: cannot fix.
 * - `under` (blue): undercut — leftover material the ideal lacks. Rework: can still cut.
 */

export interface DiffSoup {
  vertices: number[]
  triangles: number[]
}

/** Largest input the CSG path attempts; beyond this the viewer falls back to surface flagging. */
export const BOOLEAN_TRIANGLE_BUDGET = 200_000

/**
 * Keep bars for a diff component. Exact boolean first, then tolerance: a
 * component is kept when it is big enough to machine and enough of it stands
 * clear of the other model. Faces within tolerance never draw — coplanar
 * hairlines, section-table skins and sharp-vs-rolled edges all sit below it —
 * while genuinely out faces always do, whether they form a whole slab or a
 * notch bottom:
 * - SIZE_FLOOR: below a 2 mm cube it is a CSG crumb;
 * - CLEAR_MM / CLEAR_SHARE: at least this share of the component's triangles
 *   sits this far off the other surface. A share, not any-vertex: one far spike
 *   (glitch triangle, hole-rim sliver) must not rescue a whole thin skin, while
 *   a wedge, slab or notch easily clears it.
 * Volumes are the kept components' own, so the legend number matches the
 * picture (signed sums over open patch shells are meaningless).
 */
export const KEEP_SIZE_ABS_MM3 = 2
// 1 mm: the machining tolerance, and the floor that keeps OCC's 0.3 mm facets honest — two
// models tessellated independently can differ ~0.6 mm at a fillet, so a sub-millimetre bar
// would false-flag real geometry as a diff.
export const KEEP_CLEAR_MM = 1
export const KEEP_CLEAR_SHARE = 0.01

/**
 * A kept component draws whole (closed) only when at least this share of its surface stands
 * proud of the other model. Below it the component is mostly *flush* with the other model — a
 * shallow skin (the kerf/shave offset over a face) — and only its proud faces draw, so the big
 * sub-tolerance membrane never shows. Kept low so genuine shallow regions still render whole.
 */
export const KEEP_SOLID_SHARE = 0.3

/**
 * A face with a roughly opposite partner within this gap is a paper-thin skin, so it is pruned.
 * Set at the clear bar (1 mm): thin skins — including the uniform membranes a Laplacian smoother
 * can't collapse on its own — are removed, while genuine features at or above the bar survive.
 * Applied before *and* after the smoother, since smoothing can pull faces back within the gap.
 */
export const SKIN_MAX_THICKNESS_MM = 1

export interface BooleanDiff {
  /** STEP-minus-manufactured solid (overcut, red), world coordinates (null when empty) */
  over: BufferGeometry | null
  /** manufactured-minus-STEP solid (undercut, blue), world coordinates (null when empty) */
  under: BufferGeometry | null
  /** max-vertex distance per rendered triangle, same order as the geometries */
  overDistance: number[]
  underDistance: number[]
  /** volumes measured on what is drawn, so the legend number matches the picture */
  overVolume: number
  underVolume: number
  /** volume of the manufactured model, so the legend can show shares */
  primaryVolume: number
}

/**
 * A kept face reads at near-full strength right at the clear bar (FLOOR), so the diff is an even,
 * uniform colour rather than a fade — the region should read as one flat shape.
 */
export const DIFF_ALPHA_FLOOR = 0.9
export const DIFF_ALPHA_FULL_MM = 1.5

/**
 * The interface faces close the solid on the part surface at zero clearance. Kept close to the
 * floor so the whole diff reads as one even colour.
 */
export const DIFF_ALPHA_INTERFACE = 0.7

/** Maps a per-triangle clearance (mm) to a render alpha. */
export function diffAlpha(distanceMm: number): number {
  if (distanceMm < KEEP_CLEAR_MM) return DIFF_ALPHA_INTERFACE
  const t = Math.min(
    1,
    Math.max(0, (distanceMm - KEEP_CLEAR_MM) / (DIFF_ALPHA_FULL_MM - KEEP_CLEAR_MM)),
  )
  const smooth = t * t * (3 - 2 * t)
  return DIFF_ALPHA_FLOOR + (1 - DIFF_ALPHA_FLOOR) * smooth
}

interface DiffComponent {
  triangles: number[]
  volume: number
}

/**
 * Splits a result solid into vertex-connected components with volumes.
 * Corner keys are computed once up front and reused for grouping and volume.
 */
export function extractComponents(geometry: BufferGeometry): DiffComponent[] {
  const position = geometry.getAttribute('position')
  const count = triangleCount(geometry)
  if (!position || count === 0) return []
  const array = position.array as Float32Array
  const index = geometry.getIndex()
  const corner = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k)

  // Union-find over triangles sharing a (1 µm-welded) vertex.
  const parent = Array.from({ length: count }, (_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root] ?? root
    while (parent[i] !== root) {
      const next = parent[i] ?? root
      parent[i] = root
      i = next
    }
    return root
  }
  const seen = new Map<string, number>()
  const keys: string[] = new Array(count * 3)
  const weld = (v: number) =>
    `${Math.round(array[v * 3] * 1000)},${Math.round(array[v * 3 + 1] * 1000)},${Math.round(array[v * 3 + 2] * 1000)}`
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) keys[t * 3 + k] = weld(corner(t, k))
  }
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const key = keys[t * 3 + k] ?? ''
      const first = seen.get(key)
      if (first === undefined) seen.set(key, t)
      else {
        const a = find(t)
        const b = find(first)
        if (a !== b) parent[a] = b
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let t = 0; t < count; t++) {
    const root = find(t)
    const list = groups.get(root)
    if (list) list.push(t)
    else groups.set(root, [t])
  }

  const components: DiffComponent[] = []
  for (const tris of groups.values()) {
    let volume = 0
    for (const t of tris) {
      const a = corner(t, 0) * 3
      const b = corner(t, 1) * 3
      const c = corner(t, 2) * 3
      const ax = array[a] ?? 0
      const ay = array[a + 1] ?? 0
      const az = array[a + 2] ?? 0
      const abx = (array[b] ?? 0) - ax
      const aby = (array[b + 1] ?? 0) - ay
      const abz = (array[b + 2] ?? 0) - az
      const acx = (array[c] ?? 0) - ax
      const acy = (array[c + 1] ?? 0) - ay
      const acz = (array[c + 2] ?? 0) - az
      const nx = aby * acz - abz * acy
      const ny = abz * acx - abx * acz
      const nz = abx * acy - aby * acx
      volume += (ax * nx + ay * ny + az * nz) / 6
    }
    components.push({ triangles: tris, volume: Math.abs(volume) })
  }
  return components
}

/**
 * Reads a geometry's triangles as corner vertex indices (indexed or not) alongside
 * its position array.
 */
function triangleSoup(geometry: BufferGeometry): { vertices: Float32Array; triangles: number[] } {
  const vertices = geometry.getAttribute('position')?.array as Float32Array
  const index = geometry.getIndex()
  const count = triangleCount(geometry)
  const triangles: number[] = []
  for (let t = 0; t < count; t++) {
    triangles.push(
      index ? index.getX(t * 3) : t * 3,
      index ? index.getX(t * 3 + 1) : t * 3 + 1,
      index ? index.getX(t * 3 + 2) : t * 3 + 2,
    )
  }
  return { vertices, triangles }
}

function geometryFromTriangles(vertices: Float32Array, triangles: number[]): BufferGeometry | null {
  if (triangles.length === 0) return null
  const positions = new Float32Array(triangles.length * 3)
  for (let i = 0; i < triangles.length; i++) {
    const source = (triangles[i] ?? 0) * 3
    positions[i * 3] = vertices[source] ?? 0
    positions[i * 3 + 1] = vertices[source + 1] ?? 0
    positions[i * 3 + 2] = vertices[source + 2] ?? 0
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}

/**
 * Rebuilds a diff solid from the result components worth drawing (null when
 * nothing survives). Volumes are the kept components' own, so the legend number
 * matches the picture. See the KEEP_* bars above for the keep rules.
 * Also returns the max-vertex distance per rendered triangle (same order as
 * the rebuilt geometry), so the viewer can fade barely-out faces instead of
 * hiding them.
 */
export function filterDrawableFaces(
  geometry: BufferGeometry,
  query: MeshQuery,
): { geometry: BufferGeometry | null; volume: number; distances: number[] } {
  const { vertices, triangles } = triangleSoup(geometry)
  const count = Math.floor(triangles.length / 3)
  if (count === 0) return { geometry: null, volume: 0, distances: [] }
  const floor = KEEP_SIZE_ABS_MM3
  const kept: number[] = []
  const keptDistances: number[] = []
  let volume = 0
  const sharedVertices = Array.from(vertices)
  for (const component of extractComponents(geometry)) {
    if (component.volume < floor) continue
    const corners: number[] = []
    for (const t of component.triangles) {
      corners.push(triangles[t * 3] ?? 0, triangles[t * 3 + 1] ?? 0, triangles[t * 3 + 2] ?? 0)
    }
    // One query object per side — its spatial index is built once and reused
    // across every component, instead of rebuilt per component.
    const dists = query.distances(sharedVertices, corners)
    let far = 0
    for (const d of dists) if (d >= query.tolerance) far++
    const farShare = far / dists.length
    // A genuine solid (enough of it stands proud) draws whole: the far faces are the material,
    // the near faces close the volume on the model surface. A skin (mostly flush with the other
    // model) draws only its proud faces — keeping its near faces would render the whole
    // sub-tolerance membrane as a ghost sheet. The CLEAR_SHARE gate drops components with no real
    // protrusion at all; volume stays the component's own so the number matches the kept piece.
    if (farShare >= KEEP_CLEAR_SHARE) {
      const whole = farShare >= KEEP_SOLID_SHARE
      for (let t = 0; t < component.triangles.length; t++) {
        const d = dists[t] ?? 0
        if (!whole && d < query.tolerance) continue
        const original = component.triangles[t] ?? 0
        kept.push(
          triangles[original * 3] ?? 0,
          triangles[original * 3 + 1] ?? 0,
          triangles[original * 3 + 2] ?? 0,
        )
        keptDistances.push(d)
      }
      volume += component.volume
    }
  }
  const filtered = geometryFromTriangles(vertices, kept)
  if (!filtered) return { geometry: null, volume: 0, distances: [] }
  return { geometry: filtered, volume, distances: keptDistances }
}

/**
 * Removes paper-thin skins: a triangle with a roughly parallel, oppositely-facing partner within
 * `minThickness` is a membrane (a sub-tolerance sliver where the two models nearly coincide), not
 * real material, so both are dropped. Genuine walls are further apart and survive, so the diff
 * keeps its solid volume without the razor edges a membrane throws off. One centroid-grid pass,
 * O(n); returns the rebuilt geometry plus the per-triangle keep mask (to re-filter the distances).
 */
export function pruneThinSkin(
  geometry: BufferGeometry | null,
  minThickness: number,
): { geometry: BufferGeometry | null; keep: Uint8Array } {
  if (!geometry) return { geometry: null, keep: new Uint8Array(0) }
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3)
  const keep = new Uint8Array(triCount).fill(1)
  if (triCount === 0) return { geometry, keep }

  const corner = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k)
  const nx = new Float64Array(triCount)
  const ny = new Float64Array(triCount)
  const nz = new Float64Array(triCount)
  const cornerX = new Float64Array(triCount * 3)
  const cornerY = new Float64Array(triCount * 3)
  const cornerZ = new Float64Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    const a = corner(t, 0)
    const b = corner(t, 1)
    const c = corner(t, 2)
    const ax = position.getX(a)
    const ay = position.getY(a)
    const az = position.getZ(a)
    const bx = position.getX(b)
    const by = position.getY(b)
    const bz = position.getZ(b)
    const dx = position.getX(c)
    const dy = position.getY(c)
    const dz = position.getZ(c)
    cornerX[t * 3] = ax
    cornerX[t * 3 + 1] = bx
    cornerX[t * 3 + 2] = dx
    cornerY[t * 3] = ay
    cornerY[t * 3 + 1] = by
    cornerY[t * 3 + 2] = dy
    cornerZ[t * 3] = az
    cornerZ[t * 3 + 1] = bz
    cornerZ[t * 3 + 2] = dz
    const ux = bx - ax
    const uy = by - ay
    const uz = bz - az
    const vx = dx - ax
    const vy = dy - ay
    const vz = dz - az
    let ex = uy * vz - uz * vy
    let ey = uz * vx - ux * vz
    let ez = ux * vy - uy * vx
    const len = Math.hypot(ex, ey, ez)
    if (len > 0) {
      ex /= len
      ey /= len
      ez /= len
    }
    nx[t] = ex
    ny[t] = ey
    nz[t] = ez
  }

  // Bucket each triangle under every `minThickness`-wide cell its bounding box covers, so a vertex
  // of a face on the far side of a membrane lands in a cell that face was filed in. A centroid-only
  // bucket misses it: opposite faces of a box triangulate mirror-imaged, so their centroids differ.
  const cell = Math.max(minThickness, 0.05)
  const grid = new Map<string, number[]>()
  const key = (ix: number, iy: number, iz: number): string => `${ix},${iy},${iz}`
  const MAX_CELLS = 4096
  for (let t = 0; t < triCount; t++) {
    const ax = cornerX[t * 3] ?? 0
    const ay = cornerY[t * 3] ?? 0
    const az = cornerZ[t * 3] ?? 0
    const bx = cornerX[t * 3 + 1] ?? 0
    const by = cornerY[t * 3 + 1] ?? 0
    const bz = cornerZ[t * 3 + 1] ?? 0
    const dx = cornerX[t * 3 + 2] ?? 0
    const dy = cornerY[t * 3 + 2] ?? 0
    const dz = cornerZ[t * 3 + 2] ?? 0
    const x0 = Math.floor(Math.min(ax, bx, dx) / cell)
    const x1 = Math.floor(Math.max(ax, bx, dx) / cell)
    const y0 = Math.floor(Math.min(ay, by, dy) / cell)
    const y1 = Math.floor(Math.max(ay, by, dy) / cell)
    const z0 = Math.floor(Math.min(az, bz, dz) / cell)
    const z1 = Math.floor(Math.max(az, bz, dz) / cell)
    const spans = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1)
    const whole = spans > MAX_CELLS // huge triangle: fall back to its centroid cell only
    const lo = whole
      ? [
          Math.floor((ax + bx + dx) / 3 / cell),
          Math.floor((ay + by + dy) / 3 / cell),
          Math.floor((az + bz + dz) / 3 / cell),
        ]
      : [x0, y0, z0]
    const hi = whole ? lo : [x1, y1, z1]
    for (let ix = lo[0] ?? 0; ix <= (hi[0] ?? 0); ix++) {
      for (let iy = lo[1] ?? 0; iy <= (hi[1] ?? 0); iy++) {
        for (let iz = lo[2] ?? 0; iz <= (hi[2] ?? 0); iz++) {
          const k = key(ix, iy, iz)
          const list = grid.get(k)
          if (list) list.push(t)
          else grid.set(k, [t])
        }
      }
    }
  }

  const OPPOSITE_DOT = -0.5 // normals ≥120° apart: a fold, or the two sides of a membrane
  const minGap = 0.05 // a shared edge reads as ~0 gap; only a genuine membrane clears this
  let removed = 0
  for (let t = 0; t < triCount; t++) {
    if (keep[t] === 0) continue
    let hit = false
    for (let k = 0; k < 3 && !hit; k++) {
      const px = cornerX[t * 3 + k] ?? 0
      const py = cornerY[t * 3 + k] ?? 0
      const pz = cornerZ[t * 3 + k] ?? 0
      const gx = Math.floor(px / cell)
      const gy = Math.floor(py / cell)
      const gz = Math.floor(pz / cell)
      for (let ox = -1; ox <= 1 && !hit; ox++) {
        for (let oy = -1; oy <= 1 && !hit; oy++) {
          for (let oz = -1; oz <= 1 && !hit; oz++) {
            const list = grid.get(key(gx + ox, gy + oy, gz + oz))
            if (!list) continue
            for (const s of list) {
              if (s === t || keep[s] === 0) continue
              const dot =
                (nx[t] ?? 0) * (nx[s] ?? 0) +
                (ny[t] ?? 0) * (ny[s] ?? 0) +
                (nz[t] ?? 0) * (nz[s] ?? 0)
              if (dot > OPPOSITE_DOT) continue
              const gap = Math.sqrt(
                pointTriangleDistanceSquared(
                  px,
                  py,
                  pz,
                  cornerX[s * 3] ?? 0,
                  cornerY[s * 3] ?? 0,
                  cornerZ[s * 3] ?? 0,
                  cornerX[s * 3 + 1] ?? 0,
                  cornerY[s * 3 + 1] ?? 0,
                  cornerZ[s * 3 + 1] ?? 0,
                  cornerX[s * 3 + 2] ?? 0,
                  cornerY[s * 3 + 2] ?? 0,
                  cornerZ[s * 3 + 2] ?? 0,
                ),
              )
              if (gap <= minThickness && gap > minGap) {
                keep[t] = 0
                keep[s] = 0
                removed += 2
                hit = true
                break
              }
            }
          }
        }
      }
    }
  }
  if (removed === 0) return { geometry, keep }

  const surviving: number[] = []
  for (let t = 0; t < triCount; t++) {
    if (keep[t] === 0) continue
    surviving.push(corner(t, 0), corner(t, 1), corner(t, 2))
  }
  if (surviving.length === 0) return { geometry: null, keep }
  const positions = new Float32Array(surviving.length * 3)
  for (let i = 0; i < surviving.length; i++) {
    const v = surviving[i] ?? 0
    positions[i * 3] = position.getX(v)
    positions[i * 3 + 1] = position.getY(v)
    positions[i * 3 + 2] = position.getZ(v)
  }
  const pruned = new BufferGeometry()
  pruned.setAttribute('position', new Float32BufferAttribute(positions, 3))
  pruned.computeVertexNormals()
  pruned.computeBoundingBox()
  return { geometry: pruned, keep }
}

/**
 * Thickness-weighted smoothing pass over a diff solid. Welds coincident vertices, estimates each
 * vertex's local wall thickness (distance to the nearest *non-adjacent*, oppositely-facing face),
 * and runs Laplacian rounds weighted by thinness: vertices in a thin skin (the kerf/tessellation
 * membrane) smooth hard and collapse, vertices in real material barely move. This removes the skin
 * without rounding genuine geometry — a plain Laplacian can't do both.
 */
const SMOOTH_SKIN_CAP_MM = 3

export function smoothGeometry(
  geometry: BufferGeometry | null,
  iterations = 12,
  lambda = 0.85,
): BufferGeometry | null {
  if (!geometry) return null
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const count = position.count
  if (count === 0) return geometry
  const vertex = (i: number): number => (index ? index.getX(i) : i)
  const triCount = Math.floor((index ? index.count : count) / 3)
  if (triCount === 0) return geometry

  // Weld by position so adjacency / thickness use real connectivity, not per-triangle duplicates.
  const map = new Map<string, number>()
  const rep = new Int32Array(count)
  const px: number[] = []
  const py: number[] = []
  const pz: number[] = []
  for (let v = 0; v < count; v++) {
    const x = position.getX(v)
    const y = position.getY(v)
    const z = position.getZ(v)
    const key = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`
    let idx = map.get(key)
    if (idx === undefined) {
      idx = px.length
      map.set(key, idx)
      px.push(x)
      py.push(y)
      pz.push(z)
    }
    rep[v] = idx
  }
  const vertCount = px.length

  const tri = new Int32Array(triCount * 3)
  const tnx = new Float64Array(triCount)
  const tny = new Float64Array(triCount)
  const tnz = new Float64Array(triCount)
  const tcx = new Float64Array(triCount)
  const tcy = new Float64Array(triCount)
  const tcz = new Float64Array(triCount)
  const adjacency: Set<number>[] = Array.from({ length: vertCount }, () => new Set<number>())
  const normals = new Float64Array(vertCount * 3)
  for (let t = 0; t < triCount; t++) {
    const a = rep[vertex(t * 3)] ?? 0
    const b = rep[vertex(t * 3 + 1)] ?? 0
    const c = rep[vertex(t * 3 + 2)] ?? 0
    tri[t * 3] = a
    tri[t * 3 + 1] = b
    tri[t * 3 + 2] = c
    adjacency[a]?.add(b)
    adjacency[a]?.add(c)
    adjacency[b]?.add(a)
    adjacency[b]?.add(c)
    adjacency[c]?.add(a)
    adjacency[c]?.add(b)
    const ax = px[a] ?? 0
    const ay = py[a] ?? 0
    const az = pz[a] ?? 0
    const bx = px[b] ?? 0
    const by = py[b] ?? 0
    const bz = pz[b] ?? 0
    const cx = px[c] ?? 0
    const cy = py[c] ?? 0
    const cz = pz[c] ?? 0
    tcx[t] = (ax + bx + cx) / 3
    tcy[t] = (ay + by + cy) / 3
    tcz[t] = (az + bz + cz) / 3
    let ex = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
    let ey = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
    let ez = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    const len = Math.hypot(ex, ey, ez)
    if (len > 0) {
      ex /= len
      ey /= len
      ez /= len
    }
    tnx[t] = ex
    tny[t] = ey
    tnz[t] = ez
    for (const w of [a, b, c]) {
      normals[w * 3] = (normals[w * 3] ?? 0) + ex
      normals[w * 3 + 1] = (normals[w * 3 + 1] ?? 0) + ey
      normals[w * 3 + 2] = (normals[w * 3 + 2] ?? 0) + ez
    }
  }

  // Grid of triangle centroids for the thickness query.
  const cell = SMOOTH_SKIN_CAP_MM
  const grid = new Map<string, number[]>()
  const key = (ix: number, iy: number, iz: number): string => `${ix},${iy},${iz}`
  for (let t = 0; t < triCount; t++) {
    const k = key(
      Math.floor((tcx[t] ?? 0) / cell),
      Math.floor((tcy[t] ?? 0) / cell),
      Math.floor((tcz[t] ?? 0) / cell),
    )
    const list = grid.get(k)
    if (list) list.push(t)
    else grid.set(k, [t])
  }

  // Per-vertex thinness in 0..1 (1 = a wall within CAP mm → collapses under smoothing).
  const thin = new Float32Array(vertCount)
  for (let v = 0; v < vertCount; v++) {
    const vnx = normals[v * 3] ?? 0
    const vny = normals[v * 3 + 1] ?? 0
    const vnz = normals[v * 3 + 2] ?? 0
    const nlen = Math.hypot(vnx, vny, vnz)
    if (nlen === 0) continue
    const vx = px[v] ?? 0
    const vy = py[v] ?? 0
    const vz = pz[v] ?? 0
    const gx = Math.floor(vx / cell)
    const gy = Math.floor(vy / cell)
    const gz = Math.floor(vz / cell)
    let best = SMOOTH_SKIN_CAP_MM
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
          const list = grid.get(key(gx + ox, gy + oy, gz + oz))
          if (!list) continue
          for (const s of list) {
            if (tri[s * 3] === v || tri[s * 3 + 1] === v || tri[s * 3 + 2] === v) continue
            const dot =
              (vnx / nlen) * (tnx[s] ?? 0) +
              (vny / nlen) * (tny[s] ?? 0) +
              (vnz / nlen) * (tnz[s] ?? 0)
            if (dot > -0.3) continue
            const d = Math.sqrt(
              pointTriangleDistanceSquared(
                vx,
                vy,
                vz,
                px[tri[s * 3] ?? 0] ?? 0,
                py[tri[s * 3] ?? 0] ?? 0,
                pz[tri[s * 3] ?? 0] ?? 0,
                px[tri[s * 3 + 1] ?? 0] ?? 0,
                py[tri[s * 3 + 1] ?? 0] ?? 0,
                pz[tri[s * 3 + 1] ?? 0] ?? 0,
                px[tri[s * 3 + 2] ?? 0] ?? 0,
                py[tri[s * 3 + 2] ?? 0] ?? 0,
                pz[tri[s * 3 + 2] ?? 0] ?? 0,
              ),
            )
            if (d < best) best = d
          }
        }
      }
    }
    thin[v] = Math.max(0, 1 - best / SMOOTH_SKIN_CAP_MM)
  }

  for (let round = 0; round < iterations; round++) {
    const nx = px.slice()
    const ny = py.slice()
    const nz = pz.slice()
    for (let v = 0; v < vertCount; v++) {
      const w = (thin[v] ?? 0) * lambda
      if (w <= 0) continue
      const neighbours = adjacency[v]
      if (!neighbours || neighbours.size === 0) continue
      let sx = 0
      let sy = 0
      let sz = 0
      for (const n of neighbours) {
        sx += px[n] ?? 0
        sy += py[n] ?? 0
        sz += pz[n] ?? 0
      }
      const k = neighbours.size
      nx[v] = (px[v] ?? 0) * (1 - w) + (sx / k) * w
      ny[v] = (py[v] ?? 0) * (1 - w) + (sy / k) * w
      nz[v] = (pz[v] ?? 0) * (1 - w) + (sz / k) * w
    }
    for (let v = 0; v < vertCount; v++) {
      px[v] = nx[v] ?? 0
      py[v] = ny[v] ?? 0
      pz[v] = nz[v] ?? 0
    }
  }
  const positions = new Float32Array(triCount * 9)
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const u = rep[vertex(t * 3 + k)] ?? 0
      positions[(t * 3 + k) * 3] = px[u] ?? 0
      positions[(t * 3 + k) * 3 + 1] = py[u] ?? 0
      positions[(t * 3 + k) * 3 + 2] = pz[u] ?? 0
    }
  }
  const out = new BufferGeometry()
  out.setAttribute('position', new Float32BufferAttribute(positions, 3))
  out.computeVertexNormals()
  out.computeBoundingBox()
  return out
}

/** Concatenates bodies into one world-space soup (bakes the seating transform). */
export function toWorldSoup(parts: DiffSoup[], matrix: Matrix4): DiffSoup {
  const vertices: number[] = []
  const triangles: number[] = []
  const point = new Vector3()
  for (const part of parts) {
    const base = Math.floor(vertices.length / 3)
    const count = Math.floor(part.vertices.length / 3)
    for (let v = 0; v < count; v++) {
      point
        .set(part.vertices[v * 3], part.vertices[v * 3 + 1], part.vertices[v * 3 + 2])
        .applyMatrix4(matrix)
      vertices.push(point.x, point.y, point.z)
    }
    for (const index of part.triangles) {
      if (index >= 0 && index < count) triangles.push(index + base)
    }
  }
  return { vertices, triangles }
}

function soupToGeometry(soup: DiffSoup): BufferGeometry | null {
  const triCount = Math.floor(soup.triangles.length / 3)
  if (triCount === 0) return null
  // Expand to non-indexed positions — one triangle soup per side is what the CSG
  // evaluator is happiest with, and it sidesteps attribute mismatches between bodies.
  const positions = new Float32Array(triCount * 9)
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const source = soup.triangles[t * 3 + k] * 3
      const target = (t * 3 + k) * 3
      positions[target] = soup.vertices[source] ?? 0
      positions[target + 1] = soup.vertices[source + 1] ?? 0
      positions[target + 2] = soup.vertices[source + 2] ?? 0
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  return geometry
}

function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.getIndex()
  if (index) return Math.floor(index.count / 3)
  return Math.floor((geometry.getAttribute('position')?.count ?? 0) / 3)
}

export interface BooleanDiffRaw {
  /** STEP-minus-manufactured solid (overcut, red), world coordinates (null when empty) */
  over: BufferGeometry | null
  /** manufactured-minus-STEP solid (undercut, blue), world coordinates (null when empty) */
  under: BufferGeometry | null
  /** volume of the manufactured model, so the legend can show shares */
  primaryVolume: number
}

/**
 * Runs both boolean directions with no fragment filtering. Returns null when the
 * inputs are over budget or the CSG kernel fails.
 */
export function booleanDiffRaw(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
): BooleanDiffRaw | null {
  const primary = toWorldSoup(primaryParts, primaryMatrix)
  const compare = toWorldSoup(compareParts, compareMatrix)
  const triTotal =
    Math.floor(primary.triangles.length / 3) + Math.floor(compare.triangles.length / 3)
  if (triTotal === 0 || triTotal > BOOLEAN_TRIANGLE_BUDGET) return null
  let primaryGeo: BufferGeometry | null = null
  let compareGeo: BufferGeometry | null = null
  try {
    primaryGeo = soupToGeometry(primary)
    compareGeo = soupToGeometry(compare)
    if (!primaryGeo || !compareGeo) return null
    const primaryVolume = Math.abs(computeMeshVolume(primaryGeo))

    const evaluator = new Evaluator()
    evaluator.useGroups = false
    evaluator.attributes = ['position']
    const brushA = new Brush(primaryGeo)
    const brushB = new Brush(compareGeo)
    brushA.updateMatrixWorld()
    brushB.updateMatrixWorld()

    // over = STEP − manufactured (NC cut too much, scrap); under = manufactured −
    // STEP (NC cut too little, leftover that can still be cut).
    const over = evaluator.evaluate(brushB, brushA, SUBTRACTION).geometry
    const under = evaluator.evaluate(brushA, brushB, SUBTRACTION).geometry
    brushA.disposeCacheData()
    brushB.disposeCacheData()
    for (const geometry of [over, under]) {
      geometry.computeVertexNormals()
      geometry.computeBoundingBox()
    }
    if (triangleCount(over) === 0) over.dispose()
    if (triangleCount(under) === 0) under.dispose()
    return {
      over: triangleCount(over) > 0 ? over : null,
      under: triangleCount(under) > 0 ? under : null,
      primaryVolume,
    }
  } catch {
    return null
  } finally {
    primaryGeo?.dispose()
    compareGeo?.dispose()
  }
}

export interface DiffPresence {
  /** STEP triangles standing clear of manufactured (red flags) */
  overShare: number
  /** manufactured triangles standing clear of STEP (blue flags) */
  underShare: number
  /** true when either share clears the keep bar — worth running the full boolean */
  found: boolean
}

/** Largest input the fast presence probe attempts (bigger skips straight to the full path). */
export const PROBE_TRIANGLE_BUDGET = 60_000

/**
 * Fast diff-presence check, no CSG: symmetric per-triangle clearance shares
 * (~0.1–0.5 s on real parts vs seconds for the full boolean). Lets the viewer
 * report "differences found, building the full overlay" long before the exact
 * solids land. Returns null when it cannot tell (both sides empty or huge
 * inputs); an empty-vs-solid pair reports a total diff, not null.
 * A negative is not a clean bill — flush void fills (chunky but fully
 * touching) only show up in the full boolean.
 */
export function probeDiffPresence(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
): DiffPresence | null {
  const primary = toWorldSoup(primaryParts, primaryMatrix)
  const compare = toWorldSoup(compareParts, compareMatrix)
  const triTotal =
    Math.floor(primary.triangles.length / 3) + Math.floor(compare.triangles.length / 3)
  if (triTotal === 0 || triTotal > PROBE_TRIANGLE_BUDGET) return null
  const queryPrimary = createMeshQuery(primary.vertices, primary.triangles, KEEP_CLEAR_MM)
  const queryCompare = createMeshQuery(compare.vertices, compare.triangles, KEEP_CLEAR_MM)
  const overShare = diffFraction(queryPrimary.flagFar(compare.vertices, compare.triangles))
  const underShare = diffFraction(queryCompare.flagFar(primary.vertices, primary.triangles))
  return {
    overShare,
    underShare,
    found: Math.max(overShare, underShare) >= KEEP_CLEAR_SHARE,
  }
}

/**
 * Runs both boolean directions between the manufactured (`primaryParts`) and STEP
 * (`compareParts`) tessellations, keeping only drawable faces on each side.
 * Returns null when the inputs are over budget or the CSG kernel fails — the caller
 * falls back to surface-distance flagging.
 */
export function booleanDiff(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
): BooleanDiff | null {
  const raw = booleanDiffRaw(primaryParts, compareParts, primaryMatrix, compareMatrix)
  if (!raw) return null
  const primary = toWorldSoup(primaryParts, primaryMatrix)
  const compare = toWorldSoup(compareParts, compareMatrix)
  let overFiltered: BufferGeometry | null = null
  let underFiltered: BufferGeometry | null = null
  let overVolume = 0
  let underVolume = 0
  // Clearance is measured against the OPPOSING mesh: over (STEP − manufactured)
  // sticks out of manufactured, under (manufactured − STEP) sticks out of STEP.
  // Measuring against the solid's own source mesh reads ~0 everywhere and hides
  // everything. One query per side — the spatial index builds once, not per
  // component (that rebuild was the filter's main cost).
  const queryPrimary = createMeshQuery(primary.vertices, primary.triangles, KEEP_CLEAR_MM)
  const queryCompare = createMeshQuery(compare.vertices, compare.triangles, KEEP_CLEAR_MM)
  let overDistance: number[] = []
  let underDistance: number[] = []
  if (raw.over) {
    const filtered = filterDrawableFaces(raw.over, queryPrimary)
    const pruned = pruneThinSkin(filtered.geometry, SKIN_MAX_THICKNESS_MM)
    // Smooth, then prune once more: the smoothing can pull faces back within the gap, so a
    // second pass clears the skin it re-formed.
    const smoothed = smoothGeometry(pruned.geometry)
    overFiltered = pruneThinSkin(smoothed, SKIN_MAX_THICKNESS_MM).geometry
    overVolume = filtered.volume
    overDistance = filtered.distances.filter((_, i) => pruned.keep[i] === 1)
    raw.over.dispose()
  }
  if (raw.under) {
    const filtered = filterDrawableFaces(raw.under, queryCompare)
    const pruned = pruneThinSkin(filtered.geometry, SKIN_MAX_THICKNESS_MM)
    const smoothed = smoothGeometry(pruned.geometry)
    underFiltered = pruneThinSkin(smoothed, SKIN_MAX_THICKNESS_MM).geometry
    underVolume = filtered.volume
    underDistance = filtered.distances.filter((_, i) => pruned.keep[i] === 1)
    raw.under.dispose()
  }
  return {
    over: overFiltered,
    under: underFiltered,
    overDistance,
    underDistance,
    overVolume,
    underVolume,
    primaryVolume: raw.primaryVolume,
  }
}

interface CachedDiff {
  matrixKey: string
  overPos: Float32Array | null
  underPos: Float32Array | null
  overDistance: number[]
  underDistance: number[]
  overVolume: number
  underVolume: number
  primaryVolume: number
}

// Remount-speed cache: reopening a part must not rerun CSG. Keyed by the input
// byte identity (same objects the mesh cache keys on) plus the seating
// matrices (stock changes reseat the models). Payloads are plain arrays — no
// GPU handles — so evicted entries GC cleanly; three geometries are rebuilt
// fresh per call (milliseconds) and stay caller-disposed.
const diffCache = new WeakMap<Uint8Array, WeakMap<Uint8Array, CachedDiff>>()

function geometryFromPositions(positions: Float32Array): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions.slice(), 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}

/**
 * Memoised {@link booleanDiff} for the viewer: same inputs (same STEP byte
 * objects, same seating) rebuild the overlay meshes from cached positions
 * instead of rerunning CSG.
 */
export function cachedBooleanDiff(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
  primaryBytes: Uint8Array,
  compareBytes: Uint8Array,
): BooleanDiff | null {
  const matrixKey = `${primaryMatrix.elements.join(',')}|${compareMatrix.elements.join(',')}`
  const hit = diffCache.get(primaryBytes)?.get(compareBytes)
  if (hit && hit.matrixKey === matrixKey) {
    return {
      over: hit.overPos ? geometryFromPositions(hit.overPos) : null,
      under: hit.underPos ? geometryFromPositions(hit.underPos) : null,
      overDistance: [...hit.overDistance],
      underDistance: [...hit.underDistance],
      overVolume: hit.overVolume,
      underVolume: hit.underVolume,
      primaryVolume: hit.primaryVolume,
    }
  }
  const result = booleanDiff(primaryParts, compareParts, primaryMatrix, compareMatrix)
  if (!result) return null
  const positions = (geometry: BufferGeometry | null) => {
    const array = geometry?.getAttribute('position')?.array as Float32Array | undefined
    return array ? (array.slice() as Float32Array) : null
  }
  let byPrimary = diffCache.get(primaryBytes)
  if (!byPrimary) {
    byPrimary = new WeakMap()
    diffCache.set(primaryBytes, byPrimary)
  }
  byPrimary.set(compareBytes, {
    matrixKey,
    overPos: positions(result.over),
    underPos: positions(result.under),
    overDistance: [...result.overDistance],
    underDistance: [...result.underDistance],
    overVolume: result.overVolume,
    underVolume: result.underVolume,
    primaryVolume: result.primaryVolume,
  })
  return result
}
