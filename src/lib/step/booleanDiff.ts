import { BufferGeometry, Float32BufferAttribute, type Matrix4, Vector3 } from 'three'
import { Brush, computeMeshVolume, Evaluator, SUBTRACTION } from 'three-bvh-csg'
import { createMeshQuery, diffFraction, type MeshQuery } from './diffHighlight'

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
 * Keep bars for a diff component. A component is kept when it is big enough to
 * machine AND either enough of it stands clear of the other model or it is a
 * chunky open void fill (a notch/cope the NC left solid — every one of its
 * faces touches solid, so clearance alone can never see it). What renders
 * depends on shape: chunky components render whole, thin sheets render only
 * their far faces (a full-flange 0.04 mm skin held up by hole rims must not
 * drag the whole sheet along):
 * - SIZE_FLOOR: below a 2 mm cube it is a CSG crumb. Deliberately absolute, not
 *   relative: a real notch is real at any part size (a relative floor eats
 *   171 mm³ notch chunks on large beams);
 * - CLEAR_MM / CLEAR_SHARE: at least this share of the component's triangles
 *   sits this far off the other surface. A share, not any-vertex: one far spike
 *   (glitch triangle, hole-rim sliver) must not rescue a whole thin skin, while
 *   a wedge or slab easily clears it;
 * - OPEN_SKIN_MM: an open (mouth-missing) component at least this thick on
 *   average renders whole — a real cope, not a coplanar hairline. Closed
 *   shells are judged by clearance only — their enclosed volume says nothing
 *   about the skin (a 0.25 mm uniform oversize shell encloses the whole part).
 */
export const KEEP_SIZE_ABS_MM3 = 8
export const KEEP_CLEAR_MM = 1
export const KEEP_CLEAR_SHARE = 0.01
export const KEEP_OPEN_SKIN_MM = 0.5

export interface BooleanDiff {
  /** STEP-minus-manufactured solid (overcut, red), world coordinates (null when empty) */
  over: BufferGeometry | null
  /** manufactured-minus-STEP solid (undercut, blue), world coordinates (null when empty) */
  under: BufferGeometry | null
  /** volumes measured on what is drawn, so the legend number matches the picture */
  overVolume: number
  underVolume: number
  /** volume of the manufactured model, so the legend can show shares */
  primaryVolume: number
}

interface DiffComponent {
  triangles: number[]
  volume: number
  area: number
  /** true when every edge is shared by exactly two triangles (watertight) */
  closed: boolean
}

/** Splits a result solid into vertex-connected components with volume/area/closedness. */
export function extractComponents(geometry: BufferGeometry): DiffComponent[] {
  const position = geometry.getAttribute('position')
  const count = triangleCount(geometry)
  if (!position || count === 0) return []
  const array = position.array as Float32Array
  const index = geometry.getIndex()
  const corner = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k)

  // Union-find over triangles sharing a (1 µm-welded) vertex. Corner keys are
  // computed once up front and reused for grouping, edge-closedness and
  // volume/area below — previously re-derived per pass.
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
  const edgeUses = new Map<string, number>()
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
      const edge = [keys[t * 3 + k] ?? '', keys[t * 3 + ((k + 1) % 3)] ?? ''].sort().join('|')
      edgeUses.set(edge, (edgeUses.get(edge) ?? 0) + 1)
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
    let area = 0
    let closed = true
    const seenEdges = new Set<string>()
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
      area += Math.hypot(nx, ny, nz) / 2
      for (let k = 0; k < 3; k++) {
        const edge = [keys[t * 3 + k] ?? '', keys[t * 3 + ((k + 1) % 3)] ?? ''].sort().join('|')
        if (seenEdges.has(edge)) continue
        seenEdges.add(edge)
        if (edgeUses.get(edge) !== 2) closed = false
      }
    }
    components.push({ triangles: tris, volume: Math.abs(volume), area, closed })
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
 */
export function filterDrawableFaces(
  geometry: BufferGeometry,
  query: MeshQuery,
): { geometry: BufferGeometry | null; volume: number } {
  const { vertices, triangles } = triangleSoup(geometry)
  const count = Math.floor(triangles.length / 3)
  if (count === 0) return { geometry: null, volume: 0 }
  const floor = KEEP_SIZE_ABS_MM3
  const kept: number[] = []
  let volume = 0
  const sharedVertices = Array.from(vertices)
  for (const component of extractComponents(geometry)) {
    if (component.volume < floor) continue
    const corners: number[] = []
    for (const t of component.triangles) {
      corners.push(triangles[t * 3] ?? 0, triangles[t * 3 + 1] ?? 0, triangles[t * 3 + 2] ?? 0)
    }
    const thickness = component.area > 0 ? (2 * component.volume) / component.area : 0
    // Chunky open fills (notch copes) keep without any distance query — volume
    // and thickness are already known, so this skips the queries entirely.
    if (!component.closed && thickness >= KEEP_OPEN_SKIN_MM) {
      kept.push(...corners)
      volume += component.volume
      continue
    }
    // One query object per side — its spatial index is built once and reused
    // across every component, instead of rebuilt per component.
    const aDiff = query.flagFar(sharedVertices, corners)
    // Whole chunky component, or just the far faces of a thin sheet. Volume is
    // always the component's own — signed sums over open patch shells are
    // meaningless, so the number follows the kept components, not the picture.
    if (diffFraction(aDiff) >= KEEP_CLEAR_SHARE && thickness >= KEEP_OPEN_SKIN_MM) {
      kept.push(...corners)
      volume += component.volume
      continue
    }
    if (diffFraction(aDiff) >= KEEP_CLEAR_SHARE) {
      for (let t = 0; t < component.triangles.length; t++) {
        if (aDiff[t] === 1) {
          const original = component.triangles[t] ?? 0
          kept.push(
            triangles[original * 3] ?? 0,
            triangles[original * 3 + 1] ?? 0,
            triangles[original * 3 + 2] ?? 0,
          )
        }
      }
      volume += component.volume
    }
  }
  const filtered = geometryFromTriangles(vertices, kept)
  if (!filtered) return { geometry: null, volume: 0 }
  return { geometry: filtered, volume }
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
  if (raw.over) {
    const filtered = filterDrawableFaces(raw.over, queryPrimary)
    overFiltered = filtered.geometry
    overVolume = filtered.volume
    raw.over.dispose()
  }
  if (raw.under) {
    const filtered = filterDrawableFaces(raw.under, queryCompare)
    underFiltered = filtered.geometry
    underVolume = filtered.volume
    raw.under.dispose()
  }
  return {
    over: overFiltered,
    under: underFiltered,
    overVolume,
    underVolume,
    primaryVolume: raw.primaryVolume,
  }
}

interface CachedDiff {
  matrixKey: string
  overPos: Float32Array | null
  underPos: Float32Array | null
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
    overVolume: result.overVolume,
    underVolume: result.underVolume,
    primaryVolume: result.primaryVolume,
  })
  return result
}
