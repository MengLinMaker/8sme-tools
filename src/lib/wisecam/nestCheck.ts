import type { NcexPackage, NcexResult } from './ncexParse'

/**
 * Nest quantity checks for WiseCAM `.ncexa` packages.
 *
 * The check is deliberately about **quantities**, not geometry: it compares
 * `Part.TotalCount` (needed) with the pieces the results actually produce
 * (`Σ PartInfo × Result.Count`) and with WiseCAM's own `Part.NestedCount`. It also
 * verifies the result drawing really holds the declared instances.
 *
 * Confirmed on the 43 J12095 beam-nesting exports:
 *
 * ```
 * nested(part) = Σ_result PartInfo[part].count × Result.params.Count
 * nested(part) = Part.NestedCount
 * drawn(part)  = PartInfo[part].count            (per bar, never × Count)
 * ```
 */

export type NestSeverity = 'error' | 'warning'

export type NestCode =
  | 'part-short'
  | 'part-excess'
  | 'part-not-nested'
  | 'part-no-required'
  | 'nested-count-mismatch'
  | 'result-drawing-part'
  | 'duplicate-result'
  | 'conflicting-result'
  | 'reference-short'
  | 'reference-excess'
  | 'reference-unknown'
  | 'required-mismatch'
  | 'parse'

export interface NestFinding {
  code: NestCode
  severity: NestSeverity
  message: string
  /** Package path (filled by the CLI / caller). */
  file?: string
  /** Human mark, when the finding is about one part. */
  mark?: string
  resultId?: string
  required?: number
  nested?: number
  /** `nested - required`. */
  delta?: number
}

export interface NestPartRow {
  partId: string
  mark: string
  /** `Part.TotalCount` — the job quantity in the package. */
  required: number
  /** Pieces the results produce (`Σ PartInfo × Result.Count`). */
  nested: number
  /** `Part.NestedCount` — WiseCAM's own total. */
  declared: number
  /** `nested - required`. */
  delta: number
  resultIds: string[]
}

export interface NestFileCheck {
  file: string
  package: NcexPackage
  rows: NestPartRow[]
  findings: NestFinding[]
  summary: {
    parts: number
    results: number
    required: number
    nested: number
    short: number
    excess: number
    errors: number
    warnings: number
  }
  ok: boolean
}

export interface NestAggregateRow {
  /** Matching key (normalized mark; lower-case and annotation-free). */
  key: string
  mark: string
  required: number | null
  nested: number
  delta: number | null
  /** Files that contributed pieces for this mark. */
  files: string[]
}

/** How a nest part Name is mapped to the project's mark vocabulary. */
export interface NestResolvedMark {
  mark: string
  key: string
}

export interface NestSetOptions {
  /**
   * Resolve a part `Name` from a nest package. The default strips WiseCAM annotations and
   * lower-cases the result; preflight passes the audit's filename-rule extractor so a nest
   * named `12095, ITEM 35, SHS…` matches the project's `item35`.
   */
  resolveMark?: (name: string | null | undefined) => NestResolvedMark | null
}

export interface NestSetCheck {
  files: NestFileCheck[]
  aggregate: NestAggregateRow[]
  findings: NestFinding[]
  summary: {
    files: number
    passed: number
    failed: number
    distinctResults: number
    duplicateResults: number
    errors: number
    warnings: number
  }
  ok: boolean
}

export interface NestReference {
  label: string
  requiredByKey: Map<string, { mark: string; required: number }>
}

/** Strip WiseCAM/Tekla annotations that are not part of the mark. */
export function normalizeNestMark(name: string | null | undefined): string {
  let value = (name ?? '').trim()
  if (!value) return ''
  value = value.replace(/^modified\s+/i, '')
  value = value.replace(/[\s?？]+$/u, '')
  value = value.replace(/\s+(qie|weld)(?:\s+(qie|weld))*$/iu, '')
  value = value.replace(/[\s?？]+$/u, '')
  return value.trim()
}

