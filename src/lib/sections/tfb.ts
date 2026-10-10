import type { RolledSection } from './types'

/**
 * Australian Taper Flange Beams (TFB), AS/NZS 3679.1 (Grade 300).
 *
 * A legacy light I-section with tapered flanges; only two sizes are still rolled. For
 * visualisation it is drawn as a parallel-flange I-section from `d`, `b`, `tf` and `tw`.
 *
 * Dimensions and nominal mass verified against the ASI / InfraBuild "Hot Rolled and
 * Structural Steel Products" catalogue and AS/NZS 3679.1 Appendix D.
 */
export const TFB_SECTIONS: RolledSection[] = [
  { designation: '100 TFB', mass: 7.2, d: 100, b: 45, tf: 6.0, tw: 4.0 },
  { designation: '125 TFB', mass: 13.1, d: 125, b: 65, tf: 8.5, tw: 5.0 },
]

export function getTfb(designation: string): RolledSection | undefined {
  return TFB_SECTIONS.find((section) => section.designation === designation)
}

/** Nearest TFB within `tolerance` mm of the given overall depth. */
export function getTfbByDepth(depth: number, tolerance = 2): RolledSection | undefined {
  let best: RolledSection | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  for (const section of TFB_SECTIONS) {
    const delta = Math.abs(section.d - depth)
    if (delta <= tolerance && delta < bestDelta) {
      bestDelta = delta
      best = section
    }
  }
  return best
}
