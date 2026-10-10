import type { RolledSection } from './types'

/**
 * Australian Parallel Flange Channels (PFC), AS/NZS 3679.1 (Grade 300).
 *
 * `b` is the overall flange width; `r` is the root radius (from the AS/NZS 3679.1 / OneSteel
 * "Hot Rolled and Structural Steel Products" table, 8–14 mm by section). The short callout
 * (`150PFC`, `PFC100*50`) carries only depth and flange, so the web and flange thicknesses and
 * the root radius come from here — not from a guess.
 *
 * Dimensions and nominal mass verified against the ASI / InfraBuild "Hot Rolled and
 * Structural Steel Products" catalogue and AS/NZS 3679.1 Appendix D.
 */
export const PFC_SECTIONS: RolledSection[] = [
  { designation: '75 PFC', mass: 5.9, d: 75, b: 40, tf: 6.1, tw: 3.8, r: 8.0 },
  { designation: '100 PFC', mass: 8.3, d: 100, b: 50, tf: 6.7, tw: 4.2, r: 8.0 },
  { designation: '125 PFC', mass: 11.9, d: 125, b: 65, tf: 7.5, tw: 4.7, r: 8.0 },
  { designation: '150 PFC', mass: 17.7, d: 150, b: 75, tf: 9.5, tw: 6.0, r: 10.0 },
  { designation: '180 PFC', mass: 20.9, d: 180, b: 75, tf: 11.0, tw: 6.0, r: 12.0 },
  { designation: '200 PFC', mass: 22.9, d: 200, b: 75, tf: 12.0, tw: 6.0, r: 12.0 },
  { designation: '230 PFC', mass: 25.1, d: 230, b: 75, tf: 12.0, tw: 6.5, r: 12.0 },
  { designation: '250 PFC', mass: 35.5, d: 250, b: 90, tf: 15.0, tw: 8.0, r: 12.0 },
  { designation: '300 PFC', mass: 40.1, d: 300, b: 90, tf: 16.0, tw: 8.0, r: 14.0 },
  { designation: '380 PFC', mass: 55.2, d: 380, b: 100, tf: 17.5, tw: 10.0, r: 14.0 },
]

export function getPfc(designation: string): RolledSection | undefined {
  return PFC_SECTIONS.find((section) => section.designation === designation)
}

/** Nearest PFC within `tolerance` mm of the given overall depth (one PFC per nominal depth). */
export function getPfcByDepth(depth: number, tolerance = 2): RolledSection | undefined {
  let best: RolledSection | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  for (const section of PFC_SECTIONS) {
    const delta = Math.abs(section.d - depth)
    if (delta <= tolerance && delta < bestDelta) {
      bestDelta = delta
      best = section
    }
  }
  return best
}
