import type { ManifoldToplevel } from 'manifold-3d'
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, type Matrix4 } from 'three'
import { type BooleanDiff, type DiffSoup, toWorldSoup } from './booleanDiff'
import { ensureManifold } from './manifoldInit'

/**
 * Boolean difference of the two overlay models using Manifold instead of three-bvh-csg.
 *
 * - `over` (red): overcut — STEP − manufactured.
 * - `under` (blue): undercut — manufactured − STEP.
 *
 * Manifold is manifold-guaranteed with robust predicates, so the near-coincident tessellations
 * that make three-bvh-csg spit out slivers and dropped coplanar faces come back as a clean solid.
 */

type ManifoldMesh = { vertProperties: Float32Array; triVerts: Uint32Array; numProp: number }

/** Alpha is driven per-triangle; a solid boolean has no per-face clearance, so it renders uniform. */
const UNIFORM_DISTANCE_MM = 2

function uniformDistances(geometry: BufferGeometry | null): number[] {
  if (!geometry) return []
  const index = geometry.getIndex()
  const tris = index
    ? Math.floor(index.count / 3)
    : Math.floor((geometry.getAttribute('position')?.count ?? 0) / 3)
  return new Array<number>(tris).fill(UNIFORM_DISTANCE_MM)
}

/**
 * Merges coincident vertices (within `eps` mm) and drops degenerate triangles. OCC tessellates a
 * solid with duplicated seam vertices, which Manifold rejects as non-manifold; welding first makes
 * it a valid closed mesh.
 */
function weld(soup: DiffSoup, eps = 1e-3): DiffSoup {
  const map = new Map<string, number>()
  const vertices: number[] = []
  const remap = new Array<number>(Math.floor(soup.vertices.length / 3))
  for (let v = 0; v < remap.length; v++) {
    const x = soup.vertices[v * 3] ?? 0
    const y = soup.vertices[v * 3 + 1] ?? 0
    const z = soup.vertices[v * 3 + 2] ?? 0
    const key = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`
    let index = map.get(key)
    if (index === undefined) {
      index = vertices.length / 3
      map.set(key, index)
      vertices.push(x, y, z)
    }
    remap[v] = index
  }
  const triangles: number[] = []
  for (let t = 0; t < Math.floor(soup.triangles.length / 3); t++) {
    const a = remap[soup.triangles[t * 3] ?? 0] ?? 0
    const b = remap[soup.triangles[t * 3 + 1] ?? 0] ?? 0
    const c = remap[soup.triangles[t * 3 + 2] ?? 0] ?? 0
    if (a !== b && b !== c && c !== a) triangles.push(a, b, c)
  }
  return { vertices, triangles }
}

function soupToManifold(top: ManifoldToplevel, soup: DiffSoup) {
  const { Manifold, Mesh } = top
  const welded = weld(soup)
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: new Float32Array(welded.vertices),
    triVerts: new Uint32Array(welded.triangles),
  })
  return new Manifold(mesh)
}

/** Non-indexed BufferGeometry from a Manifold result (first three props are xyz). */
function meshToGeometry(mesh: ManifoldMesh): BufferGeometry | null {
  const triVerts = mesh.triVerts
  if (triVerts.length === 0) return null
  const positions = new Float32Array(triVerts.length * 3)
  for (let i = 0; i < triVerts.length; i++) {
    const v = (triVerts[i] ?? 0) * mesh.numProp
    positions[i * 3] = mesh.vertProperties[v] ?? 0
    positions[i * 3 + 1] = mesh.vertProperties[v + 1] ?? 0
    positions[i * 3 + 2] = mesh.vertProperties[v + 2] ?? 0
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(new BufferAttribute(triVerts.slice(), 1))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}

export function manifoldBooleanDiff(
  top: ManifoldToplevel,
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
): BooleanDiff | null {
  const primary = toWorldSoup(primaryParts, primaryMatrix)
  const compare = toWorldSoup(compareParts, compareMatrix)
  if (primary.triangles.length === 0 || compare.triangles.length === 0) return null

  let a: ReturnType<typeof soupToManifold> | null = null
  let b: ReturnType<typeof soupToManifold> | null = null
  let over: ReturnType<typeof soupToManifold> | null = null
  let under: ReturnType<typeof soupToManifold> | null = null
  try {
    a = soupToManifold(top, primary)
    b = soupToManifold(top, compare)
    const primaryVolume = a.volume()
    over = b.subtract(a)
    under = a.subtract(b)
    const overGeo = over.isEmpty() ? null : meshToGeometry(over.getMesh())
    const underGeo = under.isEmpty() ? null : meshToGeometry(under.getMesh())
    return {
      over: overGeo,
      under: underGeo,
      overDistance: uniformDistances(overGeo),
      underDistance: uniformDistances(underGeo),
      overVolume: Math.abs(over.volume()),
      underVolume: Math.abs(under.volume()),
      primaryVolume: Math.abs(primaryVolume),
    }
  } catch {
    return null
  } finally {
    a?.delete()
    b?.delete()
    over?.delete()
    under?.delete()
  }
}

interface CachedManifold {
  matrixKey: string
  overPos: Float32Array | null
  underPos: Float32Array | null
  overDistance: number[]
  underDistance: number[]
  overVolume: number
  underVolume: number
  primaryVolume: number
}

const manifoldCache = new WeakMap<Uint8Array, WeakMap<Uint8Array, CachedManifold>>()

function geometryFromArray(positions: Float32Array): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions.slice(), 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  return geometry
}

/** Loads the Manifold kernel and runs {@link manifoldBooleanDiff} in one call. */
export async function manifoldDiff(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
): Promise<BooleanDiff | null> {
  const top = await ensureManifold()
  return manifoldBooleanDiff(top, primaryParts, compareParts, primaryMatrix, compareMatrix)
}

/**
 * Memoised {@link manifoldDiff} for the viewer: same inputs (same STEP byte objects, same seating)
 * rebuild the overlay meshes from cached positions instead of rerunning the boolean.
 */
export async function cachedManifoldDiff(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
  primaryBytes: Uint8Array,
  compareBytes: Uint8Array,
): Promise<BooleanDiff | null> {
  const matrixKey = `${primaryMatrix.elements.join(',')}|${compareMatrix.elements.join(',')}`
  const hit = manifoldCache.get(primaryBytes)?.get(compareBytes)
  if (hit && hit.matrixKey === matrixKey) {
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
  const result = await manifoldDiff(primaryParts, compareParts, primaryMatrix, compareMatrix)
  if (!result) return null
  const positions = (geometry: BufferGeometry | null) => {
    const array = geometry?.getAttribute('position')?.array as Float32Array | undefined
    return array ? (array.slice() as Float32Array) : null
  }
  let byPrimary = manifoldCache.get(primaryBytes)
  if (!byPrimary) {
    byPrimary = new WeakMap()
    manifoldCache.set(primaryBytes, byPrimary)
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
