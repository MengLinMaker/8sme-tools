import type { DrawingMaterial } from '@/lib/parsers/pdfText'
import { type PartSortContext, severityRank } from './partSort'
import type { Finding, PartRecord } from './types'

export type PartStatus = 'ok' | 'error' | 'warning' | 'info'

const STATUS_TOKENS: Record<string, PartStatus> = {
  ok: 'ok',
  error: 'error',
  errors: 'error',
  err: 'error',
  warning: 'warning',
  warnings: 'warning',
  warn: 'warning',
  info: 'info',
}

export interface ParsedPartQuery {
  /** Status words (`ok`, `error`, `warning`, `info`) are OR-ed with each other. */
  statuses: PartStatus[]
  /** Every other token is AND-ed against the part's searchable text. */
  terms: string[]
}

interface QueryToken {
  value: string
  quoted: boolean
}

export interface PartFilterContext {
  findings: Finding[]
  materials?: Map<string, DrawingMaterial>
  modelChecks?: Map<string, { ok: boolean; error?: string }>
  /** Marks whose NC carries welding-location etchings. */
  weldingMarks?: ReadonlySet<string>
  /** Finds a finding's human text (localised) so free-text search can match it. */
  findingText?: (finding: Finding) => string
  /** Finds the localised weld-etching description for a mark. */
  weldingText?: (mark: string) => string
}

/** Splits a query on whitespace, keeping quoted phrases together (without the quotes). */
function tokenize(query: string): QueryToken[] {
  const tokens: QueryToken[] = []
  const pattern = /"([^"]*)"|(\S+)/g
  for (let match = pattern.exec(query); match; match = pattern.exec(query)) {
    const value = (match[1] ?? match[2] ?? '').trim()
    if (value) tokens.push({ value, quoted: match[1] !== undefined })
  }
  return tokens
}

/** Quotes a value when it needs to survive a whitespace split. */
function formatToken(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}

export function parsePartQuery(query: string): ParsedPartQuery {
  const statuses: PartStatus[] = []
  const terms: string[] = []
  for (const token of tokenize(query)) {
    const status = token.quoted ? undefined : STATUS_TOKENS[token.value.toLowerCase()]
    if (status) {
      if (!statuses.includes(status)) statuses.push(status)
    } else {
      terms.push(token.value.toLowerCase())
    }
  }
  return { statuses, terms }
}

/** Replaces the status words in a query, leaving the free-text terms untouched. */
export function withStatusFilter(query: string, status: PartStatus | 'all'): string {
  const kept = tokenize(query)
    .filter((token) => token.quoted || !STATUS_TOKENS[token.value.toLowerCase()])
    .map((token) => formatToken(token.value))
  if (status !== 'all') kept.push(status)
  return kept.join(' ')
}

/** Adds a free-text/status token if absent, or removes it when already active. */
export function toggleQueryToken(query: string, token: string): string {
  const needle = token.toLowerCase()
  const tokens = tokenize(query)
  const index = tokens.findIndex(
    (current) => !current.quoted && current.value.toLowerCase() === needle,
  )
  if (index >= 0) tokens.splice(index, 1)
  else tokens.push({ value: token, quoted: /\s/.test(token) })
  return tokens.map((current) => formatToken(current.value)).join(' ')
}

/** Worst status affecting a part: error < warning < info < ok. */
export function statusForPart(part: PartRecord, context: PartFilterContext): PartStatus {
  const sortContext: PartSortContext = {
    findings: context.findings,
    materials: context.materials ?? new Map(),
    modelChecks: context.modelChecks ?? new Map(),
    weldingMarks: context.weldingMarks,
  }
  const rank = severityRank(part, sortContext)
  if (rank === 0) return 'error'
  if (rank === 1) return 'warning'
  if (rank === 2) return 'info'
  return 'ok'
}

/** Everything about a part that the free-text tokens can match. */
export function partSearchText(part: PartRecord, context: PartFilterContext): string {
  const material = context.materials?.get(part.mark)
  const bits: (string | undefined)[] = [
    part.mark,
    part.expected?.profile,
    part.expected?.grade,
    part.nc?.profile,
    part.nc?.profileCode,
    part.nc?.grade,
    part.nc?.orientation,
    material?.section,
    part.step ? 'step' : undefined,
    part.nc ? 'nc' : undefined,
    part.pdf ? 'pdf' : undefined,
  ]
  if (part.assemblies && part.assemblies.length > 0) {
    bits.push('assembly assemblies')
    for (const usage of part.assemblies) bits.push(usage.assembly)
  }
  for (const finding of context.findings) {
    if (finding.mark !== part.mark) continue
    bits.push(finding.code)
    bits.push(context.findingText ? context.findingText(finding) : finding.message)
  }
  if (context.weldingMarks?.has(part.mark)) {
    bits.push('weld welding etched etching scribe')
    bits.push(context.weldingText?.(part.mark))
  }
  const text = bits
    .filter((bit): bit is string => Boolean(bit))
    .join(' ')
    .toLowerCase()
  // Keep the raw code (underscores often separate words) and a spaced copy so either
  // "CUT_DEPTH" or "cut depth" matches.
  return `${text} ${text.replace(/_/g, ' ')}`
}

/**
 * Narrows parts by the search bar's tokens. Status words match the part's worst status
 * (OR-ed together); every other token must appear somewhere in the part's mark, profile,
 * findings or weld etchings.
 */
export function filterParts(
  parts: PartRecord[],
  query: string,
  context: PartFilterContext,
): PartRecord[] {
  const parsed = parsePartQuery(query)
  if (parsed.statuses.length === 0 && parsed.terms.length === 0) return parts
  return parts.filter((part) => {
    if (parsed.statuses.length > 0 && !parsed.statuses.includes(statusForPart(part, context))) {
      return false
    }
    if (parsed.terms.length === 0) return true
    const text = partSearchText(part, context)
    return parsed.terms.every((term) => text.includes(term))
  })
}
