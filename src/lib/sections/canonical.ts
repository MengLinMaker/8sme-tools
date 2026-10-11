import { MACHINE } from '@/lib/machine/profile'
import type { NcFace } from '@/lib/parsers/ncGeometry'

/**
 * Canonical orientation for stock and pieces — the pure decision layer.
 *
 * The stock cross-sections **should** be drawn in their canonical manufacturing stance by
 * `stock.ts` (PFC = `n`, UB/UC = `H`, RHS = long side horizontal, angle = `L`, T = flange
 * down). Today `stock.ts` draws `H` / `L` / flange-down; its PFC (`n`) and RHS
 * (long-side-horizontal) builders are **not changed yet** — this module is the documented,
 * machine-readable spec they should conform to. It answers the two questions that follow from
 * the stance:
 *
 *   1. once the stock sits in its stance, which machine role (top / side / bottom) does each
 *      DSTV face (`v`/`o`/`u`/`h`) become?  → {@link faceRole}
 *   2. where should we prefer to cut, and when may we cut the bottom?  → {@link cutPriority},
 *      {@link bottomCutAllowed}
 *
 * Full rationale and the derivation of the face-role table: `docs/canonical-orientation.md`.
 * Pure (no three.js / OCC), so it is unit-tested directly.
 */

/** Collapsed profile families, mapped from a section code. */
export type ProfileFamily = 'i' | 'channel' | 'angle' | 'tube' | 'tee' | 'round'

/** The canonical machine stance drawn for a family. */
export type StockStance = 'H' | 'n' | 'L' | 'long-horizontal' | 'flange-down' | 'round'

/** Where a face physically sits on the machine once the stock is in its canonical stance. */
export type MachineRole = 'top' | 'bottom' | 'side'

export const CANONICAL_STANCE: Record<ProfileFamily, StockStance> = {
  i: 'H',
  channel: 'n',
  angle: 'L',
  tube: 'long-horizontal',
  tee: 'flange-down',
  round: 'round',
}

/**
 * Machine role each DSTV face takes in the canonical stance (see the doc §3). Derived by
 * rotating the DSTV/Tekla reference pose (Klietsch profile diagram) onto machine-up (+y = top,
 * −y = bottom, ±x = side). `I` and `U`/`C` are derived and cross-checked against Tekla's default
 * hard-stamp faces; the angle's split between `o`/`u` and `v`/`h` depends on which leg ends up
 * vertical and must be confirmed on the first article.
 */
const FACE_ROLES: Record<ProfileFamily, Record<NcFace, MachineRole>> = {
  i: { o: 'top', u: 'bottom', v: 'side', h: 'side' },
  channel: { o: 'side', u: 'side', v: 'bottom', h: 'top' },
  angle: { o: 'top', u: 'bottom', v: 'side', h: 'side' },
  tube: { o: 'top', u: 'bottom', v: 'side', h: 'side' },
  tee: { o: 'side', u: 'bottom', v: 'side', h: 'side' },
  round: { o: 'top', u: 'bottom', v: 'side', h: 'side' },
}

const PREFIXES: [RegExp, ProfileFamily][] = [
  [/^BT/, 'tee'],
  [/^EA/, 'angle'],
  [/^UA/, 'angle'],
  [/^RHS/, 'tube'],
  [/^SHS/, 'tube'],
  [/^CHS/, 'round'],
  [/^TFC/, 'channel'],
  [/^PFC/, 'channel'],
  [/^UC/, 'i'],
  [/^TFB/, 'i'],
  [/^(?:UB|WB|WC)/, 'i'],
]

/**
 * Classifies a section code into a canonical family, mirroring `stock.ts`'s family detection.
 * Returns null for a code no family claims.
 */
export function profileFamily(code: string): ProfileFamily | null {
  const clean = code.trim().replace(/\s+/g, '').toUpperCase()
  if (!clean) return null
  if (/^\d/.test(clean)) {
    if (/(?:PFC|TFC)/.test(clean)) return 'channel'
    if (/(?:UB|WB|WC|UC|TFB)/.test(clean)) return 'i'
    return null
  }
  return PREFIXES.find(([pattern]) => pattern.test(clean))?.[1] ?? null
}

/** Machine role of a DSTV face once the stock is in its canonical stance. */
export function faceRole(family: ProfileFamily, face: NcFace): MachineRole {
  return FACE_ROLES[family][face]
}

/** Lower is better: cut sides first (most controllable), then top, and the bottom last. */
export const CUT_ROLE_PRIORITY: Record<MachineRole, number> = { side: 0, top: 1, bottom: 2 }

/** Cut preference score for a face (0 = best). */
export function cutPriority(family: ProfileFamily, face: NcFace): number {
  return CUT_ROLE_PRIORITY[faceRole(family, face)]
}

/** Largest slug a bottom cut may drop without endangering the head (grams). */
export const BOTTOM_CUT_MAX_GRAMS = MACHINE.bottomCutMaxGrams

/** Steel density in g/mm³ (7850 kg/m³, per AS/NZS 3679.1). */
const STEEL_DENSITY_G_PER_MM3 = 7.85e-3

/** Mass (g) of a prismatic virgin piece: cross-section `area` (mm²) × `length` (mm). */
export function removedMassGrams(area: number, length: number): number {
  return area * length * STEEL_DENSITY_G_PER_MM3
}

/** Mass (g) removed by a round hole of `diameter` (mm) through `thickness` (mm). */
export function holeRemovedMassGrams(diameter: number, thickness: number): number {
  const radius = diameter / 2
  return removedMassGrams(Math.PI * radius * radius, thickness)
}

/** Whether a bottom cut removing `massGrams` is safe. `maxGrams` defaults to 10 g. */
export function bottomCutAllowed(massGrams: number, maxGrams = BOTTOM_CUT_MAX_GRAMS): boolean {
  return massGrams < maxGrams
}
