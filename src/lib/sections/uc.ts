import type { RolledSection } from './types'

/**
 * Australian Universal Columns (UC), AS/NZS 3679.1 (Grade 300).
 *
 * The UC set has several mass variants per nominal depth (e.g. 310UC96.8 … 310UC158), so
 * identify the exact one by designation; within a nominal depth the overall depth `d` is
 * unique, which is what {@link getUcByDepth} keys on.
 *
 * Dimensions and nominal mass verified against the ASI / InfraBuild "Hot Rolled and
 * Structural Steel Products" catalogue and AS/NZS 3679.1 Appendix D.
 */
export const UC_SECTIONS: RolledSection[] = [
  { designation: '100UC14.8', mass: 14.8, d: 97, b: 99, tf: 7.0, tw: 5.0, r: 10.0 },
  { designation: '150UC23.4', mass: 23.4, d: 152, b: 152, tf: 6.8, tw: 6.1, r: 8.9 },
  { designation: '150UC30.0', mass: 30.3, d: 158, b: 153, tf: 9.4, tw: 6.6, r: 8.9 },
  { designation: '150UC37.2', mass: 37.2, d: 162, b: 154, tf: 11.5, tw: 8.1, r: 8.9 },
  { designation: '200UC46.2', mass: 46.3, d: 203, b: 203, tf: 11.0, tw: 7.3, r: 11.4 },
  { designation: '200UC52.2', mass: 52.3, d: 206, b: 204, tf: 12.5, tw: 8.0, r: 11.4 },
  { designation: '200UC59.5', mass: 59.8, d: 210, b: 205, tf: 14.2, tw: 9.3, r: 11.4 },
  { designation: '250UC72.9', mass: 73.2, d: 254, b: 254, tf: 14.2, tw: 8.6, r: 14.0 },
  { designation: '250UC89.5', mass: 89.4, d: 260, b: 256, tf: 17.3, tw: 10.5, r: 14.0 },
  { designation: '310UC96.8', mass: 97.1, d: 308, b: 305, tf: 15.4, tw: 9.9, r: 16.5 },
  { designation: '310UC118', mass: 117.9, d: 315, b: 307, tf: 18.7, tw: 11.9, r: 16.5 },
  { designation: '310UC137', mass: 137.2, d: 321, b: 309, tf: 21.7, tw: 13.8, r: 16.5 },
  { designation: '310UC158', mass: 158.0, d: 327, b: 311, tf: 25.0, tw: 15.7, r: 16.5 },
]

export function getUc(designation: string): RolledSection | undefined {
  return UC_SECTIONS.find((section) => section.designation === designation)
}

/** Nearest UC within `tolerance` mm of the given overall depth (unique within a nominal set). */
export function getUcByDepth(depth: number, tolerance = 2): RolledSection | undefined {
  let best: RolledSection | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  for (const section of UC_SECTIONS) {
    const delta = Math.abs(section.d - depth)
    if (delta <= tolerance && delta < bestDelta) {
      bestDelta = delta
      best = section
    }
  }
  return best
}
