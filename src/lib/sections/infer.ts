import type { UbSection } from './types'
import { UB_SECTIONS } from './ub'

/** Default per-dimension tolerance in mm when fingerprint-matching a halved UB. */
export const DEFAULT_TOLERANCE = 0.6

export interface UbMatch {
  section: UbSection
  /** 1 = exact, 0 = at the tolerance edge */
  score: number
  deltas: { b: number; depthHalf: number; tf: number; tw: number }
}

/**
 * Infers the parent UB of a T-section (a UB split in half) from the cross-section
 * geometry that the Weihong NC header carries:
 *
 *   dims = [ flange width b, half depth d/2, flange thickness tf, web thickness tw, root radius ]
 *
 * Matching requires all four dimensions within `tolerance`; the closest wins.
 * Returns null for non-T sections (angles, RHS, PFC, …).
 */
export function inferParentUb(dims: number[], tolerance = DEFAULT_TOLERANCE): UbMatch | null {
  if (dims.length < 4) return null
  const [b, depthHalf, tf, tw] = dims
  let best: UbMatch | null = null

  for (const section of UB_SECTIONS) {
    const deltas = {
      b: Math.abs(section.b - b),
      depthHalf: Math.abs(section.d / 2 - depthHalf),
      tf: Math.abs(section.tf - tf),
      tw: Math.abs(section.tw - tw),
    }
    const values = Object.values(deltas)
    if (values.some((delta) => delta > tolerance)) continue

    const score = 1 - Math.max(...values) / tolerance
    if (!best || score > best.score) best = { section, score, deltas }
  }

  return best
}

/** Profile families that are never a T (hollow, channel, angle, flat-bar, pipe). */
const NON_TEE_FAMILIES = /^(RHS|SHS|CHS|PFC|EA|UA|RA|TFC|PFB|FLT|PLT|ROD|PIPE)/i

/**
 * Resolves a part's parent UB only when it is genuinely a T-section: the profile
 * name must not name a different family, and the cross-section must fingerprint a
 * halved UB. Guards against a hollow/channel part whose dimensions coincidentally
 * fall within the UB tolerance.
 */
export function inferTee(
  profile: string,
  dims: number[],
  tolerance = DEFAULT_TOLERANCE,
): UbMatch | null {
  if (NON_TEE_FAMILIES.test(profile.trim())) return null
  return inferParentUb(dims, tolerance)
}
