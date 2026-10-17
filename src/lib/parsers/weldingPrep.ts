import { MACHINE } from '@/lib/machine/profile'

/**
 * DSTV welding preparation (DSTV 87 §"Welding preparation").
 *
 * After a contour point's `X Y R`, the `AK` line carries up to **two** `(φ, Y)` couples — a welding
 * preparation on **each side** of the plate. `φ` is the torch angle to the vertical (surface normal)
 * and is **not bounded by the machine's bevel range**; Tekla freely writes steep values (e.g. `79.4`,
 * `-64.2`) that the head cannot cut. A couple with `φ = 0` is no prep on that side.
 */

/** Steepest bevel the head cuts (deg); a steeper `φ` is not a weld prep the head can make. */
export const MAX_BEVEL_DEG = Math.max(
  Math.abs(MACHINE.bevel.minDeg),
  Math.abs(MACHINE.bevel.maxDeg),
)

/** A chosen welding preparation: the bevel angle (deg, `0` = none) and its leg distance `Y` (mm). */
export interface WeldingPrep {
  angle: number
  distance: number
}

const NO_PREP: WeldingPrep = { angle: 0, distance: 0 }

/**
 * Picks the welding preparation to apply from a DSTV bevel field `[φ1, Y1, φ2, Y2]`.
 *
 * Both couples describe a real prep (the two sides of the plate), so the choice is **not** the
 * steepest `φ` — a steep back-side couple would win and draw a bevel the head can't cut. Instead
 * the steepest couple **within the head's range** is chosen; when neither side is cuttable (or both
 * are square) there is no bevel. Returns the selected couple's own `Y`, so the drawn distance
 * belongs to the angle it accompanies.
 */
export function selectWeldingPrep(bevel: number[] | undefined): WeldingPrep {
  if (!bevel) return NO_PREP
  let best = NO_PREP
  for (const couple of [
    { angle: bevel[0] ?? 0, distance: bevel[1] ?? 0 },
    { angle: bevel[2] ?? 0, distance: bevel[3] ?? 0 },
  ]) {
    if (!Number.isFinite(couple.angle) || couple.angle === 0) continue
    if (Math.abs(couple.angle) > MAX_BEVEL_DEG) continue
    if (Math.abs(couple.angle) > Math.abs(best.angle)) best = couple
  }
  return best
}
