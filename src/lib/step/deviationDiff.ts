import { BufferGeometry, Float32BufferAttribute, type Matrix4 } from 'three'
import { type BooleanDiff, type DiffSoup, toWorldSoup } from './booleanDiff'

/**
 * Signed-distance deviation diff (nominal vs actual).
 *
 * The overlay compares the manufactured (NC-reconstructed) model against the STEP ideal. Those two
 * models describe the same part but are built independently, so their surfaces nearly coincide
 * without ever matching. A boolean difference of two near-coincident meshes is ill-conditioned and
 * produces slivers/skins that no amount of post-filtering fixes (see docs/architecture.md).
 *
 * Instead this measures the **signed distance** from every manufactured surface point to the ideal
 * surface — the industry-standard "deviation analysis" (Creo, GOM, Dragonfly, pyvista). There is no
 * surface intersection, so near-coincidence is harmless.
 *
 * Sign convention (matching the legend):
 * - `over` (red): the manufactured surface sits *inside* the ideal — material removed that the
 *   ideal keeps (deviation negative). Scrap.
 * - `under` (blue): the manufactured surface sits *outside* the ideal — leftover material the
 *   ideal lacks (deviation positive). Rework.
 *
 * The sign uses the pseudo-normal rule (libigl `SIGNED_DISTANCE_TYPE_PSEUDONORMAL`): which side of
 * the nearest ideal triangle's normal the point lies on. Robust for watertight inputs and cheap.
 */

/** Distance (mm) beyond which the manufactured surface counts as over/under the nominal. */
export const DEVIATION_TOLERANCE_MM = 0.15

/** Largest combined input the deviation path attempts (per-triangle, both models). */
export const DEVIATION_TRIANGLE_BUDGET = 400_000

/** Closest-point index cell size (mm), how many rings to search, and the huge-triangle cell cap. */
const CELL_MM = 4
const MAX_RING = 3
const MAX_CELLS = 200_000

interface ClosestHit {
  d2: number
  qx: number
  qy: number
  qz: number
  nx: number
  ny: number
  nz: number
}

function triangleCount(soup: DiffSoup): number {
  return Math.floor(soup.triangles.length / 3)
}

function cellKey(ix: number, iy: number, iz: number): string {
  return `${ix},${iy},${iz}`
}

/** Files every triangle under each cell its bounding box touches (centroid-only for huge ones). */
function buildIndex(soup: DiffSoup, cell: number): Map<string, number[]> {
  const index = new Map<string, number[]>()
  const { vertices, triangles } = soup
  const triCount = triangleCount(soup)
  for (let t = 0; t < triCount; t++) {
    const a = (triangles[t * 3] ?? 0) * 3
    const b = (triangles[t * 3 + 1] ?? 0) * 3
    const c = (triangles[t * 3 + 2] ?? 0) * 3
    const minX = Math.min(vertices[a] as number, vertices[b] as number, vertices[c] as number)
    const minY = Math.min(
      vertices[a + 1] as number,
      vertices[b + 1] as number,
      vertices[c + 1] as number,
    )
    const minZ = Math.min(
      vertices[a + 2] as number,
      vertices[b + 2] as number,
      vertices[c + 2] as number,
    )
    const maxX = Math.max(vertices[a] as number, vertices[b] as number, vertices[c] as number)
    const maxY = Math.max(
      vertices[a + 1] as number,
      vertices[b + 1] as number,
      vertices[c + 1] as number,
    )
    const maxZ = Math.max(
      vertices[a + 2] as number,
      vertices[b + 2] as number,
      vertices[c + 2] as number,
    )
    const x0 = Math.floor(minX / cell)
    const x1 = Math.floor(maxX / cell)
    const y0 = Math.floor(minY / cell)
    const y1 = Math.floor(maxY / cell)
    const z0 = Math.floor(minZ / cell)
    const z1 = Math.floor(maxZ / cell)
    const huge = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > MAX_CELLS
    if (huge) {
      const key = cellKey(
        Math.floor((minX + maxX) / 2 / cell),
        Math.floor((minY + maxY) / 2 / cell),
        Math.floor((minZ + maxZ) / 2 / cell),
      )
      const list = index.get(key)
      if (list) list.push(t)
      else index.set(key, [t])
      continue
    }
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const key = cellKey(ix, iy, iz)
          const list = index.get(key)
          if (list) list.push(t)
          else index.set(key, [t])
        }
      }
    }
  }
  return index
}

