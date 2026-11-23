import { profileFamily } from '@/lib/sections/canonical'

/**
 * The section a part is filed under in preflight: the authored NC / part-list profile when it has
 * one, else the section read from the STEP geometry.
 */
export interface SectionIdentity {
  /** NC header / part-list profile text (the authored code), when present. */
  profile?: string | null
  /** The label shown in the parts table (the profile, or the geometry-inferred label). */
  label?: string | null
}

/** A T profile code, e.g. `BT100*15`. A label like `200UB29.8 (T)` is its parent UB, not a T. */
export function isTeeSection(value: string | null | undefined): boolean {
  const text = value?.trim()
  if (!text) return false
  return profileFamily(text) === 'tee'
}

/**
 * The stock section a part label names. A geometry label appends `(T)` for a T piece
 * (`200UB29.8 (T)`), but the section — and the beam it is bought as — is the parent UB, so the
 * suffix is dropped for display and profile grouping.
 */
export function stockSectionLabel(value: string): string {
  return value.replace(/\s*\(\s*T\s*\)\s*$/i, '')
}

/**
 * Whether a part is **rejected** from the job because its section is not a stock section.
 *
 * A `BT…` code is a halved-UB product, not a stock section, so it is rejected. A label such as
 * `200UB29.8 (T)` names the parent UB (the stock the T is cut from), so it is kept as a UB even
 * though the piece is a T. A real section family (`UB`, `UC`, `PFC`, `TFB`, `SHS`, `RHS`, `CHS`,
 * angle) keeps its place even when the catalogue has no exact mass variant; a label no family
 * claims (`—`, a bare mark, `Mixed`) is rejected as unrecognisable.
 */
export function isRejectedSection(section: SectionIdentity): boolean {
  const profile = section.profile?.trim()
  const label = section.label?.trim() || profile || ''
  if (!label || label === '—') return true
  if (isTeeSection(label)) return true
  if (profile && isTeeSection(profile)) return true
  return profileFamily(label) == null
}
