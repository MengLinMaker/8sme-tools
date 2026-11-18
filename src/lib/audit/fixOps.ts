import type { Finding } from '@/lib/audit/schemas'
import type { NcOp } from '@/lib/projects/edits'

/**
 * The NC edit a finding's one-click fix records, and the key it is stored under.
 *
 * A finding carries the target in its `params` (contour index, vertex indices, the value to apply);
 * these two functions are the only place that turns that into an {@link NcOp}, so the batch fix and
 * the per-row fix menus can't drift apart. Everything here is pure: the caller applies the op with
 * `applyNcOp` and records the result.
 */

/** The key the NC edit for a finding is stored under, or null when the finding has no NC edit. */
export function findingOpKey(finding: Finding): string | null {
  const params = finding.params
  if (finding.code === 'CUT_ROOT_FILLET') {
    const contourIndex = params?.contourIndex
    const vertices = params?.vertices
    return typeof contourIndex === 'number' && typeof vertices === 'string'
      ? `fillet:${contourIndex}:${vertices}`
      : null
  }
  if (finding.code === 'CUT_BEVEL_CHANGE') {
    const contourIndex = params?.contourIndex
    const vertices = params?.vertices
    return typeof contourIndex === 'number' && typeof vertices === 'string'
      ? `bevel:${contourIndex}:${vertices}`
      : null
  }
  if (finding.code === 'BEVEL_OUT_OF_RANGE') {
    const contourIndex = params?.contourIndex
    const vertex = params?.vertex
    return typeof contourIndex === 'number' && typeof vertex === 'number'
      ? `oor:${contourIndex}:${vertex}`
      : null
  }
  if (finding.code === 'CUT_UNCLOSED' || finding.code === 'CUT_CUTOUT') {
    const contourIndex = params?.contourIndex
    const removal = params?.removal
    return typeof contourIndex === 'number' && typeof removal === 'string' && removal
      ? `cut:${contourIndex}:${removal}`
      : null
  }
  return null
}

/**
 * The NC edit a finding's one-click fix records, with the recommended value already filled in
 * (the same value the mini menus prefill). Returns null when the finding carries no NC edit.
 */
export function ncOpForFinding(finding: Finding): NcOp | null {
  const key = findingOpKey(finding)
  if (!key) return null
  const params = finding.params ?? {}
  const contourIndex = params.contourIndex
  if (typeof contourIndex !== 'number') return null
  if (finding.code === 'CUT_UNCLOSED' || finding.code === 'CUT_CUTOUT') {
    const removalText = params.removal
    if (typeof removalText !== 'string' || !removalText) return null
    const removal = removalText.split(',').map(Number)
    if (removal.length < 2) return null
    return {
      key,
      kind: 'removeCut',
      contourIndex,
      removeVertices: [removal[0] as number, removal[1] as number],
    }
  }
  if (finding.code === 'CUT_ROOT_FILLET') {
    const verticesText = params.vertices
    const deltaY = params.delta
    if (typeof verticesText !== 'string') return null
    if (typeof deltaY !== 'number' || !Number.isFinite(deltaY) || deltaY === 0) return null
    const vertices = verticesText
      .split(',')
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= 0)
    if (vertices.length === 0) return null
    return { key, kind: 'moveCut', contourIndex, vertices, deltaY }
  }
  const verticesText = params.vertices
  if (finding.code === 'BEVEL_OUT_OF_RANGE') {
    const vertex = params.vertex
    const suggested = params.suggested
    const angle = typeof suggested === 'string' ? Number(suggested) : Number.NaN
    if (typeof vertex !== 'number' || !Number.isFinite(angle)) return null
    return { key, kind: 'outOfRangeBevel', contourIndex, vertex, angle }
  }
  if (typeof verticesText !== 'string') return null
  const vertices = verticesText
    .split(',')
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0)
  if (vertices.length === 0) return null
  if (finding.code === 'CUT_BEVEL_CHANGE') {
    const suggested = params.suggested
    const angle = typeof suggested === 'string' ? Number(suggested) : Number.NaN
    if (!Number.isFinite(angle)) return null
    return { key, kind: 'unifyBevel', contourIndex, vertices, angle }
  }
  return null
}
