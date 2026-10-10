import type { DrawingMaterial } from '@/lib/parsers/pdfText'
import type { Finding, PartRecord, Severity } from './types'

export type PartSortKey =
  | 'severity'
  | 'mark'
  | 'ncQty'
  | 'pdfQty'
  | 'ncLen'
  | 'pdfLen'
  | 'profile'
  | 'nc'
  | 'step'
  | 'pdf'
  | 'model'

export interface PartSortContext {
  findings: Finding[]
  materials: Map<string, DrawingMaterial>
  modelChecks: Map<string, { ok: boolean }>
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
/** ok = 3, so ascending order puts the worst problems first. */
const OK_RANK = 3

/** Worst problem affecting a part: error < warning < info < ok. */
export function severityRank(part: PartRecord, context: PartSortContext): number {
  let rank = OK_RANK
  for (const finding of context.findings) {
    if (finding.mark === part.mark) rank = Math.min(rank, SEVERITY_RANK[finding.severity])
  }
  const model = context.modelChecks.get(part.mark)
  if (model && !model.ok) rank = Math.min(rank, SEVERITY_RANK.warning)
  return rank
}

function fileRank(valid: boolean | undefined, present: boolean): number {
  if (!present) return 1 // missing
  return valid ? 2 : 0 // invalid sorts before missing and ok
}

function partValue(
  part: PartRecord,
  key: PartSortKey,
  context: PartSortContext,
): number | string | null {
  const material = context.materials.get(part.mark)
  switch (key) {
    case 'severity':
      return severityRank(part, context)
    case 'mark':
      return part.mark
    case 'profile':
      return part.nc?.profile ?? part.expected?.profile ?? ''
    case 'ncQty':
      return part.nc?.quantity ?? null
    case 'pdfQty':
      return material?.qty ?? part.expected?.qty ?? null
    case 'ncLen':
      return part.nc?.length ?? null
    case 'pdfLen':
      return material?.length ?? part.expected?.length ?? null
    case 'nc':
      return fileRank(part.nc?.valid, part.nc != null)
    case 'step':
      return fileRank(part.step?.valid, part.step != null)
    case 'pdf':
      return fileRank(part.pdf?.valid, part.pdf != null)
    case 'model': {
      const check = context.modelChecks.get(part.mark)
      return check ? (check.ok ? 1 : 0) : 2
    }
  }
}

/** Returns a new array sorted by the column, problems-first for severity/status columns. */
export function sortParts(
  parts: PartRecord[],
  key: PartSortKey,
  direction: 1 | -1,
  context: PartSortContext,
): PartRecord[] {
  const sorted = [...parts].sort((a, b) => {
    const av = partValue(a, key, context)
    const bv = partValue(b, key, context)
    if (av === null && bv === null) return 0
    if (av === null) return 1 // nulls last
    if (bv === null) return -1
    if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv)
    return (av as number) - (bv as number)
  })
  return direction === 1 ? sorted : sorted.reverse()
}
