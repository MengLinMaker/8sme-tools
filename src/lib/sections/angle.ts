import type { RolledAngle } from './types'

/**
 * Australian hot-rolled Equal Angles (EA) and Unequal Angles (UA), AS/NZS 3679.1 (Grade 300).
 *
 * An angle has **two** corner radii, not one:
 *   - the **root radius** `r1` — the (concave) fillet where the two legs meet; and
 *   - the **toe radius** `r2` — the (convex) round near the free end of each leg, on the
 *     **inner** corner of the toe (the corner on the same side as the root; the outer toe
 *     corners stay sharp in the mill figure).
 *
 * The radii (and the nominal masses) are **not** tabulated in AS/NZS 3679.1 itself; they come
 * from the mill catalogue, OneSteel/InfraBuild "Hot Rolled and Structural Steel Products"
 * (7th Ed.) — the same source as the UB/UC/PFC root radii. There the toe radius is a flat
 * 5 mm for the larger sections and 3 mm for the smaller ones (ISO 657-1's "half the root
 * radius" is the international fallback, but is not what the AUS mill actually rolls).
 *
 * The designation's thickness is **nominal** and does not equal the rolled thickness `t`
 * (`10` → 9.5, `16` → 15.8, `8` → 7.8, `5` → 4.6); both are stored so a callout can be matched
 * on either, while geometry uses the real rolled `t`.
 */
