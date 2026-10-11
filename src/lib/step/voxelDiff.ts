import { BufferGeometry, Float32BufferAttribute, type Matrix4 } from 'three'
import { type BooleanDiff, type DiffSoup, toWorldSoup } from './booleanDiff'

/**
 * Voxel (occupancy) difference of the two overlay models.
 *
 * The manufactured (NC-reconstructed) and STEP models are the same part built independently, so
 * their surfaces nearly coincide. Surface booleans (three-bvh-csg, Manifold) shred that
 * near-coincidence into slivers/skins, and a per-triangle distance map paints whole coarse faces
 * because one vertex is off. A **common voxel grid** sidesteps both: each model is sampled onto the
 * same lattice, occupancy is diffed cell-wise, and the result is a bounded blocky solid whose volume
 * is exact on the grid. It is independent of the input tessellation.
 *
 * - `over` (red): occupied by ideal, empty in manufactured — overcut (scrap).
 * - `under` (blue): occupied by manufactured, empty in ideal — undercut (leftover).
 *
 * Occupancy is built by rasterising each mesh's triangles into wall cells, then a per-column
 * scanline parity fill (watertight input assumed). The 0.5 mm target is memory-bound on long parts
 * — see {@link VOXEL_BUDGET}; callers may coarsen for very long beams.
 */

/** Target voxel edge (mm). */
export const VOXEL_SIZE_MM = 0.5
/** Hard cap on lattice cells (nx·ny·nz); beyond this the call returns null rather than OOM. */
export const VOXEL_BUDGET = 400_000_000
/** Cap on emitted triangles per side, so a huge shell never returns an unbounded mesh. */
const MAX_EMIT_TRIS = 4_000_000

interface Grid {
  nx: number
  ny: number
  nz: number
  ox: number
  oy: number
  oz: number
  v: number
}

function cellIndex(g: Grid, ix: number, iy: number, iz: number): number {
  return (ix * g.ny + iy) * g.nz + iz
}

function bounds(parts: DiffSoup[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    for (let i = 0; i + 2 < p.vertices.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, p.vertices[i + k] as number)
        max[k] = Math.max(max[k] as number, p.vertices[i + k] as number)
      }
    }
  }
  return { min, max }
}

/** Marks the wall cells a triangle passes through (2D projection onto the dominant-axis plane). */
function rasterizeTriangle(
  wall: Uint8Array,
  g: Grid,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): void {
  const abx = bx - ax
  const aby = by - ay
  const abz = bz - az
  const acx = cx - ax
  const acy = cy - ay
  const acz = cz - az
  const nx = aby * acz - abz * acy
  const ny = abz * acx - abx * acz
  const nz = abx * acy - aby * acx
  const n = [nx, ny, nz]
  const an = [Math.abs(nx), Math.abs(ny), Math.abs(nz)]
  const d = an[0]! >= an[1]! && an[0]! >= an[2]! ? 0 : an[1]! >= an[2]! ? 1 : 2
  const u = (d + 1) % 3
  const w = (d + 2) % 3
  const np = n[d] as number
  if (np === 0) return
  const P = [
    [ax, ay, az],
    [bx, by, bz],
    [cx, cy, cz],
  ]
  const o = [g.ox, g.oy, g.oz]
  const nAxes = [g.nx, g.ny, g.nz]
  const gu = P.map((p) => ((p[u] as number) - (o[u] as number)) / g.v)
  const gw = P.map((p) => ((p[w] as number) - (o[w] as number)) / g.v)
  const iu0 = Math.max(0, Math.floor(Math.min(gu[0]!, gu[1]!, gu[2]!) - 1))
  const iu1 = Math.min((nAxes[u] as number) - 1, Math.ceil(Math.max(gu[0]!, gu[1]!, gu[2]!) + 1))
  const iw0 = Math.max(0, Math.floor(Math.min(gw[0]!, gw[1]!, gw[2]!) - 1))
  const iw1 = Math.min((nAxes[w] as number) - 1, Math.ceil(Math.max(gw[0]!, gw[1]!, gw[2]!) + 1))
  if (iu1 < iu0 || iw1 < iw0) return
  const e0 = (gu[1]! - gu[0]!) * (gw[2]! - gw[0]!) - (gw[1]! - gw[0]!) * (gu[2]! - gu[0]!)
  if (e0 === 0) return
  for (let iw = iw0; iw <= iw1; iw++) {
    const py = iw + 0.5
    for (let iu = iu0; iu <= iu1; iu++) {
      const px = iu + 0.5
      const b0 = ((gu[1]! - px) * (gw[2]! - py) - (gw[1]! - py) * (gu[2]! - px)) / e0
      const b1 = ((gu[2]! - px) * (gw[0]! - py) - (gw[2]! - py) * (gu[0]! - px)) / e0
      const b2 = 1 - b0 - b1
      if (b0 < 0 || b1 < 0 || b2 < 0) continue
      const worldD =
        (P[0]![d] as number) -
        ((n[u] as number) * (o[u]! + px * g.v - (P[0]![u] as number)) +
          (n[w] as number) * (o[w]! + py * g.v - (P[0]![w] as number))) /
          np
      const k = Math.floor((worldD - (o[d] as number)) / g.v)
      if (k < 0 || k >= (nAxes[d] as number)) continue
      const idxVals = [0, 0, 0]
      idxVals[d] = k
      idxVals[u] = iu
      idxVals[w] = iw
      wall[cellIndex(g, idxVals[0] as number, idxVals[1] as number, idxVals[2] as number)] = 1
    }
  }
}

