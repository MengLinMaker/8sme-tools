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
 * Machine role each DSTV face takes in the canonical stance (see the doc §3).
 *
 * Reference view directions (Klietsch DSTV poster / DSTV standard): looking along the member
 * (beam into the page), `o` = Topview (↓), `u` = Bottomview (↑), `v` = Frontview (←, so the
 * *right* face), `h` = Rearview (→, so the *left* face). The letters are anchored to each
 * profile's reference *pose*: `I` = web vertical; `U`/`C` = web vertical with the C opening
 * right; `L` = legs vertical + horizontal; `M` = rect tube; `T` = flange vertical, web
 * horizontal pointing `+v`.
 *
 * A family's row below is that reference pose rotated onto machine-up (+y = top, −y = bottom,
 * ±x = side). `U`/`C` reproduce the standard exactly (cross-checked against Tekla's default
 * hard-stamp faces).
 *
 * The `I` row is the reference pose rotated **90° CCW** into our canonical `H` stance (depth
 * horizontal, flanges vertical — the longer cross-section side horizontal, matching the machine's
 * 800×300 I-beam opening). The web faces `v`/`h` become top/bottom (`v` up) and the flange faces
 * `o`/`u` the two sides — where the flange holes are cut, so side-priority still holds. `M` (tube)
 * is its own 90° rotation (`v` down / `h` up); its row is unchanged.
 *
 * The angle's `o`/`u` vs `v`/`h` split depends on which leg is vertical on the machine.
 *
 * NOTE: the `tee` row does **not** fall out of the T reference pose — rotating a
 * flange-vertical T 90° CCW into our flange-down/web-up stance gives `h`=bottom, `v`=top,
 * `o`/`u`=sides, not the row below. Confirm on the first real T article; `ncFaces.ts` places the
 * geometry at runtime regardless (only cut-priority is affected).
 */
const FACE_ROLES: Record<ProfileFamily, Record<NcFace, MachineRole>> = {
  i: { o: 'side', u: 'side', v: 'top', h: 'bottom' },
  channel: { o: 'side', u: 'side', v: 'bottom', h: 'top' },
  angle: { o: 'top', u: 'bottom', v: 'side', h: 'side' },
  tube: { o: 'side', u: 'side', v: 'bottom', h: 'top' },
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

/** A DSTV face's unit direction in the canonical section frame (`+x` right, `+y` up). */
export interface FaceDirection {
  dx: -1 | 0 | 1
  dy: -1 | 0 | 1
}

/**
 * Which edge of the canonical cross-section each DSTV letter sits on, for the viewer's static face
 * map (see `docs/canonical-orientation.md` figures for an I, channel, angle and tube). This is the
 * *letter → physical edge* table, independent of where material happens to reach: on a channel both
 * web letters are on the top/bottom axis (`h` top, `v` the open bottom), and on a T the flange ends
 * (`o`/`u`) are the two sides. Do not build this from `faceNormal`/`resolveFaceSign` — those project
 * an NC cut onto the material side and collapse a one-sided section's opposite letters onto it.
 *
 * The `tee` row follows the doc's rotation of the DSTV reference pose (flange-vertical → our
 * flange-down/web-up): `v` = web end (top), `h` = flange back (bottom), `o`/`u` = the flange ends
 * (left/right). It is still flagged as an open issue against `FACE_ROLES` in the doc.
 */
export const FACE_DIRECTIONS: Record<ProfileFamily, Record<NcFace, FaceDirection>> = {
  i: {
    o: { dx: 1, dy: 0 },
    u: { dx: -1, dy: 0 },
    v: { dx: 0, dy: 1 },
    h: { dx: 0, dy: -1 },
  },
  channel: {
    o: { dx: 1, dy: 0 },
    u: { dx: -1, dy: 0 },
    v: { dx: 0, dy: -1 },
    h: { dx: 0, dy: 1 },
  },
  tube: {
    o: { dx: 1, dy: 0 },
    u: { dx: -1, dy: 0 },
    v: { dx: 0, dy: -1 },
    h: { dx: 0, dy: 1 },
  },
  angle: {
    o: { dx: 0, dy: 1 },
    u: { dx: 0, dy: -1 },
    v: { dx: 1, dy: 0 },
    h: { dx: -1, dy: 0 },
  },
  tee: {
    o: { dx: -1, dy: 0 },
    u: { dx: 1, dy: 0 },
    v: { dx: 0, dy: 1 },
    h: { dx: 0, dy: -1 },
  },
  round: {
    o: { dx: 0, dy: 1 },
    u: { dx: 0, dy: -1 },
    v: { dx: 1, dy: 0 },
    h: { dx: -1, dy: 0 },
  },
}

/** Edge of the canonical cross-section a DSTV face sits on (for the static face map). */
export function faceDirection(family: ProfileFamily, face: NcFace): FaceDirection {
  return FACE_DIRECTIONS[family][face]
}

/**
 * DSTV faces whose cut lines the STEP viewer extracts, per family. Open sections use the two sides
 * plus the top; a **closed hollow** (SHS/RHS) is machined all round, so all four faces count —
 * including the bottom `v`. An **angle** drops `o` and `v` (those legs aren't cut / aren't
 * extracted).
 */
export const CUT_FACES: Record<ProfileFamily, NcFace[]> = {
  i: ['o', 'u', 'v'],
  channel: ['o', 'u', 'h'],
  tee: ['o', 'u', 'h'],
  tube: ['o', 'u', 'v', 'h'],
  angle: ['u', 'h'],
  round: ['o', 'u', 'h'],
}

/**
 * Signs of a DSTV face's outward normal in the canonical stance. Sides point across the section
 * (`±x`), top/bottom along machine-up (`±y`); a symmetric section's two side letters are
 * interchangeable and both sides are cut, while an asymmetric angle's `v` is the right (`+x`)
 * and `h` the left (`−x`). Shared by the viewer's 3-D targets and the stock-only face thickness
 * map, so a STEP-only part classifies the same faces as an NC-backed one.
 */
export function faceNormalSigns(family: ProfileFamily, face: NcFace): (1 | -1)[] {
  const role = faceRole(family, face)
  if (role !== 'side') return [role === 'top' ? 1 : -1]
  if (family === 'angle') return [face === 'v' ? 1 : -1]
  return [1, -1]
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