/** Ericson: closest point on the triangle plus the (unnormalised-then-normalised) face normal. */
function closestOnTriangle(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): ClosestHit {
  const abx = bx - ax
  const aby = by - ay
  const abz = bz - az
  const acx = cx - ax
  const acy = cy - ay
  const acz = cz - az
  const apx = px - ax
  const apy = py - ay
  const apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  let qx = ax
  let qy = ay
  let qz = az
  if (!(d1 <= 0 && d2 <= 0)) {
    const bpx = px - bx
    const bpy = py - by
    const bpz = pz - bz
    const d3 = abx * bpx + aby * bpy + abz * bpz
    const d4 = acx * bpx + acy * bpy + acz * bpz
    if (d3 >= 0 && d4 <= d3) {
      qx = bx
      qy = by
      qz = bz
    } else {
      const vc = d1 * d4 - d3 * d2
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3)
        qx = ax + abx * v
        qy = ay + aby * v
        qz = az + abz * v
      } else {
        const cpx = px - cx
        const cpy = py - cy
        const cpz = pz - cz
        const d5 = abx * cpx + aby * cpy + abz * cpz
        const d6 = acx * cpx + acy * cpy + acz * cpz
        if (d6 >= 0 && d5 <= d6) {
          qx = cx
          qy = cy
          qz = cz
        } else {
          const vb = d5 * d2 - d1 * d6
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6)
            qx = ax + acx * w
            qy = ay + acy * w
            qz = az + acz * w
          } else {
            const va = d3 * d6 - d5 * d4
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
              qx = bx + (cx - bx) * w
              qy = by + (cy - by) * w
              qz = bz + (cz - bz) * w
            } else {
              const den = 1 / (va + vb + vc)
              const v = vb * den
              const w = vc * den
              qx = ax + abx * v + acx * w
              qy = ay + aby * v + acy * w
              qz = az + abz * v + acz * w
            }
          }
        }
      }
    }
  }
  const dx = qx - px
  const dy = qy - py
  const dz = qz - pz
  let nx = aby * acz - abz * acy
  let ny = abz * acx - abx * acz
  let nz = abx * acy - aby * acx
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len
  ny /= len
  nz /= len
  return { d2: dx * dx + dy * dy + dz * dz, qx, qy, qz, nx, ny, nz }
}

/** Signed distance from one point to the indexed target mesh (pseudo-normal sign). */
function signedDistanceToPoint(
  px: number,
  py: number,
  pz: number,
  target: DiffSoup,
  index: Map<string, number[]>,
  cell: number,
): number {
  const { vertices, triangles } = target
  let best = Number.POSITIVE_INFINITY
  let hit: ClosestHit | null = null
  const gx = Math.floor(px / cell)
  const gy = Math.floor(py / cell)
  const gz = Math.floor(pz / cell)
  // Search the whole ±MAX_RING cell box (no early break: a triangle's bbox can touch a near cell
  // while its surface — and the true nearest point — lies in a farther one).
  for (let ix = gx - MAX_RING; ix <= gx + MAX_RING; ix++) {
    for (let iy = gy - MAX_RING; iy <= gy + MAX_RING; iy++) {
      for (let iz = gz - MAX_RING; iz <= gz + MAX_RING; iz++) {
        const list = index.get(cellKey(ix, iy, iz))
        if (!list) continue
        for (const t of list) {
          const a = (triangles[t * 3] ?? 0) * 3
          const b = (triangles[t * 3 + 1] ?? 0) * 3
          const c = (triangles[t * 3 + 2] ?? 0) * 3
          const res = closestOnTriangle(
            px,
            py,
            pz,
            vertices[a] as number,
            vertices[a + 1] as number,
            vertices[a + 2] as number,
            vertices[b] as number,
            vertices[b + 1] as number,
            vertices[b + 2] as number,
            vertices[c] as number,
            vertices[c + 1] as number,
            vertices[c + 2] as number,
          )
          if (res.d2 < best) {
            best = res.d2
            hit = res
          }
        }
      }
    }
  }
  if (!hit) {
    // Nothing in the searched neighbourhood: brute force the whole target once.
    const triCount = triangleCount(target)
    for (let t = 0; t < triCount; t++) {
      const a = (triangles[t * 3] ?? 0) * 3
      const b = (triangles[t * 3 + 1] ?? 0) * 3
      const c = (triangles[t * 3 + 2] ?? 0) * 3
      const res = closestOnTriangle(
        px,
        py,
        pz,
        vertices[a] as number,
        vertices[a + 1] as number,
        vertices[a + 2] as number,
        vertices[b] as number,
        vertices[b + 1] as number,
        vertices[b + 2] as number,
        vertices[c] as number,
        vertices[c + 1] as number,
        vertices[c + 2] as number,
      )
      if (res.d2 < best) {
        best = res.d2
        hit = res
      }
    }
  }
  if (!hit) return 0
  const dist = Math.sqrt(best)
  const side = (px - hit.qx) * hit.nx + (py - hit.qy) * hit.ny + (pz - hit.qz) * hit.nz
  return side >= 0 ? dist : -dist
}

