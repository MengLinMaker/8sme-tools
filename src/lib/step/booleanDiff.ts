import { BufferGeometry, Float32BufferAttribute, type Matrix4, Vector3 } from 'three'
import { Brush, computeMeshVolume, Evaluator, SUBTRACTION } from 'three-bvh-csg'

/**
 * True boolean difference of the two overlay models, with the STEP treated as ideal.
 *
 * - `extra` (red): material the manufactured (NC) model carries *beyond* the STEP.
 * - `missing` (blue): STEP material the manufactured model *lacks*.
 *
 * Surface-distance flagging paints both sides of any offset face, which reads as a
 * solid shell differing "both ways". Booleans cancel the coincident surfaces and
 * leave only the volumetric leftovers — the actual A−B / B−A pieces.
 */

export interface DiffSoup {
  vertices: number[]
  triangles: number[]
}

/** Largest input the CSG path attempts; beyond this the viewer falls back to surface flagging. */
export const BOOLEAN_TRIANGLE_BUDGET = 200_000

export interface BooleanDiff {
  /** manufactured-minus-STEP solid, world coordinates (null when empty) */
  extra: BufferGeometry | null
  /** STEP-minus-manufactured solid, world coordinates (null when empty) */
  missing: BufferGeometry | null
  extraVolume: number
  missingVolume: number
  /** volume of the manufactured model, so the legend can show shares */
  primaryVolume: number
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

/**
 * Runs both boolean directions between the manufactured (`primaryParts`) and STEP
 * (`compareParts`) tessellations. Returns null when the inputs are over budget or
 * the CSG kernel fails — the caller falls back to surface-distance flagging.
 */
export function booleanDiff(
  primaryParts: DiffSoup[],
  compareParts: DiffSoup[],
  primaryMatrix: Matrix4,
  compareMatrix: Matrix4,
): BooleanDiff | null {
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

    const extra = evaluator.evaluate(brushA, brushB, SUBTRACTION).geometry
    const missing = evaluator.evaluate(brushB, brushA, SUBTRACTION).geometry
    brushA.disposeCacheData()
    brushB.disposeCacheData()
    for (const geometry of [extra, missing]) {
      geometry.computeVertexNormals()
      geometry.computeBoundingBox()
    }

    const hasExtra = triangleCount(extra) > 0
    const hasMissing = triangleCount(missing) > 0
    const result: BooleanDiff = {
      extra: hasExtra ? extra : null,
      missing: hasMissing ? missing : null,
      extraVolume: hasExtra ? Math.abs(computeMeshVolume(extra)) : 0,
      missingVolume: hasMissing ? Math.abs(computeMeshVolume(missing)) : 0,
      primaryVolume,
    }
    if (!hasExtra) extra.dispose()
    if (!hasMissing) missing.dispose()
    return result
  } catch {
    return null
  } finally {
    primaryGeo?.dispose()
    compareGeo?.dispose()
  }
}
