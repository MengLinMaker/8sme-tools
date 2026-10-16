import type { PartRecord } from './types'

/**
 * A part's listed section code — the NC header, or the part-list cell — trimmed, or `null` when it
 * is absent **or blank**.
 *
 * A blank part-list cell must read as "no code", not as the code `""`: a STEP-only part whose row
 * carries an empty profile cell still needs its geometry-inferred section to show (a plain `??`
 * chain would return the empty string and hide it).
 */
export function listedProfile(part: PartRecord): string | null {
  return part.nc?.profile?.trim() || part.expected?.profile?.trim() || null
}
