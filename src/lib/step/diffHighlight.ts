/**
 * Mesh-to-mesh difference highlighting for the viewer's overlay tab.
 *
 * The overlay seats the manufactured (NC-built) model and the STEP model in the same
 * frame and draws one translucent over the other. That alone doesn't say *where* they
 * disagree, so this module compares the two tessellated surfaces triangle-by-triangle:
 * any triangle whose surface sits further than `tolerance` from the other model is
 * flagged, and the viewer paints those faces red.
 *
 * Method: for each source vertex, look up nearby target triangles through a uniform
 * grid (each triangle is filed under every cell its tolerance-expanded bbox touches,
 * so large flat triangles are still found) and take the minimum point-to-triangle
 * distance. A triangle counts as different when any of its three vertices is further
 * than `tolerance` from the other surface. Symmetric — both sides are tested, so an
 * extra hole rim on the STEP side and a missing cut on the NC side both light up.
 */

/** Picks a diff tolerance from the model's bounding-box diagonal (mm). */
export function resolveDiffTolerance(diagonal: number): number {
  if (!Number.isFinite(diagonal) || diagonal <= 0) return 1.5
  return Math.min(2, Math.max(1, diagonal * 0.002))
}

export function pointTriangleDistanceSquared(
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
): number {
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
  // Vertex A region (or degenerate triangle — fall back to vertex distances).
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz

  const bpx = px - bx
  const bpy = py - by
  const bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz

  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    const qx = ax + abx * v - px
    const qy = ay + aby * v - py
    const qz = az + abz * v - pz
    return qx * qx + qy * qy + qz * qz
  }

  const cpx = px - cx
  const cpy = py - cy
  const cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz

  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    const qx = ax + acx * w - px
    const qy = ay + acy * w - py
    const qz = az + acz * w - pz
    return qx * qx + qy * qy + qz * qz
  }

  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    const qx = bx + (cx - bx) * w - px
    const qy = by + (cy - by) * w - py
    const qz = bz + (cz - bz) * w - pz
    return qx * qx + qy * qy + qz * qz
  }

  // Inside the face — distance along the normal.
  const nx = aby * acz - abz * acy
  const ny = abz * acx - abx * acz
  const nz = abx * acy - aby * acx
  const denom = nx * nx + ny * ny + nz * nz
  if (denom === 0) {
    // Degenerate (collinear) triangle — nearest vertex wins.
    const db = bpx * bpx + bpy * bpy + bpz * bpz
    const dc = cpx * cpx + cpy * cpy + cpz * cpz
    const da = apx * apx + apy * apy + apz * apz
    return Math.min(da, db, dc)
  }
  const dist = (nx * apx + ny * apy + nz * apz) / Math.sqrt(denom)
  return dist * dist
}

function cellKey(ix: number, iy: number, iz: number): string {
  return `${ix},${iy},${iz}`
}

/**
 * Files every triangle under each grid cell its tolerance-expanded bbox touches.
 * Expanded bboxes guarantee a query point finds any triangle whose surface passes
 * within `tolerance` — including huge triangles whose centroid is far away.
 * Cell size is a pure performance knob (correctness holds for any size): 8 mm
 * keeps long flange triangles to hundreds of entries instead of tens of
 * thousands. Spans are clamped per axis as a backstop against degenerate
 * (near-infinite-bbox) triangles — beyond the clamp only the centroid cell is
 * filed, degrading to a conservative maybe-far answer for garbage input.
 */
const MAX_CELLS_PER_AXIS = 512

