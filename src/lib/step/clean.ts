import { ensureOc } from './occInit'

/**
 * Removes stray/degenerate solid bodies (floating slivers) from a STEP model, keeping the real
 * one(s). Everything else — holes, curves, mitres — is untouched, because the kept solids are
 * re-exported as-is. Returns `null` when there is nothing to clean.
 */

export interface CleanResult {
  bytes: Uint8Array
  kept: number
  removed: number
}

/** Bodies with any bounding-box dimension below this (mm) are treated as floating slivers. */
export const STRAY_MIN_DIM = 1

interface BoundaryShape {
  boundingBox: { bounds: [number[], number[]] }
}

/** A live OCC shape with enumerated solids — what booleans and STEP imports both return. */
export interface LiveSolid {
  solids: BoundaryShape[]
}

function isRealSolid(solid: BoundaryShape): boolean {
  const [min, max] = solid.boundingBox.bounds
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  return Math.min(...dims) >= STRAY_MIN_DIM
}

/**
 * Strips stray/degenerate solids from an already-built OCC shape (e.g. the NC-fabricated
 * solid, whose booleans can leave floating slivers). Same rule as {@link cleanStep}, but
 * with no STEP export/parse round trip: the common single-body case returns the input
 * untouched, and only a genuine multi-body cleanup rebuilds a compound. Returns the shape
 * to use plus counts, so callers can keep measuring/exporting the returned solid.
 */
export async function stripStraySolids<T extends LiveSolid>(
  solid: T,
): Promise<{ solid: T; kept: number; removed: number }> {
  const solids = solid.solids ?? []
  if (solids.length <= 1) return { solid, kept: solids.length, removed: 0 }

  let keep = solids.filter(isRealSolid)
  if (keep.length === 0) {
    // All bodies are degenerate — keep the largest rather than emit an empty shape.
    const { measureVolume } = await import('replicad')
    keep = [
      solids.reduce((a, b) => (measureVolume(b as never) > measureVolume(a as never) ? b : a)),
    ]
  }
  const removed = solids.length - keep.length
  if (removed <= 0) return { solid, kept: keep.length, removed: 0 }

  if (keep.length === 1) return { solid: keep[0] as unknown as T, kept: 1, removed }
  const { compoundShapes } = await import('replicad')
  return { solid: compoundShapes(keep as never) as unknown as T, kept: keep.length, removed }
}

export async function cleanStep(bytes: Uint8Array): Promise<CleanResult | null> {
  await ensureOc()
  const { importSTEP } = await import('replicad')
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as LiveSolid & {
    delete: () => void
    blobSTEP: () => Blob
  }
  try {
    const { solid, kept, removed } = await stripStraySolids(shape)
    if (removed <= 0) return null

    const blob = (solid as unknown as { blobSTEP: () => Blob }).blobSTEP()
    return { bytes: new Uint8Array(await blob.arrayBuffer()), kept, removed }
  } finally {
    shape.delete()
  }
}