export const EQUAL_ANGLES: RolledAngle[] = [
  { kind: 'EA', a: 25, b: 25, tNom: 3, t: 3, r1: 5, r2: 3, mass: 1.12 },
  { kind: 'EA', a: 25, b: 25, tNom: 5, t: 4.6, r1: 5, r2: 3, mass: 1.65 },
  { kind: 'EA', a: 25, b: 25, tNom: 6, t: 6, r1: 5, r2: 3, mass: 2.08 },
  { kind: 'EA', a: 30, b: 30, tNom: 3, t: 3, r1: 5, r2: 3, mass: 1.35 },
  { kind: 'EA', a: 30, b: 30, tNom: 5, t: 4.6, r1: 5, r2: 3, mass: 2.01 },
  { kind: 'EA', a: 30, b: 30, tNom: 6, t: 6, r1: 5, r2: 3, mass: 2.56 },
  { kind: 'EA', a: 40, b: 40, tNom: 3, t: 3, r1: 5, r2: 3, mass: 1.83 },
  { kind: 'EA', a: 40, b: 40, tNom: 5, t: 4.6, r1: 5, r2: 3, mass: 2.73 },
  { kind: 'EA', a: 40, b: 40, tNom: 6, t: 6, r1: 5, r2: 3, mass: 3.5 },
  { kind: 'EA', a: 45, b: 45, tNom: 3, t: 3, r1: 5, r2: 3, mass: 2.06 },
  { kind: 'EA', a: 45, b: 45, tNom: 5, t: 4.6, r1: 5, r2: 3, mass: 3.1 },
  { kind: 'EA', a: 45, b: 45, tNom: 6, t: 6, r1: 5, r2: 3, mass: 3.97 },
  { kind: 'EA', a: 50, b: 50, tNom: 3, t: 3, r1: 6, r2: 3, mass: 2.31 },
  { kind: 'EA', a: 50, b: 50, tNom: 5, t: 4.6, r1: 6, r2: 3, mass: 3.48 },
  { kind: 'EA', a: 50, b: 50, tNom: 6, t: 6, r1: 6, r2: 3, mass: 4.46 },
  { kind: 'EA', a: 50, b: 50, tNom: 8, t: 7.8, r1: 6, r2: 3, mass: 5.68 },
  { kind: 'EA', a: 55, b: 55, tNom: 5, t: 4.6, r1: 6, r2: 3, mass: 3.84 },
  { kind: 'EA', a: 55, b: 55, tNom: 6, t: 6, r1: 6, r2: 3, mass: 4.93 },
  { kind: 'EA', a: 65, b: 65, tNom: 5, t: 4.6, r1: 6, r2: 3, mass: 4.56 },
  { kind: 'EA', a: 65, b: 65, tNom: 6, t: 6, r1: 6, r2: 3, mass: 5.87 },
  { kind: 'EA', a: 65, b: 65, tNom: 8, t: 7.8, r1: 6, r2: 3, mass: 7.51 },
  { kind: 'EA', a: 65, b: 65, tNom: 10, t: 9.5, r1: 6, r2: 3, mass: 9.02 },
  { kind: 'EA', a: 75, b: 75, tNom: 5, t: 4.6, r1: 8, r2: 5, mass: 5.27 },
  { kind: 'EA', a: 75, b: 75, tNom: 6, t: 6, r1: 8, r2: 5, mass: 6.81 },
  { kind: 'EA', a: 75, b: 75, tNom: 8, t: 7.8, r1: 8, r2: 5, mass: 8.73 },
  { kind: 'EA', a: 75, b: 75, tNom: 10, t: 9.5, r1: 8, r2: 5, mass: 10.5 },
  { kind: 'EA', a: 90, b: 90, tNom: 6, t: 6, r1: 8, r2: 5, mass: 8.22 },
  { kind: 'EA', a: 90, b: 90, tNom: 8, t: 7.8, r1: 8, r2: 5, mass: 10.6 },
  { kind: 'EA', a: 90, b: 90, tNom: 10, t: 9.5, r1: 8, r2: 5, mass: 12.7 },
  { kind: 'EA', a: 100, b: 100, tNom: 6, t: 6, r1: 8, r2: 5, mass: 9.16 },
  { kind: 'EA', a: 100, b: 100, tNom: 8, t: 7.8, r1: 8, r2: 5, mass: 11.8 },
  { kind: 'EA', a: 100, b: 100, tNom: 10, t: 9.5, r1: 8, r2: 5, mass: 14.2 },
  { kind: 'EA', a: 100, b: 100, tNom: 12, t: 12, r1: 8, r2: 5, mass: 17.7 },
  { kind: 'EA', a: 125, b: 125, tNom: 8, t: 7.8, r1: 10, r2: 5, mass: 14.9 },
  { kind: 'EA', a: 125, b: 125, tNom: 10, t: 9.5, r1: 10, r2: 5, mass: 18.0 },
  { kind: 'EA', a: 125, b: 125, tNom: 12, t: 12, r1: 10, r2: 5, mass: 22.5 },
  { kind: 'EA', a: 125, b: 125, tNom: 16, t: 15.8, r1: 10, r2: 5, mass: 29.1 },
  { kind: 'EA', a: 150, b: 150, tNom: 10, t: 9.5, r1: 13, r2: 5, mass: 21.9 },
  { kind: 'EA', a: 150, b: 150, tNom: 12, t: 12, r1: 13, r2: 5, mass: 27.3 },
  { kind: 'EA', a: 150, b: 150, tNom: 16, t: 15.8, r1: 13, r2: 5, mass: 35.4 },
  { kind: 'EA', a: 150, b: 150, tNom: 19, t: 19, r1: 13, r2: 5, mass: 42.1 },
  { kind: 'EA', a: 200, b: 200, tNom: 13, t: 13, r1: 18, r2: 5, mass: 40.0 },
  { kind: 'EA', a: 200, b: 200, tNom: 16, t: 15.8, r1: 18, r2: 5, mass: 48.7 },
  { kind: 'EA', a: 200, b: 200, tNom: 18, t: 18, r1: 18, r2: 5, mass: 54.4 },
  { kind: 'EA', a: 200, b: 200, tNom: 20, t: 20, r1: 18, r2: 5, mass: 60.1 },
  { kind: 'EA', a: 200, b: 200, tNom: 26, t: 26, r1: 18, r2: 5, mass: 76.8 },
]

