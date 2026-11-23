import { profileFromCallout } from '@/lib/sections/fromFilename'
import type { NcexPackage } from './ncexParse'

/**
 * A nesting is normally one stock section. WiseCAM does not write the section designation as a
 * dedicated field, so use the strongest available signal:
 *
 * 1. a profile-looking folder in the export path (`PFC 300x90/M40.ncexa`, `SHS 75x75 T5/…`),
 * 2. the part names resolved through the section catalogue,
 * 3. `Mixed` when names disagree, `Unknown` when nothing carries a section.
 */
const PROFILE_SEGMENT =
  /(?:^|[^A-Za-z0-9])(PFC|TFC|UB|UC|WB|WC|TFB|SHS|RHS|CHS|EA|UA|ANGLE|FLAT|ROD)\b/i

export const MIXED_PROFILE = 'Mixed'
export const UNKNOWN_PROFILE = 'Unknown'

/** The last profile-looking folder segment in a nest path. */
export function profileFromNestPath(path: string): string | null {
  const segments = path.split('/')
  // The basename is a file, not a folder; look at parent folders only.
  for (let index = segments.length - 2; index >= 0; index--) {
    const segment = segments[index]?.trim()
    if (segment && PROFILE_SEGMENT.test(segment)) return segment
  }
  return null
}

export function nestProfile(file: string, pkg: NcexPackage): string {
  const fromPath = profileFromNestPath(file)
  if (fromPath) return fromPath

  const profiles = new Set<string>()
  for (const part of pkg.parts) {
    const name = part.name?.trim()
    if (!name) continue
    const parsed = profileFromCallout(name)
    if (parsed) profiles.add(parsed.code)
  }
  if (profiles.size === 1) return [...profiles][0] as string
  if (profiles.size > 1) return MIXED_PROFILE
  return UNKNOWN_PROFILE
}
