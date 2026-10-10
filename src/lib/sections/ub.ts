import type { RolledSection } from './types'

/**
 * Australian Universal Beams (UB), AS/NZS 3679.1 (Grade 300).
 *
 * `BT` sections are "Tees cut from Universal Beams" — a UB split lengthwise gives a
 * tee whose cross-section mirrors the parent UB (flange b, tf, tw) with half the depth.
 *
 * Dimensions verified against supplier tables (Mascot, Steel Solutions, NPS, Midalia).
 * Root radii `r` are the AS/NZS 3679.1 root fillets (OneSteel/InfraBuild "Hot Rolled and
 * Structural Steel Products" 7th Ed.); `200UB29.8 r = 8.9` matches the real Tekla NC headers.
 */
export const UB_SECTIONS: RolledSection[] = [
  { designation: '150UB14.0', mass: 14.0, d: 150, b: 75, tf: 7.0, tw: 5.0, r: 8.0 },
  { designation: '150UB18.0', mass: 18.0, d: 155, b: 75, tf: 9.5, tw: 6.0, r: 8.0 },
  { designation: '180UB16.1', mass: 16.1, d: 173, b: 90, tf: 7.0, tw: 4.5, r: 8.9 },
  { designation: '180UB18.1', mass: 18.1, d: 175, b: 90, tf: 8.0, tw: 5.0, r: 8.9 },
  { designation: '180UB22.2', mass: 22.2, d: 179, b: 90, tf: 10.0, tw: 6.0, r: 8.9 },
  { designation: '200UB18.2', mass: 18.2, d: 198, b: 99, tf: 7.0, tw: 4.5, r: 11.0 },
  { designation: '200UB22.3', mass: 22.3, d: 202, b: 133, tf: 7.0, tw: 5.0, r: 8.9 },
  { designation: '200UB25.4', mass: 25.4, d: 203, b: 133, tf: 7.8, tw: 5.8, r: 8.9 },
  { designation: '200UB29.8', mass: 29.8, d: 207, b: 134, tf: 9.6, tw: 6.3, r: 8.9 },
  { designation: '250UB25.7', mass: 25.7, d: 248, b: 124, tf: 8.0, tw: 5.0, r: 12.0 },
  { designation: '250UB31.4', mass: 31.4, d: 252, b: 146, tf: 8.6, tw: 6.1, r: 8.9 },
  { designation: '250UB37.3', mass: 37.3, d: 256, b: 146, tf: 10.9, tw: 6.4, r: 8.9 },
  { designation: '310UB32.0', mass: 32.0, d: 298, b: 149, tf: 8.0, tw: 5.5, r: 13.0 },
  { designation: '310UB40.4', mass: 40.4, d: 304, b: 165, tf: 10.2, tw: 6.1, r: 11.4 },
  { designation: '310UB46.2', mass: 46.2, d: 307, b: 166, tf: 11.8, tw: 6.7, r: 11.4 },
  { designation: '360UB44.7', mass: 44.7, d: 352, b: 171, tf: 9.7, tw: 6.9, r: 11.4 },
  { designation: '360UB50.7', mass: 50.7, d: 356, b: 171, tf: 11.5, tw: 7.3, r: 11.4 },
  { designation: '360UB56.7', mass: 56.7, d: 359, b: 172, tf: 13.0, tw: 8.0, r: 11.4 },
  { designation: '410UB53.7', mass: 53.7, d: 403, b: 178, tf: 10.9, tw: 7.6, r: 11.4 },
  { designation: '410UB59.7', mass: 59.7, d: 406, b: 178, tf: 12.8, tw: 7.8, r: 11.4 },
  { designation: '460UB67.1', mass: 67.1, d: 454, b: 190, tf: 12.7, tw: 8.5, r: 11.4 },
  { designation: '460UB74.6', mass: 74.6, d: 457, b: 190, tf: 14.5, tw: 9.1, r: 11.4 },
  { designation: '460UB82.1', mass: 82.1, d: 460, b: 191, tf: 16.0, tw: 9.9, r: 11.4 },
  { designation: '530UB82.0', mass: 82.0, d: 528, b: 209, tf: 13.2, tw: 9.6, r: 14.0 },
  { designation: '530UB92.4', mass: 92.4, d: 533, b: 209, tf: 15.6, tw: 10.2, r: 14.0 },
  { designation: '610UB101', mass: 101.0, d: 602, b: 228, tf: 14.8, tw: 10.6, r: 14.0 },
  { designation: '610UB113', mass: 113.0, d: 607, b: 228, tf: 17.3, tw: 11.2, r: 14.0 },
  { designation: '610UB125', mass: 125.0, d: 612, b: 229, tf: 19.6, tw: 11.9, r: 14.0 },
]

export function getUb(designation: string): RolledSection | undefined {
  return UB_SECTIONS.find((section) => section.designation === designation)
}
