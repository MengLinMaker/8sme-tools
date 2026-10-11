import type { ManifoldToplevel } from 'manifold-3d'
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, type Matrix4 } from 'three'
import { type DiffSoup, toWorldSoup } from './booleanDiff'

/**
 * Boolean difference of the two overlay models using Manifold instead of three-bvh-csg.
 *
 * - `over` (red): overcut — STEP − manufactured.
 * - `under` (blue): undercut — manufactured − STEP.
 *
 * Manifold is manifold-guaranteed with robust predicates, so the near-coincident tessellations
 * that make three-bvh-csg spit out slivers and dropped coplanar faces come back as a clean solid.
 */

export interface ManifoldDiff {
  over: BufferGeometry | null
  under: BufferGeometry | null
  overVolume: number
  underVolume: number
  primaryVolume: number
}

type ManifoldMesh = { vertProperties: Float32Array; triVerts: Uint32Array; numProp: number }

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
): ManifoldDiff | null {
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
    return {
      over: over.isEmpty() ? null : meshToGeometry(over.getMesh()),
      under: under.isEmpty() ? null : meshToGeometry(under.getMesh()),
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
