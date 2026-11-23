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
  /** Planned pieces under this name, deduped across packages. */
  nested: number
  /**
   * Actually cut pieces, from the per-file cut counts (defaults to planned). These are
   * operator-entered: `.ncexa` carries no cut state — see `docs/architecture.md` §18.
   */
  cut: number
  /** Nesting files that contain the name (even if they contribute 0). */
  files: string[]
  /** Planned and cut quantity contributed by each nesting file. */
  sources: { file: string; quantity: number; cut: number }[]
}

export interface NestSummary {
  names: NestNameRow[]
  findings: NestFinding[]
  totals: {
    packages: number
    results: number
    pieces: number
    cutPieces: number
    names: number
    unnamed: number
    packagesWithoutResults: number
  }
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

export function summarizeNests(
  files: { file: string; package: NcexPackage }[],
  cutByFile?: Map<string, number> | Record<string, number>,
): NestSummary {
  if (files.length === 0) {
    return {
      names: [],
      findings: [],
      totals: {
        packages: 0,
        results: 0,
        pieces: 0,
        cutPieces: 0,
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
  const cutMap =
    cutByFile instanceof Map
      ? cutByFile
      : cutByFile
        ? new Map(Object.entries(cutByFile))
        : new Map<string, number>()
  const report = checkNestSet(files, null, { resolveMark })
  const sourcesByName = new Map<string, Map<string, { quantity: number; cut: number }>>()
  const seenResults = new Set<string>()
  for (const entry of files) {
    const partsById = new Map(entry.package.parts.map((part) => [part.idref, part]))
    const uniqueResults = entry.package.results.filter((result) => {
      if (seenResults.has(result.idref)) return false
      seenResults.add(result.idref)
      return true
    })
    // A file's cut count is in stock bars; scale its results proportionally when it has more
    // than one result. Most exports have one.
    const plannedBars = uniqueResults.reduce((total, result) => total + result.copies, 0)
    const cutBars = Math.max(0, cutMap.get(entry.file) ?? plannedBars)
    const factor = plannedBars > 0 ? cutBars / plannedBars : 0
    for (const result of uniqueResults) {
      for (const placement of result.partInfo) {
        const name = partsById.get(placement.partId)?.name?.trim()
        const quantity = placement.count * result.copies
        if (!name || quantity <= 0) continue
        const byFile = sourcesByName.get(name) ?? new Map()
        const previous = byFile.get(entry.file) ?? { quantity: 0, cut: 0 }
        byFile.set(entry.file, {
          quantity: previous.quantity + quantity,
          cut: previous.cut + quantity * factor,
        })
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
        .map(([file, source]) => ({ file, quantity: source.quantity, cut: source.cut }))
        .sort(
          (a, b) =>
            b.quantity - a.quantity ||
            baseName(a.file).localeCompare(baseName(b.file), undefined, { numeric: true }),
        )
      return {
        name,
        nested: sources.reduce((total, source) => total + source.quantity, 0),
        cut: sources.reduce((total, source) => total + source.cut, 0),
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
      cutPieces: names.reduce((total, row) => total + row.cut, 0),
      names: names.length,
      unnamed,
      packagesWithoutResults: files.filter((entry) => entry.package.results.length === 0).length,
    },
  }
}
