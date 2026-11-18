/**
 * Fixability tiers — how much of a finding's fix the tool can decide for itself.
 *
 * - `auto`: the batch "Auto fix" applies it. Every auto code has a **well-defined default**: one
 *   authoritative source and one computed target, so the tool would make the same choice the
 *   operator would. A wrong auto fix here costs time but cannot invent intent.
 * - `manual`: a fix exists, but it needs a human choice, so it is only ever offered one at a time
 *   (the finding's own fix menu). A wrong guess here changes what gets cut or shipped.
 * - no tier: nothing can be fixed automatically or one-click; it has to be re-drawn or re-exported.
 *
 * Why the split matters — each of these was decided on a real job:
 *
 * - `STRAY_BODY`: a spark sliver and a second nested piece look identical from a body count, and
 *   the correct answers are opposite (drop it vs join it with tabs). Case by case.
 * - `MANUFACTURE_MISMATCH` / `MANUFACTURE_BORDERLINE`: the Tekla STEP is the more accurate
 *   artefact; the NC rebuild approximates it (end radii, mitres, bevel-cut ends). Rebuilding to
 *   close a volume delta therefore *downgrades* the export. The delta is a divergence signal, not
 *   a verdict on which side is wrong.
 * - `CUT_BEVEL_CHANGE`: the suggested angle is a majority vote across the line's vertices, not a
 *   default, and unifying rewrites weld prep. The operator picks the angle (or drops it).
 * - `BEVEL_OUT_OF_RANGE` stays auto: clamping to the nearest in-range angle on the same side is
 *   the minimal change, and the drawn angle cannot be made anyway.
 *
 * `CUT_END_PIECE` is the one auto code that touches STEP geometry rather than NC text (the NC
 * would detach the bevel-cut end, so the model leaves it attached). It is auto because there is
 * no choice to make — the exported STEP has to be one connected body — but it is a deliberate
 * compromise, not a repair of the real part.
 */

export type FixTier = 'auto' | 'manual'

/** Codes the batch fix may apply. Every one has a computed target. */
export const AUTO_FIX_CODES: ReadonlySet<string> = new Set([
  'CUT_ROOT_FILLET',
  'BEVEL_OUT_OF_RANGE',
  'CUT_UNCLOSED',
  'CUT_CUTOUT',
  'CUT_END_PIECE',
])

/** Codes with a fix that needs the operator to choose, so they are fixed one at a time. */
export const MANUAL_FIX_CODES: ReadonlySet<string> = new Set([
  'CUT_BEVEL_CHANGE',
  'STRAY_BODY',
  'MANUFACTURE_MISMATCH',
  'MANUFACTURE_BORDERLINE',
])

/** The tier a finding code's fix belongs to, or null when there is no fix for it. */
export function fixTierForCode(code: string): FixTier | null {
  if (AUTO_FIX_CODES.has(code)) return 'auto'
  if (MANUAL_FIX_CODES.has(code)) return 'manual'
  return null
}
