import { type BufferGeometry, EdgesGeometry } from 'three'

/**
 * Dihedral-angle bar (degrees) for manufactured-model edge lines. OCC's tessellated edges draw
 * every B-rep boundary: boolean shards split flat faces into coplanar pieces (a straight line
 * across a flat that reads exactly like a laser cut) and dense NC outline chains facet every
 * curve. Re-deriving the lines from the triangles keeps only hinges at or above this angle —
 * real cuts (square ends, mitres, hole rims) — and drops the confusing ones. Measured on job
 * parts: true edges sit at 45°+ while fillet/wall facets and shards sit below 25°, so 35° clears
 * both with margin on either side.
 */
export const SMOOTH_LINE_THRESHOLD_DEG = 35

/**
 * Replaces a model's OCC edge lines with angle-filtered ones, in place. Same shape as the
 * `replicad-threejs-helper` line sync it stands in for, so existing disposal still applies.
 */
export function smoothLines(lines: BufferGeometry, faces: BufferGeometry): void {
  const smooth = new EdgesGeometry(faces, SMOOTH_LINE_THRESHOLD_DEG)
  lines.copy(smooth)
  smooth.dispose()
}
