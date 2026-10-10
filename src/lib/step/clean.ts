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
const MIN_DIM = 1

interface BoundaryShape {
  boundingBox: { bounds: [number[], number[]] }
}

export async function cleanStep(bytes: Uint8Array): Promise<CleanResult | null> {
  await ensureOc()
  const { importSTEP, measureVolume, compoundShapes } = await import('replicad')
  const shape = (await importSTEP(
    new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
  )) as unknown as {
    solids: BoundaryShape[]
    delete: () => void
  }
  try {
    const solids = shape.solids ?? []
    if (solids.length <= 1) return null

    const isReal = (solid: BoundaryShape) => {
      const [min, max] = solid.boundingBox.bounds
      const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
      return Math.min(...dims) >= MIN_DIM
    }
    let keep = solids.filter(isReal)
    if (keep.length === 0) {
      // All bodies are degenerate — keep the largest rather than emit an empty file.
      keep = [
        solids.reduce((a, b) => (measureVolume(b as never) > measureVolume(a as never) ? b : a)),
      ]
    }
    const removed = solids.length - keep.length
    if (removed <= 0) return null

    const compound = (keep.length === 1 ? keep[0] : compoundShapes(keep as never)) as unknown as {
      blobSTEP: () => Blob
    }
    const blob = compound.blobSTEP()
    return { bytes: new Uint8Array(await blob.arrayBuffer()), kept: keep.length, removed }
  } finally {
    shape.delete()
  }
}