/** Matching key for a mark (case-insensitive, annotations stripped). */
export function nestMarkKey(name: string | null | undefined): string {
  return normalizeNestMark(name).toLowerCase()
}

function resultSignature(result: NcexResult): string {
  const info = result.partInfo
    .map((placement) => `${placement.partId}:${placement.count}`)
    .sort()
    .join(',')
  // The adobe is stock, not part of the nest's identity: a re-import gives the same layout a
  // fresh adobe idref, so comparing it would report an identical nest as a conflict.
  return `${result.copies}|${info}`
}

/** Required quantities from a job/project package (`Part.TotalCount`). */
export function nestReference(pkg: NcexPackage, label: string): NestReference {
  const requiredByKey = new Map<string, { mark: string; required: number }>()
  for (const part of pkg.parts) {
    const key = nestMarkKey(part.name)
    if (!key) continue
    const required = Math.max(0, part.totalCount ?? 0)
    if (required <= 0) continue
    const existing = requiredByKey.get(key)
    // Re-imported copies can share a mark; the job quantity is not additive.
    requiredByKey.set(key, {
      mark: existing?.mark ?? normalizeNestMark(part.name),
      required: Math.max(existing?.required ?? 0, required),
    })
  }
  return { label, requiredByKey }
}

function parseFindings(pkg: NcexPackage): NestFinding[] {
  return pkg.issues.map((issue) => ({
    code: 'parse' as const,
    severity: issue.severity,
    message: issue.message,
  }))
}

function drawnMap(result: NcexResult): Map<string, number> | null {
  if (!result.drawn) return null
  return new Map(result.drawn.map((placement) => [placement.partId, placement.count]))
}

/** Check one nest package against the quantities it declares. */
export function checkNestPackage(pkg: NcexPackage, file = ''): NestFileCheck {
  const findings: NestFinding[] = parseFindings(pkg)
  const partsById = new Map(pkg.parts.map((part) => [part.idref, part]))
  const nestedByPart = new Map<string, number>()
  const resultsByPart = new Map<string, string[]>()

  for (const result of pkg.results) {
    for (const placement of result.partInfo) {
      const total = placement.count * result.copies
      nestedByPart.set(placement.partId, (nestedByPart.get(placement.partId) ?? 0) + total)
      const ids = resultsByPart.get(placement.partId) ?? []
      ids.push(result.idref)
      resultsByPart.set(placement.partId, ids)
    }
    const drawn = drawnMap(result)
    if (!drawn) continue
    const declared = new Map<string, number>()
    for (const placement of result.partInfo) {
      declared.set(placement.partId, (declared.get(placement.partId) ?? 0) + placement.count)
    }
    for (const partId of new Set([...drawn.keys(), ...declared.keys()])) {
      const has = drawn.get(partId) ?? 0
      const wants = declared.get(partId) ?? 0
      if (has === wants) continue
      const mark = normalizeNestMark(partsById.get(partId)?.name) || partId
      findings.push({
        code: 'result-drawing-part',
        severity: 'error',
        message: `result ${result.idref}: drawing has ${has} × ${mark}, PartInfo declares ${wants}`,
        file,
        mark,
        resultId: result.idref,
      })
    }
  }

  const rows: NestPartRow[] = pkg.parts.map((part) => {
    const required = Math.max(0, part.totalCount ?? 0)
    const declared = Math.max(0, part.nestedCount ?? 0)
    const nested = nestedByPart.get(part.idref) ?? 0
    const mark = normalizeNestMark(part.name) || part.idref
    const resultIds = resultsByPart.get(part.idref) ?? []
    return {
      partId: part.idref,
      mark,
      required,
      nested,
      declared,
      delta: nested - required,
      resultIds,
    }
  })

  for (const row of rows) {
    if (row.declared !== row.nested) {
      findings.push({
        code: 'nested-count-mismatch',
        severity: 'warning',
        message: `${row.mark}: NestedCount is ${row.declared}, but results produce ${row.nested}`,
        file,
        mark: row.mark,
        nested: row.nested,
        required: row.required,
        delta: row.delta,
      })
    }
    if (row.required === 0) {
      if (row.nested > 0) {
        findings.push({
          code: 'part-no-required',
          severity: 'warning',
          message: `${row.mark}: ${row.nested} nested but TotalCount is 0`,
          file,
          mark: row.mark,
          nested: row.nested,
          required: 0,
          delta: row.nested,
        })
      }
      continue
    }
    if (row.nested > row.required) {
      findings.push({
        code: 'part-excess',
        severity: 'error',
        message: `${row.mark}: nested ${row.nested}, required ${row.required} (over by ${row.nested - row.required})`,
        file,
        mark: row.mark,
        required: row.required,
        nested: row.nested,
        delta: row.delta,
      })
      continue
    }
    if (row.nested < row.required) {
      findings.push({
        code: row.nested === 0 ? 'part-not-nested' : 'part-short',
        severity: 'error',
        message: `${row.mark}: nested ${row.nested}, required ${row.required} (missing ${row.required - row.nested})`,
        file,
        mark: row.mark,
        required: row.required,
        nested: row.nested,
        delta: row.delta,
      })
    }
  }

  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.length - errors
  return {
    file,
    package: pkg,
    rows,
    findings,
    summary: {
      parts: rows.length,
      results: pkg.results.length,
      required: rows.reduce((total, row) => total + row.required, 0),
      nested: rows.reduce((total, row) => total + row.nested, 0),
      short: rows.filter((row) => row.nested < row.required).length,
      excess: rows.filter((row) => row.nested > row.required).length,
      errors,
      warnings,
    },
    ok: errors === 0,
  }
}

