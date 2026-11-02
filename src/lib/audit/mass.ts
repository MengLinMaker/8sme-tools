/**
 * Per-piece mass bands used to flag pieces that need a lift aid.
 *
 * A mark's handling risk is per **piece**, not per batch — repeating a 5 kg part twenty times
 * does not make each one heavy — so the band is computed from the single-piece mass.
 */

/** Above this many kg, plan a two-person lift or a mechanical aid. */
export const MASS_RED_KG = 30
/** At/above this many kg, consider a lift aid. */
export const MASS_YELLOW_KG = 20

export type MassBand = 'red' | 'yellow' | 'green'

/** Band for a per-piece mass (kg); null when the mass is unknown. */
export function massBand(kg: number | null | undefined): MassBand | null {
  if (kg == null || !Number.isFinite(kg)) return null
  if (kg > MASS_RED_KG) return 'red'
  if (kg >= MASS_YELLOW_KG) return 'yellow'
  return 'green'
}

/** Tailwind classes for each band, matching the parts table. */
export const MASS_BAND_CLASS: Record<MassBand, string> = {
  red: 'font-semibold text-red-400',
  yellow: 'font-semibold text-amber-400',
  green: 'text-emerald-400',
}