/** Signed volume (mm³) of a closed soup; sign follows the winding (outward ⇒ positive). */
function signedVolume({ vertices, triangles }: DiffSoup): number {
  let volume = 0
  for (let t = 0; t < triangleCount({ vertices, triangles }); t++) {
    const a = (triangles[t * 3] ?? 0) * 3
    const b = (triangles[t * 3 + 1] ?? 0) * 3
    const c = (triangles[t * 3 + 2] ?? 0) * 3
    const ax = vertices[a] as number
    const ay = vertices[a + 1] as number
    const az = vertices[a + 2] as number
    const bx = vertices[b] as number
    const by = vertices[b + 1] as number
    const bz = vertices[b + 2] as number
    const cx = vertices[c] as number
    const cy = vertices[c + 1] as number
    const cz = vertices[c + 2] as number
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  return volume
}

function geometryFromPositions(positions: number[]): BufferGeometry | null {
  if (positions.length === 0) return null
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}

/**
 * Computes the signed-distance deviation between the manufactured (`primaryParts`) and STEP
 * (`compareParts`) tessellations, tagging every manufactured triangle whose mean deviation clears
 * `tolerance` as overcut (red) or undercut (blue). Returns the same shape as {@link BooleanDiff}
 * so the viewer treats it identically. Returns null when the inputs are empty or over budget.
 */
export function deviationDiff(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
  tolerance = DEVIATION_TOLERANCE_MM,
): BooleanDiff | null {
  const primary = toWorldSoup(primaryParts, primaryMatrix)
  const compare = toWorldSoup(compareParts, compareMatrix)
  const primaryTris = triangleCount(primary)
  const compareTris = triangleCount(compare)
  if (primaryTris === 0 || compareTris === 0) return null
  if (primaryTris + compareTris > DEVIATION_TRIANGLE_BUDGET) return null

  // Outward normals: an inward-oriented ideal mesh would invert the pseudo-normal sign.
  const orient = signedVolume(compare) >= 0 ? 1 : -1
  const index = buildIndex(compare, CELL_MM)

  const overPositions: number[] = []
  const underPositions: number[] = []
  const overDistance: number[] = []
  const underDistance: number[] = []
  let overVolume = 0
  let underVolume = 0

  const { vertices, triangles } = primary
  for (let t = 0; t < primaryTris; t++) {
    const i0 = triangles[t * 3] ?? 0
    const i1 = triangles[t * 3 + 1] ?? 0
    const i2 = triangles[t * 3 + 2] ?? 0
    const a = i0 * 3
    const b = i1 * 3
    const c = i2 * 3
    const d0 = signedDistanceToPoint(
      vertices[a] as number,
      vertices[a + 1] as number,
      vertices[a + 2] as number,
      compare,
      index,
      CELL_MM,
    )
    const d1 = signedDistanceToPoint(
      vertices[b] as number,
      vertices[b + 1] as number,
      vertices[b + 2] as number,
      compare,
      index,
      CELL_MM,
    )
    const d2 = signedDistanceToPoint(
      vertices[c] as number,
      vertices[c + 1] as number,
      vertices[c + 2] as number,
      compare,
      index,
      CELL_MM,
    )
    const dev = (orient * (d0 + d1 + d2)) / 3
    if (dev <= -tolerance) {
      overPositions.push(
        vertices[a] as number,
        vertices[a + 1] as number,
        vertices[a + 2] as number,
        vertices[b] as number,
        vertices[b + 1] as number,
        vertices[b + 2] as number,
        vertices[c] as number,
        vertices[c + 1] as number,
        vertices[c + 2] as number,
      )
      overDistance.push(-dev)
      overVolume += triangleArea(vertices, a, b, c) * -dev
    } else if (dev >= tolerance) {
      underPositions.push(
        vertices[a] as number,
        vertices[a + 1] as number,
        vertices[a + 2] as number,
        vertices[b] as number,
        vertices[b + 1] as number,
        vertices[b + 2] as number,
        vertices[c] as number,
        vertices[c + 1] as number,
        vertices[c + 2] as number,
      )
      underDistance.push(dev)
      underVolume += triangleArea(vertices, a, b, c) * dev
    }
  }

  return {
    over: geometryFromPositions(overPositions),
    under: geometryFromPositions(underPositions),
    overDistance,
    underDistance,
    overVolume,
    underVolume,
    primaryVolume: Math.abs(signedVolume(primary)),
  }
}

function triangleArea(vertices: number[], a: number, b: number, c: number): number {
  const ux = (vertices[b] as number) - (vertices[a] as number)
  const uy = (vertices[b + 1] as number) - (vertices[a + 1] as number)
  const uz = (vertices[b + 2] as number) - (vertices[a + 2] as number)
  const vx = (vertices[c] as number) - (vertices[a] as number)
  const vy = (vertices[c + 1] as number) - (vertices[a + 1] as number)
  const vz = (vertices[c + 2] as number) - (vertices[a + 2] as number)
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
}

interface CachedDeviation {
  matrixKey: string
  tolerance: number
  overPos: Float32Array | null
  underPos: Float32Array | null
  overDistance: number[]
  underDistance: number[]
  overVolume: number
  underVolume: number
  primaryVolume: number
}

const deviationCache = new WeakMap<Uint8Array, WeakMap<Uint8Array, CachedDeviation>>()

function geometryFromArray(positions: Float32Array): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions.slice(), 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}