function defaultResolveMark(name: string | null | undefined): NestResolvedMark | null {
  const mark = normalizeNestMark(name)
  return mark ? { mark, key: nestMarkKey(name) } : null
}

function addAggregate(
  byKey: Map<string, NestAggregateRow>,
  entry: NestResolvedMark & { pieces: number; file: string },
): void {
  const existing = byKey.get(entry.key)
  if (existing) {
    existing.nested += entry.pieces
    if (!existing.files.includes(entry.file)) existing.files.push(entry.file)
    return
  }
  byKey.set(entry.key, {
    key: entry.key,
    mark: entry.mark,
    required: null,
    nested: entry.pieces,
    delta: null,
    files: [entry.file],
  })
}

/**
 * Check a set of nest exports as one job.
 *
 * Results are de-duplicated by `idref` — the same nest exported in the project file
 * and again as a per-beam file must not be counted twice. When a reference package is
 * supplied, its `Part.TotalCount` values are the job quantities.
 */
export function checkNestSet(
  files: { file: string; package: NcexPackage }[],
  reference?: NestReference | null,
  options?: NestSetOptions,
): NestSetCheck {
  const checks = files.map((entry) => checkNestPackage(entry.package, entry.file))
  const resolveMark = options?.resolveMark ?? defaultResolveMark
  const findings: NestFinding[] = []
  const seen = new Map<string, { file: string; signature: string }>()
  const distinct: { file: string; result: NcexResult; package: NcexPackage }[] = []

  for (const entry of files) {
    for (const result of entry.package.results) {
      const signature = resultSignature(result)
      const previous = seen.get(result.idref)
      if (!previous) {
        seen.set(result.idref, { file: entry.file, signature })
        distinct.push({ file: entry.file, result, package: entry.package })
        continue
      }
      const same = previous.signature === signature
      findings.push({
        code: same ? 'duplicate-result' : 'conflicting-result',
        severity: same ? 'warning' : 'error',
        message: same
          ? `result ${result.idref} appears in ${previous.file} and ${entry.file} (counted once)`
          : `result ${result.idref} differs between ${previous.file} and ${entry.file}`,
        file: entry.file,
        resultId: result.idref,
      })
    }
  }

  const byKey = new Map<string, NestAggregateRow>()
  let duplicates = 0
  for (const finding of findings) {
    if (finding.code === 'duplicate-result') duplicates++
  }
  for (const { file, result, package: pkg } of distinct) {
    const partsById = new Map(pkg.parts.map((part) => [part.idref, part]))
    for (const placement of result.partInfo) {
      const part = partsById.get(placement.partId)
      if (!part) continue
      const resolved = resolveMark(part.name)
      if (!resolved) continue
      addAggregate(byKey, {
        ...resolved,
        pieces: placement.count * result.copies,
        file,
      })
    }
  }

  if (reference) {
    for (const [key, required] of reference.requiredByKey) {
      const row = byKey.get(key)
      if (!row) {
        findings.push({
          code: 'reference-short',
          severity: 'error',
          message: `${required.mark}: required ${required.required}, not nested`,
          mark: required.mark,
          required: required.required,
          nested: 0,
          delta: -required.required,
        })
        byKey.set(key, {
          key,
          mark: required.mark,
          required: required.required,
          nested: 0,
          delta: -required.required,
          files: [],
        })
        continue
      }
      row.required = required.required
      row.delta = row.nested - required.required
      if (row.nested < required.required) {
        findings.push({
          code: 'reference-short',
          severity: 'error',
          message: `${row.mark}: nested ${row.nested} across ${row.files.length} file(s), required ${required.required} (missing ${required.required - row.nested})`,
          mark: row.mark,
          required: required.required,
          nested: row.nested,
          delta: row.delta,
        })
      } else if (row.nested > required.required) {
        findings.push({
          code: 'reference-excess',
          severity: 'error',
          message: `${row.mark}: nested ${row.nested} across ${row.files.length} file(s), required ${required.required} (over by ${row.nested - required.required})`,
          mark: row.mark,
          required: required.required,
          nested: row.nested,
          delta: row.delta,
        })
      }
    }
    for (const [key, row] of byKey) {
      if (reference.requiredByKey.has(key)) continue
      findings.push({
        code: 'reference-unknown',
        severity: 'warning',
        message: `${row.mark}: ${row.nested} nested, but ${reference.label} has no such part`,
        mark: row.mark,
        nested: row.nested,
      })
    }
  }

  if (reference) {
    const mismatches = new Map<string, { mark: string; values: Map<number, string[]> }>()
    for (const entry of files) {
      for (const part of entry.package.parts) {
        const key = nestMarkKey(part.name)
        const wanted = reference.requiredByKey.get(key)
        const total = Math.max(0, part.totalCount ?? 0)
        if (!wanted || total <= 0 || total === wanted.required) continue
        const mismatch = mismatches.get(key) ?? {
          mark: normalizeNestMark(part.name) || key,
          values: new Map<number, string[]>(),
        }
        const sources = mismatch.values.get(total) ?? []
        if (!sources.includes(entry.file)) sources.push(entry.file)
        mismatch.values.set(total, sources)
        mismatches.set(key, mismatch)
      }
    }
    for (const [key, mismatch] of mismatches) {
      const wanted = reference.requiredByKey.get(key)?.required ?? 0
      const detail = [...mismatch.values]
        .sort((a, b) => a[0] - b[0])
        .map(
          ([total, sources]) =>
            `${total} in ${sources.slice(0, 2).join(', ')}${sources.length > 2 ? ` +${sources.length - 2} more` : ''}`,
        )
        .join('; ')
      findings.push({
        code: 'required-mismatch',
        severity: 'warning',
        message: `${mismatch.mark}: TotalCount differs from ${reference.label} (${detail}; job requires ${wanted})`,
        mark: mismatch.mark,
        required: wanted,
      })
    }
  }

  findings.push(...checks.flatMap((check) => check.findings))
  const errors = findings.filter((finding) => finding.severity === 'error').length
  return {
    files: checks,
    aggregate: [...byKey.values()].sort((a, b) => a.mark.localeCompare(b.mark)),
    findings,
    summary: {
      files: checks.length,
      passed: checks.filter((check) => check.ok).length,
      failed: checks.filter((check) => !check.ok).length,
      distinctResults: seen.size,
      duplicateResults: duplicates,
      errors,
      warnings: findings.length - errors,
    },
    ok: errors === 0,
  }
}
