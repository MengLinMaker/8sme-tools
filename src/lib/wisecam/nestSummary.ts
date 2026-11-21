import type { NcexPackage } from './ncexParse'
import { checkNestSet, type NestFinding } from './nestCheck'

/**
 * Name-counting summary for dropped nestings.
 *
 * This deliberately does **not** try to match a nest part name to a project mark, and it does not
 * clean the name either. WiseCAM/Tekla spell the same mark inconsistently (`M_29` / `M-29`,
 * `ITEM 35` / `12095, ITEM 35, …`), so the page reports the `Part.Name` **as written** and counts
 * the pieces its results produce. Duplicate result exports are still counted once.
 */

export interface NestNameRow {
  /** Raw `Part.Name` spelling (trimmed). */
  name: string
  /** Pieces produced under this name, deduped across packages. */
  nested: number
  /** Nesting files that contain the name (even if they contribute 0). */
  files: string[]
  /** Quantity contributed by each nesting file. */
  sources: { file: string; quantity: number }[]
}

export interface NestSummary {
  names: NestNameRow[]
  findings: NestFinding[]
  totals: {
    packages: number
    results: number
    pieces: number
    names: number
    unnamed: number
    packagesWithoutResults: number
  }
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

export function summarizeNests(files: { file: string; package: NcexPackage }[]): NestSummary {
  if (files.length === 0) {
    return {
      names: [],
      findings: [],
      totals: {
        packages: 0,
        results: 0,
        pieces: 0,
        names: 0,
        unnamed: 0,
        packagesWithoutResults: 0,
      },
    }
  }

  const resolveMark = (name: string | null | undefined) => {
    const mark = (name ?? '').trim()
    return mark ? { mark, key: mark } : null
  }
  const report = checkNestSet(files, null, { resolveMark })
  const sourcesByName = new Map<string, Map<string, number>>()
  const seenResults = new Set<string>()
  for (const entry of files) {
    const partsById = new Map(entry.package.parts.map((part) => [part.idref, part]))
    for (const result of entry.package.results) {
      if (seenResults.has(result.idref)) continue
      seenResults.add(result.idref)
      for (const placement of result.partInfo) {
        const name = partsById.get(placement.partId)?.name?.trim()
        const quantity = placement.count * result.copies
        if (!name || quantity <= 0) continue
        const byFile = sourcesByName.get(name) ?? new Map<string, number>()
        byFile.set(entry.file, (byFile.get(entry.file) ?? 0) + quantity)
        sourcesByName.set(name, byFile)
      }
    }
  }
  const filesByName = new Map<string, Set<string>>()
  let unnamed = 0
  for (const entry of files) {
    for (const part of entry.package.parts) {
      const name = part.name?.trim()
      if (!name) {
        unnamed++
        continue
      }
      const containing = filesByName.get(name) ?? new Set<string>()
      containing.add(entry.file)
      filesByName.set(name, containing)
    }
  }
  for (const row of report.aggregate) {
    // A result can name a part that CadRoot omitted; keep it visible.
    if (!filesByName.has(row.mark)) filesByName.set(row.mark, new Set(row.files))
  }

  const names: NestNameRow[] = [...filesByName]
    .map(([name, containing]) => {
      const sources = [...(sourcesByName.get(name) ?? [])]
        .map(([file, quantity]) => ({ file, quantity }))
        .sort(
          (a, b) =>
            b.quantity - a.quantity ||
            baseName(a.file).localeCompare(baseName(b.file), undefined, { numeric: true }),
        )
      return {
        name,
        nested: sources.reduce((total, source) => total + source.quantity, 0),
        files: [...containing],
        sources,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const findings = report.findings.filter(
    (finding) =>
      finding.code === 'duplicate-result' ||
      finding.code === 'conflicting-result' ||
      finding.code === 'parse',
  )

  return {
    names,
    findings,
    totals: {
      packages: files.length,
      results: report.summary.distinctResults,
      pieces: names.reduce((total, row) => total + row.nested, 0),
      names: names.length,
      unnamed,
      packagesWithoutResults: files.filter((entry) => entry.package.results.length === 0).length,
    },
  }
}
