import { PFC_SECTIONS } from '@/lib/sections/pfc'
import { partSectionForCode } from '@/lib/sections/stock'
import { TFB_SECTIONS } from '@/lib/sections/tfb'
import { UB_SECTIONS } from '@/lib/sections/ub'
import { UC_SECTIONS } from '@/lib/sections/uc'

/**
 * The profile callout out of a Tekla filename.
 *
 * `12095, ITEM 35, SHS 75x75x6, 2 OFF[C].STEP` carries the exact section, which is more trustworthy
 * than a STEP slice read: the detector can pick a neighbouring mass variant (`200UB25` vs
 * `200UB25.4`, `150UB14` vs `150UB18.2`), and that shows up as a millimetre-scale *stock* mismatch
 * even when the seating itself is perfect. Some STEPs are not named like this, so this is an
 * override that falls back to detection, never a replacement.
 */
export interface FilenameProfile {
  /** A code `partSectionForCode` resolves against the catalogue, e.g. `SHS75*75*6.0`. */
  code: string
  dims: number[]
}

// `_` is accepted as a separator too: some exports write `SHS_75x75x6` instead of `SHS 75x75x6`.
// A plain `\b` would not fire before `SHS` in `_SHS`, because `_` is a word character.
const FAMILY =
  /(?:^|[^A-Za-z0-9])(SHS|RHS|EA|UA|PFC|TFC|UB|UC|TFB|CHS)[\s_]*([0-9][0-9xX×*.\s_-]*)/i
/** `200UB25` puts the depth first — the family token comes after the number. */
const DEPTH_FIRST = /(?:^|[^A-Za-z0-9])([0-9]{2,3})[\s_]*(UB|UC|TFB)[\s_]*([0-9]+(?:\.[0-9]+)?)/i

/** Numeric tokens of a callout: `SHS 75x75x6` → `[75, 75, 6]`. */
function numbersOf(text: string): number[] {
  return (text.match(/[0-9]+(?:\.[0-9]+)?/g) ?? []).map(Number).filter((value) => value > 0)
}

function resolveRolled(
  sections: { designation: string }[],
  depth: number,
  mass: number | null,
): string | null {
  // Match the **nominal** depth in the designation (`200UB25.4`), not the catalogue's actual depth
  // (203 mm for a 200UB) — the callout always uses the nominal number.
  const byDepth = sections.filter(
    (section) => Number(/^[0-9]+/.exec(section.designation)?.[0] ?? 0) === depth,
  )
  if (byDepth.length === 0) return null
  if (mass == null) return byDepth[0]?.designation ?? null
  const massOf = (designation: string): number =>
    Number(designation.replace(/^[0-9]+[A-Za-z]+/, '')) || 0
  // The callout often truncates the mass (`200UB25` for `200UB25.4`); take the closest.
  let best = byDepth[0] as { designation: string }
  for (const section of byDepth)
    if (Math.abs(massOf(section.designation) - mass) < Math.abs(massOf(best.designation) - mass))
      best = section
  return best.designation
}

/**
 * Resolves a section callout (`SHS 75x75x6`, `200UB25`, `PFC_250`) against the catalogue.
 *
 * Split out from the filename scanner so a custom extraction rule can capture the callout from
 * anywhere in a filename and still go through the one catalogue lookup.
 */
export function profileFromCallout(callout: string): FilenameProfile | null {
  const base = callout.replace(/\[[^\]]*\]/g, ' ')
  const depthFirst = DEPTH_FIRST.exec(base)
  if (depthFirst) {
    const depth = Number(depthFirst[1])
    const family = (depthFirst[2] as string).toUpperCase()
    const mass = Number(depthFirst[3])
    const table = family === 'UB' ? UB_SECTIONS : family === 'UC' ? UC_SECTIONS : TFB_SECTIONS
    const code = resolveRolled(table as never, depth, mass)
    return code && partSectionForCode(code, []) ? { code, dims: [] } : null
  }
  const match = FAMILY.exec(base)
  if (!match) return null
  const family = (match[1] as string).toUpperCase()
  const values = numbersOf(match[2] as string)
  if (values.length === 0) return null
  const [first, second, third] = values as [number, number | undefined, number | undefined]

  let code: string | null = null
  if (family === 'SHS' || family === 'RHS') {
    const a = first
    const b = second ?? first
    const wall = third ?? second
    if (wall == null) return null
    code = `${family}${a}*${b}*${wall}`
  } else if (family === 'EA' || family === 'UA') {
    const legA = first
    const legB = second ?? first
    const thickness = third
    if (thickness == null) return null
    code = `${family}${legA}*${legB}*${thickness}`
  } else if (family === 'CHS') {
    const od = first
    const wall = second
    if (wall == null) return null
    code = `CHS${od}*${wall}`
  } else if (family === 'PFC' || family === 'TFC') {
    code = resolveRolled(PFC_SECTIONS as never, first, null)
  } else if (family === 'UB') {
    code = resolveRolled(UB_SECTIONS as never, first, second ?? null)
  } else if (family === 'UC') {
    code = resolveRolled(UC_SECTIONS as never, first, second ?? null)
  } else if (family === 'TFB') {
    code = resolveRolled(TFB_SECTIONS as never, first, second ?? null)
  }
  if (!code) return null
  // Only trust a code the catalogue can actually build a section from.
  return partSectionForCode(code, []) ? { code, dims: [] } : null
}

/** The profile callout out of a Tekla filename. Bracketed suffixes (`[C]`) are ignored. */
export function profileFromFilename(path: string): FilenameProfile | null {
  return profileFromCallout(path.split(/[\\/]/).pop() ?? path)
}

/**
 * A comparison key for a section callout.
 *
 * The same section is written several ways across an export: a UB mass is often rounded
 * (`200UB25` for `200UB25.4`), hollows vary between `SHS75*75*6` and `SHS 75x75x6`, and a PFC
 * between `PFC250*90` and `PFC 250`. Resolving through the catalogue makes those one key while
 * keeping genuinely different sections apart.
 */
export function profileKey(profile: string): string {
  const parsed = profileFromCallout(profile)
  return (parsed?.code ?? profile).replace(/\s+/g, '').toUpperCase()
}