function dilate(wall: Uint8Array, g: Grid): void {
  const copy = wall.slice()
  for (let ix = 0; ix < g.nx; ix++) {
    for (let iy = 0; iy < g.ny; iy++) {
      for (let iz = 0; iz < g.nz; iz++) {
        if (copy[cellIndex(g, ix, iy, iz)] !== 1) continue
        for (let d = 0; d < 3; d++) {
          for (const s of [-1, 1]) {
            const jx = ix + (d === 0 ? s : 0)
            const jy = iy + (d === 1 ? s : 0)
            const jz = iz + (d === 2 ? s : 0)
            if (jx < 0 || jy < 0 || jz < 0 || jx >= g.nx || jy >= g.ny || jz >= g.nz) continue
            wall[cellIndex(g, jx, jy, jz)] = 1
          }
        }
      }
    }
  }
}

/**
 * Fills occupancy from wall cells by a per-column scanline parity walk along z. Watertight input
 * assumed: outside until the first wall crossing, inside until the next, alternating. Wall cells
 * take the inside value of the span they close.
 */
function fillOccupancy(wall: Uint8Array, g: Grid): Uint8Array {
  // Reuse `wall` as state: 1 = wall (read), then overwritten per column with 0 (out) / 2 (in).
  for (let ix = 0; ix < g.nx; ix++) {
    for (let iy = 0; iy < g.ny; iy++) {
      let inside = false
      let iz = 0
      while (iz < g.nz) {
        const idx = cellIndex(g, ix, iy, iz)
        if (wall[idx] === 1) {
          inside = !inside
          const runStart = iz
          while (iz < g.nz && wall[cellIndex(g, ix, iy, iz)] === 1) iz++
          for (let k = runStart; k < iz; k++) wall[cellIndex(g, ix, iy, k)] = inside ? 2 : 0
        } else {
          wall[idx] = inside ? 2 : 0
          iz++
        }
      }
    }
  }
  return wall
}

function occupancyOf(soup: DiffSoup, g: Grid): Uint8Array {
  const wall = new Uint8Array(g.nx * g.ny * g.nz)
  const { vertices, triangles } = soup
  for (let t = 0; t < Math.floor(triangles.length / 3); t++) {
    const ia = (triangles[t * 3] ?? 0) * 3
    const ib = (triangles[t * 3 + 1] ?? 0) * 3
    const ic = (triangles[t * 3 + 2] ?? 0) * 3
    rasterizeTriangle(
      wall,
      g,
      vertices[ia] as number,
      vertices[ia + 1] as number,
      vertices[ia + 2] as number,
      vertices[ib] as number,
      vertices[ib + 1] as number,
      vertices[ib + 2] as number,
      vertices[ic] as number,
      vertices[ic + 1] as number,
      vertices[ic + 2] as number,
    )
  }
  dilate(wall, g)
  return fillOccupancy(wall, g)
}

/** Emits the boundary faces between `mask` cells and non-mask cells as a solid shell. */
function emitShell(
  mask: Uint8Array,
  g: Grid,
): { positions: number[]; distances: number[]; volumes: number } {
  const positions: number[] = []
  const distances: number[] = []
  const v = g.v
  const cellVol = v * v * v
  let count = 0
  let tris = 0
  const dirs: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]
  for (let ix = 0; ix < g.nx && tris < MAX_EMIT_TRIS; ix++) {
    const x0 = g.ox + ix * v
    for (let iy = 0; iy < g.ny && tris < MAX_EMIT_TRIS; iy++) {
      const y0 = g.oy + iy * v
      for (let iz = 0; iz < g.nz; iz++) {
        if (mask[cellIndex(g, ix, iy, iz)] === 0) continue
        count++
        const z0 = g.oz + iz * v
        for (const [dx, dy, dz] of dirs) {
          const jx = ix + dx
          const jy = iy + dy
          const jz = iz + dz
          const inGrid = jx >= 0 && jy >= 0 && jz >= 0 && jx < g.nx && jy < g.ny && jz < g.nz
          if (inGrid && mask[cellIndex(g, jx, jy, jz)] === 1) continue
          if (tris >= MAX_EMIT_TRIS) break
          // Face quad on the shared plane.
          const xa = dx > 0 ? x0 + v : x0
          const ya = dy > 0 ? y0 + v : y0
          const za = dz > 0 ? z0 + v : z0
          let quad: number[][]
          if (dx !== 0) {
            quad = [
              [xa, y0, z0],
              [xa, y0 + v, z0],
              [xa, y0 + v, z0 + v],
              [xa, y0, z0 + v],
            ]
          } else if (dy !== 0) {
            quad = [
              [x0, ya, z0],
              [x0 + v, ya, z0],
              [x0 + v, ya, z0 + v],
              [x0, ya, z0 + v],
            ]
          } else {
            quad = [
              [x0, y0, za],
              [x0 + v, y0, za],
              [x0 + v, y0 + v, za],
              [x0, y0 + v, za],
            ]
          }
          const [p0, p1, p2, p3] = quad as [number[], number[], number[], number[]]
          positions.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3)
          distances.push(v, v, v, v, v, v)
          tris += 2
        }
      }
    }
  }
  return { positions, distances, volumes: count * cellVol }
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
 * Voxel difference between the manufactured (`primaryParts`) and STEP (`compareParts`) models.
 * Returns the same shape as {@link BooleanDiff}. Returns null when the lattice would exceed
 * {@link VOXEL_BUDGET} (coarsen `voxelSize`) or either side is empty.
 */