function buildTriangleIndex(
  vertices: number[],
  triangles: number[],
  tolerance: number,
  cell: number,
): Map<string, number[]> {
  const index = new Map<string, number[]>()
  const triCount = Math.floor(triangles.length / 3)
  for (let t = 0; t < triCount; t++) {
    const i0 = triangles[t * 3] * 3
    const i1 = triangles[t * 3 + 1] * 3
    const i2 = triangles[t * 3 + 2] * 3
    if (i0 + 2 >= vertices.length || i1 + 2 >= vertices.length || i2 + 2 >= vertices.length)
      continue
    const minX = Math.min(vertices[i0], vertices[i1], vertices[i2]) - tolerance
    const minY = Math.min(vertices[i0 + 1], vertices[i1 + 1], vertices[i2 + 1]) - tolerance
    const minZ = Math.min(vertices[i0 + 2], vertices[i1 + 2], vertices[i2 + 2]) - tolerance
    const maxX = Math.max(vertices[i0], vertices[i1], vertices[i2]) + tolerance
    const maxY = Math.max(vertices[i0 + 1], vertices[i1 + 1], vertices[i2 + 1]) + tolerance
    const maxZ = Math.max(vertices[i0 + 2], vertices[i1 + 2], vertices[i2 + 2]) + tolerance
    const x0 = Math.floor(minX / cell)
    const x1 = Math.floor(maxX / cell)
    const y0 = Math.floor(minY / cell)
    const y1 = Math.floor(maxY / cell)
    const z0 = Math.floor(minZ / cell)
    const z1 = Math.floor(maxZ / cell)
    if (
      x1 - x0 > MAX_CELLS_PER_AXIS ||
      y1 - y0 > MAX_CELLS_PER_AXIS ||
      z1 - z0 > MAX_CELLS_PER_AXIS
    ) {
      const key = cellKey(
        Math.floor((minX + maxX) / 2 / cell),
        Math.floor((minY + maxY) / 2 / cell),
        Math.floor((minZ + maxZ) / 2 / cell),
      )
      let list = index.get(key)
      if (!list) {
        list = []
        index.set(key, list)
      }
      list.push(t)
      continue
    }
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const key = cellKey(ix, iy, iz)
          let list = index.get(key)
          if (!list) {
            list = []
            index.set(key, list)
          }
          list.push(t)
        }
      }
    }
  }
  return index
}

function minDistanceSquaredToMesh(
  px: number,
  py: number,
  pz: number,
  vertices: number[],
  triangles: number[],
  candidates: number[] | undefined,
): number {
  if (!candidates || candidates.length === 0) return Number.POSITIVE_INFINITY
  let best = Number.POSITIVE_INFINITY
  // Dense tessellation can stack many small triangles in one cell — cap the work
  // per query; the closest of the first couple hundred is near enough for a
  // yes/no test (cells are 8 mm, so the cap only binds in genuinely dense spots).
  const limit = Math.min(candidates.length, 192)
  for (let k = 0; k < limit; k++) {
    const t = candidates[k]
    const i0 = triangles[t * 3] * 3
    const i1 = triangles[t * 3 + 1] * 3
    const i2 = triangles[t * 3 + 2] * 3
    if (i0 + 2 >= vertices.length || i1 + 2 >= vertices.length || i2 + 2 >= vertices.length)
      continue
    const d = pointTriangleDistanceSquared(
      px,
      py,
      pz,
      vertices[i0],
      vertices[i0 + 1],
      vertices[i0 + 2],
      vertices[i1],
      vertices[i1 + 1],
      vertices[i1 + 2],
      vertices[i2],
      vertices[i2 + 1],
      vertices[i2 + 2],
    )
    if (d < best) {
      best = d
      if (best === 0) return 0
    }
  }
  return best
}

export interface MeshDiff {
  /** per-triangle flags for `aTriangles` (1 = further than tolerance off mesh B) */
  aDiff: Uint8Array
  /** per-triangle flags for `bTriangles` (1 = further than tolerance off mesh A) */
  bDiff: Uint8Array
}

/**
 * A target mesh with its spatial index built once, for repeated distance
 * queries (per-component filtering builds the index once per side instead of
 * once per component).
 */
export interface MeshQuery {
  tolerance: number
  /**
   * Flags the given triangles (1 = further than tolerance off the target).
   * `aTriangles` index into `aVertices`; a triangle is different when any of
   * its three vertices is.
   */
  flagFar(aVertices: number[], aTriangles: number[]): Uint8Array
  /**
   * Maximum vertex distance per triangle (same order as `aTriangles`). Used to
   * graduate rendering strength: faint just past tolerance, solid further out.
   * Vertices with no nearby target triangles report Infinity.
   */
  distances(aVertices: number[], aTriangles: number[]): Float32Array
  /**
   * Flags a triangle when the majority of a set of samples spread across it (corners, edge
   * midpoints, centre) stand further than the tolerance from the target. A coarse OCC triangle
   * that straddles the diff boundary — or bridges a notch both models share — is classified by
   * where most of its surface falls, not by one corner, so the flagged region tracks the real
   * boundary instead of ballooning over — or punching holes in — a flat face.
   */
  flagFarBySamples(aVertices: number[], aTriangles: number[]): Uint8Array
}

