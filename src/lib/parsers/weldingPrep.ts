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
export function selectWeldingPrep(
  bevel: number[] | undefined,
  /**
   * Drawing only: fall back to the steepest nonzero couple when neither is inside the head's
   * range. Tekla writes real preps just outside ±45° (e.g. 47.63°); the manufactured model follows
   * them, so the projection must show them too. The audit still uses the strict range.
   */
  allowOutOfRange = false,
): WeldingPrep {
  if (!bevel) return NO_PREP
  let best = NO_PREP
  let fallback = NO_PREP
  for (const couple of [
    { angle: bevel[0] ?? 0, distance: bevel[1] ?? 0 },
    { angle: bevel[2] ?? 0, distance: bevel[3] ?? 0 },
  ]) {
    if (!Number.isFinite(couple.angle) || couple.angle === 0) continue
    if (Math.abs(couple.angle) > MAX_BEVEL_DEG) {
      if (Math.abs(couple.angle) > Math.abs(fallback.angle)) fallback = couple
      continue
    }
    if (Math.abs(couple.angle) > Math.abs(best.angle)) best = couple
  }
  if (best.angle !== 0) return best
  return allowOutOfRange ? fallback : NO_PREP
}

/**
 * What to do with a welding-prep couple whose angle is outside the head's range.
 * - `remove`: drop the couple (square cut on that side).
 * - `clamp`: limit the angle to the head's range, keeping its leg distance.
 * - `asDrawn`: keep the NC value unchanged (the error is still reported).
 */
export type BevelPolicy = 'remove' | 'clamp' | 'asDrawn'

/** Default per family: RHS/SHS ends cannot take a steep mitre, so they are removed by default. */
export function defaultBevelPolicy(family: string | null | undefined): BevelPolicy {
  return family === 'tube' ? 'remove' : 'asDrawn'
}

/** The out-of-range couples of a DSTV `[φ1, Y1, φ2, Y2]` bevel field (side 1 / side 2). */
export function outOfRangeCouples(
  bevel: number[] | undefined,
): { side: 1 | 2; angle: number; distance: number }[] {
  if (!bevel) return []
  const out: { side: 1 | 2; angle: number; distance: number }[] = []
  const couples = [
    { side: 1 as const, angle: bevel[0] ?? 0, distance: bevel[1] ?? 0 },
    { side: 2 as const, angle: bevel[2] ?? 0, distance: bevel[3] ?? 0 },
  ]
  for (const couple of couples)
    if (Number.isFinite(couple.angle) && Math.abs(couple.angle) > MAX_BEVEL_DEG) out.push(couple)
  return out
}

/** Applies a {@link BevelPolicy} to one bevel field, leaving in-range couples untouched. */
export function applyBevelPolicy(bevel: number[] | undefined, policy: BevelPolicy): number[] {
  if (!bevel) return []
  if (policy === 'asDrawn') return bevel
  const next = [...bevel]
  for (const pair of [0, 2]) {
    const angle = next[pair] ?? 0
    if (!Number.isFinite(angle) || Math.abs(angle) <= MAX_BEVEL_DEG) continue
    if (policy === 'remove') {
      next[pair] = 0
      next[pair + 1] = 0
    } else {
      next[pair] = Math.sign(angle) * MAX_BEVEL_DEG
    }
  }
  return next
}

/**
 * The bevel as the NC writes it, for drawing a kept prep: the steepest nonzero couple, whether or not
 * the head can cut it. Used only when the policy keeps out-of-range preps (`asDrawn`).
 */
export function selectDrawnPrep(bevel: number[] | undefined): WeldingPrep {
  if (!bevel) return NO_PREP
  let best = NO_PREP
  for (const couple of [
    { angle: bevel[0] ?? 0, distance: bevel[1] ?? 0 },
    { angle: bevel[2] ?? 0, distance: bevel[3] ?? 0 },
  ]) {
    if (!Number.isFinite(couple.angle) || couple.angle === 0) continue
    if (Math.abs(couple.angle) > Math.abs(best.angle)) best = couple
  }
  return best
}