export function voxelDiff(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
  voxelSize = VOXEL_SIZE_MM,
): BooleanDiff | null {
  const primary = toWorldSoup(primaryParts, primaryMatrix)
  const compare = toWorldSoup(compareParts, compareMatrix)
  if (primary.triangles.length === 0 || compare.triangles.length === 0) return null

  const b = bounds([primary, compare])
  const pad = voxelSize * 2
  const ox = (b.min[0] as number) - pad
  const oy = (b.min[1] as number) - pad
  const oz = (b.min[2] as number) - pad
  const nx = Math.ceil(((b.max[0] as number) - ox) / voxelSize) + 1
  const ny = Math.ceil(((b.max[1] as number) - oy) / voxelSize) + 1
  const nz = Math.ceil(((b.max[2] as number) - oz) / voxelSize) + 1
  const cells = nx * ny * nz
  if (cells > VOXEL_BUDGET) return null
  const g: Grid = { nx, ny, nz, ox, oy, oz, v: voxelSize }

  const occA = occupancyOf(primary, g)
  const occB = occupancyOf(compare, g)

  const overMask = new Uint8Array(cells)
  const underMask = new Uint8Array(cells)
  for (let i = 0; i < cells; i++) {
    const inA = occA[i] === 2
    const inB = occB[i] === 2
    if (inB && !inA) overMask[i] = 1
    else if (inA && !inB) underMask[i] = 1
  }

  const over = emitShell(overMask, g)
  const under = emitShell(underMask, g)
  let primaryCells = 0
  for (let i = 0; i < cells; i++) if (occA[i] === 2) primaryCells++

  return {
    over: geometryFromPositions(over.positions),
    under: geometryFromPositions(under.positions),
    overDistance: over.distances,
    underDistance: under.distances,
    overVolume: over.volumes,
    underVolume: under.volumes,
    primaryVolume: primaryCells * voxelSize * voxelSize * voxelSize,
  }
}

interface CachedVoxel {
  matrixKey: string
  voxelSize: number
  overPos: Float32Array | null
  underPos: Float32Array | null
  overDistance: number[]
  underDistance: number[]
  overVolume: number
  underVolume: number
  primaryVolume: number
}

const voxelCache = new WeakMap<Uint8Array, WeakMap<Uint8Array, CachedVoxel>>()

function geometryFromArray(positions: Float32Array): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions.slice(), 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}

/**
 * Memoised {@link voxelDiff} for the viewer: same inputs (same STEP byte objects, same seating,
 * same voxel size) rebuild the blocky shells from cached positions instead of re-voxelising.
 */
export function cachedVoxelDiff(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
  primaryBytes: Uint8Array,
  compareBytes: Uint8Array,
  voxelSize = VOXEL_SIZE_MM,
): BooleanDiff | null {
  const matrixKey = `${primaryMatrix.elements.join(',')}|${compareMatrix.elements.join(',')}`
  const hit = voxelCache.get(primaryBytes)?.get(compareBytes)
  if (hit && hit.matrixKey === matrixKey && hit.voxelSize === voxelSize) {
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
  const result = voxelDiff(primaryParts, compareParts, primaryMatrix, compareMatrix, voxelSize)
  if (!result) return null
  const positions = (geometry: BufferGeometry | null) => {
    const array = geometry?.getAttribute('position')?.array as Float32Array | undefined
    return array ? (array.slice() as Float32Array) : null
  }
  let byPrimary = voxelCache.get(primaryBytes)
  if (!byPrimary) {
    byPrimary = new WeakMap()
    voxelCache.set(primaryBytes, byPrimary)
  }
  byPrimary.set(compareBytes, {
    matrixKey,
    voxelSize,
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