/** Builds the reusable query state for a target mesh. */
export function createMeshQuery(
  targetVertices: number[],
  targetTriangles: number[],
  tolerance: number,
): MeshQuery {
  const cell = Math.max(8, tolerance * 2)
  const index = buildTriangleIndex(targetVertices, targetTriangles, tolerance, cell)
  const tolSquared = tolerance * tolerance
  const vertexDistance = (px: number, py: number, pz: number): number => {
    const distance = minDistanceSquaredToMesh(
      px,
      py,
      pz,
      targetVertices,
      targetTriangles,
      index.get(cellKey(Math.floor(px / cell), Math.floor(py / cell), Math.floor(pz / cell))),
    )
    return Math.sqrt(distance)
  }
  return {
    tolerance,
    flagFar(aVertices: number[], aTriangles: number[]): Uint8Array {
      const triCount = Math.floor(aTriangles.length / 3)
      const mask = new Uint8Array(triCount)
      for (let t = 0; t < triCount; t++) {
        for (let k = 0; k < 3; k++) {
          const vi = aTriangles[t * 3 + k] ?? 0
          const px = aVertices[vi * 3] ?? 0
          const py = aVertices[vi * 3 + 1] ?? 0
          const pz = aVertices[vi * 3 + 2] ?? 0
          const distance = minDistanceSquaredToMesh(
            px,
            py,
            pz,
            targetVertices,
            targetTriangles,
            index.get(cellKey(Math.floor(px / cell), Math.floor(py / cell), Math.floor(pz / cell))),
          )
          if (!(distance <= tolSquared)) {
            mask[t] = 1
            break
          }
        }
      }
      return mask
    },
    distances(aVertices: number[], aTriangles: number[]): Float32Array {
      const triCount = Math.floor(aTriangles.length / 3)
      const out = new Float32Array(triCount)
      for (let t = 0; t < triCount; t++) {
        let best = 0
        for (let k = 0; k < 3; k++) {
          const vi = aTriangles[t * 3 + k] ?? 0
          const d = vertexDistance(
            aVertices[vi * 3] ?? 0,
            aVertices[vi * 3 + 1] ?? 0,
            aVertices[vi * 3 + 2] ?? 0,
          )
          if (d > best) best = d
        }
        out[t] = best
      }
      return out
    },
    flagFarBySamples(aVertices: number[], aTriangles: number[]): Uint8Array {
      const triCount = Math.floor(aTriangles.length / 3)
      const mask = new Uint8Array(triCount)
      for (let t = 0; t < triCount; t++) {
        const ia = (aTriangles[t * 3] ?? 0) * 3
        const ib = (aTriangles[t * 3 + 1] ?? 0) * 3
        const ic = (aTriangles[t * 3 + 2] ?? 0) * 3
        const ax = aVertices[ia] ?? 0
        const ay = aVertices[ia + 1] ?? 0
        const az = aVertices[ia + 2] ?? 0
        const bx = aVertices[ib] ?? 0
        const by = aVertices[ib + 1] ?? 0
        const bz = aVertices[ib + 2] ?? 0
        const cx = aVertices[ic] ?? 0
        const cy = aVertices[ic + 1] ?? 0
        const cz = aVertices[ic + 2] ?? 0
        const samples: [number, number, number][] = [
          [ax, ay, az],
          [bx, by, bz],
          [cx, cy, cz],
          [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2],
          [(bx + cx) / 2, (by + cy) / 2, (bz + cz) / 2],
          [(cx + ax) / 2, (cy + ay) / 2, (cz + az) / 2],
          [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3],
        ]
        let far = 0
        for (const p of samples) if (vertexDistance(p[0], p[1], p[2]) > tolerance) far++
        if (far * 2 >= samples.length) mask[t] = 1
      }
      return mask
    },
  }
}