/**
 * Memoised {@link deviationDiff} for the viewer: same inputs (same STEP byte objects, same seating,
 * same tolerance) rebuild the overlay meshes from cached positions instead of re-measuring.
 */
export function cachedDeviationDiff(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
  primaryBytes: Uint8Array,
  compareBytes: Uint8Array,
  tolerance = DEVIATION_TOLERANCE_MM,
): BooleanDiff | null {
  const matrixKey = `${primaryMatrix.elements.join(',')}|${compareMatrix.elements.join(',')}`
  const hit = deviationCache.get(primaryBytes)?.get(compareBytes)
  if (hit && hit.matrixKey === matrixKey && hit.tolerance === tolerance) {
    return {
      over: hit.overPos ? geometryFromArray(hit.overPos) : null,
      under: hit.underPos ? geometryFromArray(hit.underPos) : null,
      overDistance: [...hit.overDistance],
      underDistance: [...hit.underDistance],
      overVolume: hit.overVolume,
      underVolume: hit.underVolume,
      primaryVolume: hit.primaryVolume,
    }
  }
  const result = deviationDiff(primaryParts, compareParts, primaryMatrix, compareMatrix, tolerance)
  if (!result) return null
  const positions = (geometry: BufferGeometry | null) => {
    const array = geometry?.getAttribute('position')?.array as Float32Array | undefined
    return array ? (array.slice() as Float32Array) : null
  }
  let byPrimary = deviationCache.get(primaryBytes)
  if (!byPrimary) {
    byPrimary = new WeakMap()
    deviationCache.set(primaryBytes, byPrimary)
  }
  byPrimary.set(compareBytes, {
    matrixKey,
    tolerance,
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
