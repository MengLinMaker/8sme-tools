import type { DrawingMaterial } from '@/lib/parsers/pdfText'
import type { Finding, PartRecord, Severity } from './types'

export type PartSortKey = 'severity' | 'mark' | 'assembly' | 'qty' | 'mass' | 'profile' | 'model'

export interface PartSortContext {
  findings: Finding[]
  materials: Map<string, DrawingMaterial>
  /** `error` lets a STEP-only (`stepOnly`) or NC-only (`ncOnly`) size count as no problem. */
  modelChecks: Map<
    string,
    {
      ok: boolean
      error?: string
      measured?: [number, number, number]
      expected?: [number, number, number]
    }
  >
  /** Marks whose NC carries welding-location etchings; sorted just above clean parts. */
  weldingMarks?: ReadonlySet<string>
  /** Per-piece mass as displayed in the table, when it is derived (not just the drawing weight). */
  mass?: (part: PartRecord) => number | null
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
/** Weld etchings are informational, but rank above a part with no status at all. */
const WELD_RANK = SEVERITY_RANK.info
/** ok = 3, so ascending order puts the worst problems first. */
const OK_RANK = 3

/** Worst problem affecting a part: error < warning < info/weld < ok. */
export function severityRank(part: PartRecord, context: PartSortContext): number {
  let rank = OK_RANK
  for (const finding of context.findings) {
    if (finding.mark === part.mark) rank = Math.min(rank, SEVERITY_RANK[finding.severity])
  }
  if (context.weldingMarks?.has(part.mark)) rank = Math.min(rank, WELD_RANK)
  const model = context.modelChecks.get(part.mark)
  if (model && !model.ok && model.error !== 'stepOnly' && model.error !== 'ncOnly') {
    rank = Math.min(rank, SEVERITY_RANK.warning)
  }
  return rank
}

type SortValue = number | string | readonly number[] | null

function partValue(part: PartRecord, key: PartSortKey, context: PartSortContext): SortValue {
  const material = context.materials.get(part.mark)
  switch (key) {
    case 'severity':
      return severityRank(part, context)
    case 'mark':
      return part.mark
    case 'assembly':
      return part.assemblies?.[0]?.assembly ?? null
    case 'profile':
      return part.nc?.profile ?? part.expected?.profile ?? ''
    case 'qty':
      // Drawing (ground truth) first, NC only as a fallback.
      return material?.qty ?? part.expected?.qty ?? part.nc?.quantity ?? null
    case 'mass':
      // Use the same per-piece mass the table shows (drawing first, then a section estimate).
      if (context.mass) return context.mass(part)
      return material?.weight ?? part.expected?.weight ?? null
    case 'model': {
      // Sort by the size the column shows, length first, so parts line up by model size.
      const check = context.modelChecks.get(part.mark)
      return check?.measured ?? check?.expected ?? null
    }
  }
}

/** Compares two non-null values; strings sort naturally (m-1 < m-2 < m-12) case-insensitively. */
function compareValues(a: Exclude<SortValue, null>, b: Exclude<SortValue, null>): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length)
    for (let i = 0; i < length; i++) {
      const compared = (a[i] ?? -Infinity) - (b[i] ?? -Infinity)
      if (compared !== 0) return compared
    }
    return 0
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  }
  return (a as number) - (b as number)
}

/** Returns a new array sorted by the column, problems-first for severity/status columns. */
export function sortParts(
  parts: PartRecord[],
  key: PartSortKey,
  direction: 1 | -1,
  context: PartSortContext,
): PartRecord[] {
  return [...parts].sort((a, b) => {
    const av = partValue(a, key, context)
    const bv = partValue(b, key, context)
    // Missing values always sit at the bottom, whichever way the column is sorted.
    if (av === null && bv === null) return 0
    if (av === null) return 1
    if (bv === null) return -1
    const compared = compareValues(av, bv)
    if (compared !== 0) return compared * direction
    // A weld mark can block production, so within the same status it comes first.
    if (key === 'severity') {
      const aw = context.weldingMarks?.has(a.mark) ? 0 : 1
      const bw = context.weldingMarks?.has(b.mark) ? 0 : 1
      return aw - bw
    }
    return 0
  })
}