/**
 * Compares two triangle soups (flat xyz vertices + flat triangle indices) and flags
 * the triangles on each side that sit further than `tolerance` (mm) from the other
 * surface. `by` picks the sample: `vertex` (any vertex off, the sensitive default) or
 * `samples` (majority of a spread of points — steadier on the coarse OCC tessellation).
 */
export function computeDiffMasks(
  aVertices: number[],
  aTriangles: number[],
  bVertices: number[],
  bTriangles: number[],
  tolerance: number,
  by: 'vertex' | 'samples' = 'vertex',
): MeshDiff {
  const aTriCount = Math.floor(aTriangles.length / 3)
  const bTriCount = Math.floor(bTriangles.length / 3)
  if (aTriCount === 0 || bTriCount === 0) {
    // One side has no surface at all — everything on the other side is different.
    const aDiff = new Uint8Array(aTriCount)
    const bDiff = new Uint8Array(bTriCount)
    aDiff.fill(aTriCount === 0 ? 0 : 1)
    bDiff.fill(bTriCount === 0 ? 0 : 1)
    return { aDiff, bDiff }
  }
  const flag = (query: MeshQuery, vertices: number[], triangles: number[]): Uint8Array =>
    by === 'samples'
      ? query.flagFarBySamples(vertices, triangles)
      : query.flagFar(vertices, triangles)
  return {
    aDiff: flag(createMeshQuery(bVertices, bTriangles, tolerance), aVertices, aTriangles),
    bDiff: flag(createMeshQuery(aVertices, aTriangles, tolerance), bVertices, bTriangles),
  }
}

/** Fraction of flagged triangles (0–1), for the overlay legend. */
export function diffFraction(mask: Uint8Array): number {
  if (mask.length === 0) return 0
  let flagged = 0
  for (const value of mask) flagged += value
  return flagged / mask.length
}

/**
 * Closes a per-triangle flag mask over the mesh topology so a real diff region reads as one
 * patch instead of tessellation-scale stipple: an unflagged triangle whose neighbours are mostly
 * flagged (a hole inside the region) is filled, and a lone flagged triangle with no flagged
 * neighbour (a speck) is dropped. A few rounds; neighbours are triangles sharing a welded
 * vertex, so it holds whether or not the tessellation shares vertex indices.
 */
export function closeDiffMask(
  vertices: number[],
  triangles: number[],
  mask: Uint8Array,
  rounds = 2,
): Uint8Array {
  const triCount = Math.floor(triangles.length / 3)
  if (triCount === 0) return mask
  const keyOf = (vi: number): string => {
    const o = vi * 3
    return `${Math.round((vertices[o] ?? 0) * 100)},${Math.round((vertices[o + 1] ?? 0) * 100)},${Math.round((vertices[o + 2] ?? 0) * 100)}`
  }
  const byVertex = new Map<string, number[]>()
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const key = keyOf(triangles[t * 3 + k] ?? 0)
      const list = byVertex.get(key)
      if (list) {
        if (list[list.length - 1] !== t) list.push(t)
      } else byVertex.set(key, [t])
    }
  }
  const neighbours: number[][] = new Array(triCount)
  for (let t = 0; t < triCount; t++) {
    const set = new Set<number>()
    for (let k = 0; k < 3; k++) {
      const list = byVertex.get(keyOf(triangles[t * 3 + k] ?? 0))
      if (list) for (const s of list) if (s !== t) set.add(s)
    }
    neighbours[t] = [...set]
  }

  let current = mask
  for (let round = 0; round < rounds; round++) {
    const next = current.slice()
    for (let t = 0; t < triCount; t++) {
      const nb = neighbours[t] ?? []
      if (nb.length === 0) continue
      let flagged = 0
      for (const s of nb) if (current[s] === 1) flagged++
      if (current[t] === 1) {
        if (flagged === 0 && nb.length >= 3) next[t] = 0
      } else if (flagged * 2 >= nb.length) {
        next[t] = 1
      }
    }
    current = next
  }
  return current
}
