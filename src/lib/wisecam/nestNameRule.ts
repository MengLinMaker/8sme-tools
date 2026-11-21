/**
 * Prototype name matcher for WiseCAM nest parts.
 *
 * Nest names are not project marks. They carry suffixes (`QIE`, `WELD`), a `Modified` prefix, or a
 * full Tekla callout, and different jobs rename things differently. Matching therefore uses two
 * editable regex fields:
 *
 * 1. **clean** — global regex applied to the raw `Part.Name` (noise removal).
 * 2. **extract** — regex whose first non-empty capture group is the key.
 *
 * The key is lower-cased and has `_`/`-` unified, then compared with the project mark keys. Anything
 * that does not match is left unmatched on purpose; there is no fuzzy matching.
 */

export interface NestNameRule {
  /** Global regex source; matched text is removed. Empty = no cleaning. */
  clean: string
  /** Regex source; first non-empty capture group (or the whole match) is the key. */
  extract: string
}

export const DEFAULT_NEST_NAME_RULE: NestNameRule = {
  clean: String.raw`(?:^\s*Modified\s+)|(?:\s+(?:QIE|WELD)(?:\s+(?:QIE|WELD))*\s*[?？]?\s*$)`,
  // ITEM token first (full Tekla callouts), else the first mark-like token (`M_29`, `B7-20`).
  extract: String.raw`\b(ITEM[\s_]*[0-9]+[A-Za-z]?)\b|\b([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*)\b`,
}

export interface NestNameRuleResult {
  /** The cleaned name the extract regex saw. */
  cleaned: string
  /** Matched key, or null when the rule found nothing. */
  key: string | null
  error: string | null
}

/** Normalise a key or project mark: case-insensitive, spaces removed, `_` and `-` unified. */
export function normalizeNestKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '').replace(/_/g, '-')
}

function compile(source: string, flags: string): RegExp | null {
  if (!source.trim()) return null
  return new RegExp(source, flags)
}

/** Apply the clean + extract rule to one raw nest name. */
export function applyNestNameRule(name: string, rule: NestNameRule): NestNameRuleResult {
  let cleaned = name.trim()
  try {
    const cleaner = compile(rule.clean, 'gi')
    if (cleaner) cleaned = cleaned.replace(cleaner, ' ').replace(/\s+/g, ' ').trim()
  } catch (cause) {
    return {
      cleaned,
      key: null,
      error: `Clean regex: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }

  if (!rule.extract.trim()) {
    return { cleaned, key: cleaned ? normalizeNestKey(cleaned) : null, error: null }
  }

  let extractor: RegExp
  try {
    extractor = new RegExp(rule.extract, 'i')
  } catch (cause) {
    return {
      cleaned,
      key: null,
      error: `Extract regex: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }

  const match = extractor.exec(cleaned)
  if (!match) return { cleaned, key: null, error: null }
  const group = match.slice(1).find((value) => value && value.trim())
  const key = normalizeNestKey(group ?? match[0] ?? '')
  return { cleaned, key: key || null, error: null }
}

export interface NestNameMatchRow {
  name: string
  cleaned: string
  key: string | null
  matched: boolean
  projectMark: string | null
}

export interface NestNameMatchSummary {
  rows: NestNameMatchRow[]
  matched: number
  unmatched: number
  /** Project marks that no nest name produced. */
  missingProjectMarks: string[]
  /** Several nest names extracting to the same key. */
  ambiguous: { key: string; names: string[] }[]
  error: string | null
}

export function matchNestNames(
  names: string[],
  projectMarks: string[],
  rule: NestNameRule,
): NestNameMatchSummary {
  const projectByKey = new Map<string, string>()
  for (const mark of projectMarks) {
    const trimmed = mark.trim()
    if (!trimmed) continue
    const key = normalizeNestKey(trimmed)
    if (!projectByKey.has(key)) projectByKey.set(key, trimmed)
  }

  const rows: NestNameMatchRow[] = []
  let error: string | null = null
  for (const name of [...new Set(names.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )) {
    const result = applyNestNameRule(name, rule)
    if (result.error) error = result.error
    const projectMark = result.key ? (projectByKey.get(result.key) ?? null) : null
    rows.push({
      name,
      cleaned: result.cleaned,
      key: result.key,
      matched: projectMark != null,
      projectMark,
    })
  }

  const usedKeys = new Set(rows.map((row) => row.key).filter((key): key is string => key != null))
  const missingProjectMarks = [...projectByKey]
    .filter(([key]) => !usedKeys.has(key))
    .map(([, mark]) => mark)

  const byKey = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.key) continue
    const group = byKey.get(row.key) ?? []
    group.push(row.name)
    byKey.set(row.key, group)
  }
  const ambiguous = [...byKey]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, names: group }))

  return {
    rows,
    matched: rows.filter((row) => row.matched).length,
    unmatched: rows.filter((row) => !row.matched).length,
    missingProjectMarks,
    ambiguous,
    error,
  }
}