export const UNEQUAL_ANGLES: RolledAngle[] = [
  { kind: 'UA', a: 150, b: 100, tNom: 12, t: 12, r1: 10, r2: 5, mass: 22.5 },
  { kind: 'UA', a: 150, b: 100, tNom: 10, t: 9.5, r1: 10, r2: 5, mass: 18.0 },
  { kind: 'UA', a: 150, b: 90, tNom: 16, t: 15.8, r1: 10, r2: 5, mass: 27.9 },
  { kind: 'UA', a: 150, b: 90, tNom: 12, t: 12, r1: 10, r2: 5, mass: 21.6 },
  { kind: 'UA', a: 150, b: 90, tNom: 10, t: 9.5, r1: 10, r2: 5, mass: 17.3 },
  { kind: 'UA', a: 150, b: 90, tNom: 8, t: 7.8, r1: 10, r2: 5, mass: 14.3 },
  { kind: 'UA', a: 125, b: 75, tNom: 12, t: 12, r1: 8, r2: 5, mass: 17.7 },
  { kind: 'UA', a: 125, b: 75, tNom: 10, t: 9.5, r1: 8, r2: 5, mass: 14.2 },
  { kind: 'UA', a: 125, b: 75, tNom: 8, t: 7.8, r1: 8, r2: 5, mass: 11.8 },
  { kind: 'UA', a: 125, b: 75, tNom: 6, t: 6, r1: 8, r2: 5, mass: 9.16 },
  { kind: 'UA', a: 100, b: 75, tNom: 10, t: 9.5, r1: 8, r2: 5, mass: 12.4 },
  { kind: 'UA', a: 100, b: 75, tNom: 8, t: 7.8, r1: 8, r2: 5, mass: 10.3 },
  { kind: 'UA', a: 100, b: 75, tNom: 6, t: 6, r1: 8, r2: 5, mass: 7.98 },
  { kind: 'UA', a: 75, b: 50, tNom: 8, t: 7.8, r1: 7, r2: 3, mass: 7.23 },
  { kind: 'UA', a: 75, b: 50, tNom: 6, t: 6, r1: 7, r2: 3, mass: 5.66 },
  { kind: 'UA', a: 75, b: 50, tNom: 5, t: 4.6, r1: 7, r2: 3, mass: 4.4 },
  { kind: 'UA', a: 65, b: 50, tNom: 8, t: 7.8, r1: 6, r2: 3, mass: 6.59 },
  { kind: 'UA', a: 65, b: 50, tNom: 6, t: 6, r1: 6, r2: 3, mass: 5.16 },
  { kind: 'UA', a: 65, b: 50, tNom: 5, t: 4.6, r1: 6, r2: 3, mass: 4.02 },
]

/** The standard, parseable designation for an angle, e.g. `EA75*75*6` / `UA100*75*6`. */
export function angleDesignation(angle: RolledAngle): string {
  return `${angle.kind}${angle.a}*${angle.b}*${angle.tNom}`
}

/**
 * Looks up an angle by its nominal leg sizes and thickness. `thickness` may be either the
 * nominal designated value (e.g. 10) or the rolled value (e.g. 9.5) — both are matched within
 * `tolerance`. Returns the closest match, or the catalogue entry's `undefined` twin if none.
 */
export function getAngle(
  kind: 'EA' | 'UA',
  a: number,
  b: number,
  thickness: number,
  tolerance = 0.6,
): RolledAngle | undefined {
  const table = kind === 'EA' ? EQUAL_ANGLES : UNEQUAL_ANGLES
  let best: RolledAngle | undefined
  let bestDelta = Number.POSITIVE_INFINITY
  for (const angle of table) {
    if (Math.abs(angle.a - a) > tolerance || Math.abs(angle.b - b) > tolerance) continue
    const delta = Math.min(Math.abs(angle.t - thickness), Math.abs(angle.tNom - thickness))
    if (delta > tolerance) continue
    if (delta < bestDelta) {
      bestDelta = delta
      best = angle
    }
  }
  return best
}
