import { ChevronLeft, ChevronRight, Settings2 } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Toggle } from '@/components/ui/toggle'
import { NEST_FILE } from '@/lib/audit/nestFiles'
import { formatNumber } from '@/lib/format'
import { type ProfileFamily, profileFamily } from '@/lib/sections/canonical'
import { profileKey } from '@/lib/sections/fromFilename'
import { cn } from '@/lib/utils'
import { type NcexPackage, parseNexPackage } from '@/lib/wisecam/ncexParse'
import {
  matchNestNames,
  type NestNameMatchSummary,
  type NestNameRule,
} from '@/lib/wisecam/nestNameRule'
import { MIXED_PROFILE, nestProfile, UNKNOWN_PROFILE } from '@/lib/wisecam/nestProfile'
import { type NestSummary, summarizeNests } from '@/lib/wisecam/nestSummary'
import type { ZipEntry } from '@/lib/zip'
import { NestingFileTree } from './NestingFileTree'

const SECONDARY_TABLE_ROW = 'bg-violet-500/25 ring-1 ring-inset ring-violet-300/70'
const EMPTY: Set<string> = new Set()

export interface ProjectPartQuantity {
  mark: string
  required: number
  /** The part's section label (parts-table PROFILE), used to scope a section. */
  profile: string
}

interface LoadedPackage {
  file: string
  package: NcexPackage
  profile: string
}

/** A package before its section is resolved from the parts it nests. */
interface RawPackage {
  file: string
  package: NcexPackage
  rawProfile: string
}

interface CoverageRow {
  mark: string
  required: number
  nested: number
  cut: number
  diff: number
  sources: { file: string; quantity: number; cut: number }[]
}

/** Everything one section (profile) needs for its overview row and drill-down view. */
interface SectionData {
  profile: string
  packages: LoadedPackage[]
  selectedPackages: LoadedPackage[]
  summary: NestSummary
  parts: ProjectPartQuantity[]
  matcher: NestNameMatchSummary
  coverage: CoverageRow[]
  abnormalities: number
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function looseKey(value: string): string {
  return value.toLowerCase().replace(/[\s_/,.-]+/g, '')
}

/**
 * A machine nesting is structurally one stock-bar layout: exactly one `<Result>`. The WiseCAM
 * project snapshot aggregates every layout (NW30 TOP.ncexa has 11 Results, each also exported per
 * beam), so it is not a nesting file and must not be listed beside them.
 */
function isMachineNesting(pkg: NcexPackage): boolean {
  return pkg.results.length === 1
}

/** Stock bars per adobe length across the given nestings (results deduped). */
function stockLengthRows(packages: LoadedPackage[]): { length: number | null; bars: number }[] {
  const seen = new Set<string>()
  const rows = new Map<number | null, number>()
  for (const pkg of packages) {
    const lengths = new Map(pkg.package.adobes.map((adobe) => [adobe.idref, adobe.length]))
    for (const result of pkg.package.results) {
      if (seen.has(result.idref)) continue
      seen.add(result.idref)
      const length = lengths.get(result.adobeId) ?? null
      rows.set(length, (rows.get(length) ?? 0) + result.copies)
    }
  }
  return [...rows]
    .map(([length, bars]) => ({ length, bars }))
    .sort((a, b) => (b.length ?? 0) - (a.length ?? 0))
}

/** The part names a nesting actually places (its results), not its whole part library. */
function nestedPartNames(pkg: NcexPackage): string[] {
  const partsById = new Map(pkg.parts.map((part) => [part.idref, part]))
  const names = new Set<string>()
  for (const result of pkg.results) {
    for (const placement of result.partInfo) {
      const name = partsById.get(placement.partId)?.name?.trim()
      if (name) names.add(name)
    }
  }
  return [...names]
}

/** The section key with the most matched marks in a nesting. */
function dominantKey(counts: Map<string, number> | undefined): string | null {
  if (!counts) return null
  let best: string | null = null
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  return best
}

function labelFamily(label: string): ProfileFamily | null {
  return /^ANGLE/i.test(label.trim()) ? 'angle' : profileFamily(label)
}

function labelNumbers(label: string): number[] {
  return (label.match(/[0-9]+(?:\.[0-9]+)?/g) ?? []).map(Number)
}

/**
 * Resolve a folder label that has no placed parts (`RHS 150x100 T9`, `UB 200x29 BT`) to the real
 * section label the parts use (`RHS150*100*9.0`, `200UB29.8`): exact key first, then family plus
 * the first nominal numbers with a 1 mm tolerance.
 */
function matchSectionLabel(label: string, labels: Map<string, string>): string | null {
  const exact = labels.get(profileKey(label))
  if (exact) return exact
  const family = labelFamily(label)
  if (!family) return null
  const expected = labelNumbers(label)
  const count = family === 'channel' || family === 'round' ? 1 : 2
  if (expected.length === 0) return null
  for (const candidate of labels.values()) {
    if (labelFamily(candidate) !== family) continue
    const actual = labelNumbers(candidate)
    const shared = Math.min(count, expected.length, actual.length)
    if (shared === 0) continue
    if (
      expected.slice(0, shared).every((value, index) => Math.abs(value - (actual[index] ?? 0)) <= 1)
    ) {
      return candidate
    }
  }
  return null
}

/** Required vs nested/cut per project mark, for one section's parts. */
function buildCoverage(
  parts: ProjectPartQuantity[],
  matcher: NestNameMatchSummary,
  summary: NestSummary,
): CoverageRow[] {
  const namesByName = new Map(summary.names.map((row) => [row.name, row]))
  const rows = parts.map((part) => {
    const matched = matcher.rows.filter((row) => row.matched && row.projectMark === part.mark)
    let nested = 0
    let cut = 0
    const sources = new Map<string, { quantity: number; cut: number }>()
    for (const match of matched) {
      const name = namesByName.get(match.name)
      if (!name) continue
      nested += name.nested
      cut += name.cut
      for (const source of name.sources) {
        const previous = sources.get(source.file) ?? { quantity: 0, cut: 0 }
        sources.set(source.file, {
          quantity: previous.quantity + source.quantity,
          cut: previous.cut + source.cut,
        })
      }
    }
    const required = Math.max(0, part.required)
    return {
      mark: part.mark,
      required,
      nested,
      cut,
      diff: cut - required,
      sources: [...sources]
        .map(([file, source]) => ({ file, quantity: source.quantity, cut: source.cut }))
        .sort(
          (a, b) =>
            b.quantity - a.quantity ||
            baseName(a.file).localeCompare(baseName(b.file), undefined, { numeric: true }),
        ),
    }
  })
  return rows.sort((a, b) => a.mark.localeCompare(b.mark, undefined, { numeric: true }))
}

/**
 * The section overview: one row per nesting profile with its coverage statistics. A row opens
 * that section's dual Nestings/Marks view, so a job with hundreds of parts is read section by
 * section instead of all at once.
 */
function SectionOverview({
  sections,
  openProfile,
  onToggle,
}: {
  sections: SectionData[]
  openProfile: string | null
  onToggle: (profile: string) => void
}) {
  const { t } = useTranslation()
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('preflight.nestingCoverage.section')}</TableHead>
          <TableHead className="w-px text-right">{t('preflight.nestingCoverage.files')}</TableHead>
          <TableHead className="w-px text-right">{t('preflight.nestingCoverage.pieces')}</TableHead>
          <TableHead className="w-px text-right">
            {t('preflight.nestingCoverage.cutPieces')}
          </TableHead>
          <TableHead className="w-px text-right">{t('preflight.nestingCoverage.marks')}</TableHead>
          <TableHead className="w-px text-right">
            {t('preflight.nestingCoverage.abnormalities')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sections.map((section) => {
          const open = section.profile === openProfile
          return (
            <TableRow
              key={section.profile}
              onClick={() => onToggle(section.profile)}
              className={cn('cursor-pointer', open && 'bg-muted/40')}
            >
              <TableCell>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggle(section.profile)
                  }}
                  aria-expanded={open}
                  className="flex w-full items-center gap-1.5 text-left"
                >
                  <span
                    className={cn(
                      'text-muted-foreground transition-transform',
                      open && 'rotate-90',
                    )}
                  >
                    ›
                  </span>
                  <span className="font-medium">{section.profile}</span>
                </button>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(section.selectedPackages.length, 0)} /{' '}
                {formatNumber(section.packages.length, 0)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(section.summary.totals.pieces, 0)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(section.summary.totals.cutPieces, 0)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumber(section.coverage.length, 0)}
              </TableCell>
              <TableCell
                className={cn(
                  'text-right font-semibold tabular-nums',
                  section.abnormalities > 0 ? 'text-amber-400' : 'text-muted-foreground',
                )}
              >
                {formatNumber(section.abnormalities, 0)}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** The drill-down: the section's file tree beside its marks coverage. */
function SectionView({
  data,
  selected,
  plannedByFile,
  cutByFile,
  onToggle,
  onCutChange,
}: {
  data: SectionData
  selected: Set<string>
  plannedByFile: Map<string, number>
  cutByFile: Map<string, number>
  onToggle: (paths: string[], allSelected: boolean) => void
  onCutChange: (file: string, value: number) => void
}) {
  const { t } = useTranslation()
  const [hoveredFiles, setHoveredFiles] = useState<Set<string>>(new Set())
  const [hoveredMark, setHoveredMark] = useState<string | null>(null)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [expandedMarks, setExpandedMarks] = useState<Set<string>>(new Set())

  const paths = data.packages.map((pkg) => pkg.file)
  const namesByName = useMemo(
    () => new Map(data.summary.names.map((row) => [row.name, row])),
    [data.summary.names],
  )
  const unmatched = data.matcher.rows.filter((row) => !row.matched)
  const missingRows = data.matcher.missingProjectMarks.map((mark) => {
    const key = looseKey(mark)
    return {
      mark,
      candidates: unmatched.filter((row) => looseKey(row.name).includes(key)),
    }
  })
  const hoveredRow = hoveredMark ? data.coverage.find((row) => row.mark === hoveredMark) : undefined
  const secondaryFiles = hoveredRow
    ? new Set(hoveredRow.sources.map((source) => source.file))
    : EMPTY
  const visible = onlyProblems ? data.coverage.filter((row) => row.diff !== 0) : data.coverage
  const stockLengths = useMemo(
    () => stockLengthRows(data.selectedPackages),
    [data.selectedPackages],
  )

  const toggleMark = (mark: string) => {
    setExpandedMarks((current) => {
      const next = new Set(current)
      if (next.has(mark)) next.delete(mark)
      else next.add(mark)
      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-row items-stretch">
      <div className="flex min-h-0 w-2/5 min-w-[12rem] shrink-0 flex-col border-r border-border pr-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('preflight.nestingCoverage.files')}</h3>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => onToggle(paths, false)}>
              {t('preflight.nestingCoverage.all')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onToggle(paths, true)}>
              {t('preflight.nestingCoverage.none')}
            </Button>
          </div>
        </div>
        {stockLengths.length > 0 && (
          <div className="flex flex-col gap-1.5 pb-3">
            <span className="text-xs font-medium text-muted-foreground">
              {t('preflight.nestingCoverage.stockLengths')}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {stockLengths.map((row) => (
                <span
                  key={row.length ?? 'unknown'}
                  className="rounded-md border border-border px-2 py-1 text-xs"
                >
                  <span className="font-medium">
                    {row.length == null
                      ? t('preflight.nestingCoverage.unknownLength')
                      : `${formatNumber(row.length / 1000, 1)} m`}
                  </span>
                  <span className="text-muted-foreground">
                    {' · '}
                    {formatNumber(row.bars, 0)} {t('preflight.nestingCoverage.bars')}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <NestingFileTree
            paths={paths}
            selected={selected}
            primaryFiles={hoveredFiles}
            secondaryFiles={secondaryFiles}
            plannedByFile={plannedByFile}
            cutByFile={cutByFile}
            onToggle={onToggle}
            onHoverFiles={(files) => setHoveredFiles(new Set(files))}
            onCutChange={onCutChange}
          />
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col pl-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('preflight.nestingCoverage.marks')}</h3>
          <Toggle pressed={onlyProblems} onPressedChange={setOnlyProblems}>
            {t('preflight.nestingCoverage.onlyProblems')}
          </Toggle>
        </div>
        <div className="min-h-0 flex-1 overflow-auto pt-3">
          {data.selectedPackages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('preflight.nestingCoverage.selectHint')}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('preflight.nestingCoverage.mark')}</TableHead>
                    <TableHead className="w-px text-right">
                      {t('preflight.nestingCoverage.required')}
                    </TableHead>
                    <TableHead className="w-px text-right">
                      {t('preflight.nestingCoverage.nested')}
                    </TableHead>
                    <TableHead className="w-px text-right">
                      {t('preflight.nestingCoverage.cutQty')}
                    </TableHead>
                    <TableHead className="w-px text-right">
                      {t('preflight.nestingCoverage.diff')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => {
                    const isExpanded = expandedMarks.has(row.mark)
                    const highlighted =
                      hoveredFiles.size > 0 &&
                      row.sources.some((source) => hoveredFiles.has(source.file))
                    return (
                      <Fragment key={row.mark}>
                        <TableRow
                          onMouseEnter={() => setHoveredMark(row.mark)}
                          onMouseLeave={() => setHoveredMark(null)}
                          className={cn('transition-colors', highlighted && SECONDARY_TABLE_ROW)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => toggleMark(row.mark)}
                                aria-expanded={isExpanded}
                                aria-label={
                                  isExpanded
                                    ? t('preflight.nestingCoverage.hideSources', {
                                        mark: row.mark,
                                      })
                                    : t('preflight.nestingCoverage.showSources', {
                                        mark: row.mark,
                                      })
                                }
                                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                              >
                                <span className={isExpanded ? 'rotate-90' : ''}>›</span>
                              </button>
                              <span className="font-mono text-xs">{row.mark}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.required, 0)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.nested, 0)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(row.cut, 0)}
                          </TableCell>
                          <TableCell
                            className={
                              row.diff < 0
                                ? 'text-right font-semibold tabular-nums text-amber-400'
                                : row.diff > 0
                                  ? 'text-right font-semibold tabular-nums text-red-400'
                                  : 'text-right tabular-nums text-muted-foreground'
                            }
                          >
                            {row.diff === 0
                              ? '—'
                              : `${row.diff > 0 ? '+' : ''}${formatNumber(row.diff, 0)}`}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow
                            className="hover:bg-transparent"
                            onMouseEnter={() => setHoveredMark(row.mark)}
                            onMouseLeave={() => setHoveredMark(null)}
                          >
                            <TableCell colSpan={5} className="bg-muted/20 p-0">
                              <div className="flex flex-col gap-1 px-8 py-2 text-xs">
                                <span className="font-medium text-muted-foreground">
                                  {t('preflight.nestingCoverage.sources')}
                                </span>
                                {row.sources.length === 0 ? (
                                  <span className="text-muted-foreground">
                                    {t('preflight.nestingCoverage.noSources')}
                                  </span>
                                ) : (
                                  row.sources.map((source) => (
                                    <div
                                      key={source.file}
                                      className="flex items-center justify-between gap-4"
                                    >
                                      <span
                                        className="min-w-0 truncate font-mono"
                                        title={source.file}
                                      >
                                        {baseName(source.file)}
                                      </span>
                                      <span
                                        className="shrink-0 tabular-nums"
                                        title={t('preflight.nestingCoverage.plannedCut')}
                                      >
                                        {formatNumber(source.quantity, 0)} /{' '}
                                        {formatNumber(source.cut, 0)}
                                      </span>
                                    </div>
                                  ))
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>

              {unmatched.length > 0 && (
                <details className="text-xs text-amber-400">
                  <summary className="cursor-pointer font-medium">
                    {t('preflight.nestingCoverage.unmatched', { count: unmatched.length })}
                  </summary>
                  <div className="mt-1 flex flex-col gap-1">
                    {unmatched.map((row) => (
                      <span key={row.name}>
                        {row.name} ({formatNumber(namesByName.get(row.name)?.nested ?? 0, 0)})
                      </span>
                    ))}
                  </div>
                </details>
              )}
              {missingRows.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium text-muted-foreground">
                    {t('preflight.nestingCoverage.missingList', {
                      count: missingRows.length,
                    })}
                  </summary>
                  <div className="mt-1 flex flex-col gap-1">
                    {missingRows.map((row) => (
                      <div key={row.mark} className="flex flex-wrap items-baseline gap-1.5">
                        <span className="font-mono text-amber-400">{row.mark}</span>
                        {row.candidates.length === 0 ? (
                          <span className="text-muted-foreground">
                            {t('preflight.nestingCoverage.notInNestings')}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {row.candidates
                              .map((candidate) => {
                                const files = namesByName.get(candidate.name)?.files ?? []
                                const where = files.map(baseName).join(', ')
                                return `${candidate.name}${where ? ` (${where})` : ''}`
                              })
                              .join(' · ')}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Nesting coverage for the preflight Parts quantities.
 *
 * The Parts card is the quantity truth; nestings live in the project's JOB file list. The section
 * overview groups the nestings by section, and only an opened section shows the file tree and the
 * marks table, so large jobs are read one section at a time.
 */
export function NestingAnalysis({
  parts,
  rule,
  onRuleChange,
  cuts,
  onCutsChange,
  selection,
  onSelectionChange,
  entries,
}: {
  parts: ProjectPartQuantity[]
  rule: NestNameRule
  onRuleChange: (rule: NestNameRule) => void
  cuts: Record<string, number>
  onCutsChange: (cuts: Record<string, number>) => void
  /** Ticked nesting files; `null` means all of them. */
  selection: string[] | null
  onSelectionChange: (files: string[] | null) => void
  entries: ZipEntry[]
}) {
  const { t } = useTranslation()
  const [openProfile, setOpenProfile] = useState<string | null>(null)
  const [cardOpen, setCardOpen] = useState(true)
  const [ruleOpen, setRuleOpen] = useState(false)
  const [previewQuery, setPreviewQuery] = useState('')
  const [onlyUnmatched, setOnlyUnmatched] = useState(false)

  const rawPackages = useMemo<RawPackage[]>(
    () =>
      entries
        .filter((entry) => NEST_FILE.test(entry.path))
        .map((entry) => {
          const pkg = parseNexPackage(entry.bytes)
          return {
            file: entry.path,
            package: pkg,
            rawProfile: nestProfile(entry.path, pkg),
          }
        })
        // Only per-beam nestings: the project snapshot has one Result per layout.
        .filter((pkg) => isMachineNesting(pkg.package))
        .sort((a, b) => a.file.localeCompare(b.file)),
    [entries],
  )
  /**
   * Section keys each nesting actually covers, resolved through the project marks. This is what
   * lets an Unknown package (`NW30 TOP.ncexa`, `新建文件夹/…`) join the section it nests instead
   * of showing as Unknown.
   */
  const packageSections = useMemo(() => {
    const keyByMark = new Map(parts.map((part) => [part.mark, profileKey(part.profile)]))
    const marks = parts.map((part) => part.mark)
    const map = new Map<string, Map<string, number>>()
    for (const pkg of rawPackages) {
      const counts = new Map<string, number>()
      for (const row of matchNestNames(nestedPartNames(pkg.package), marks, rule).rows) {
        if (!row.matched || !row.projectMark) continue
        const key = keyByMark.get(row.projectMark)
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      map.set(pkg.file, counts)
    }
    return map
  }, [rawPackages, parts, rule])
  /** Section key -> the folder label of a known section that nests it (`RHS 150x100 T9`). */
  const labelByKey = useMemo(() => {
    const labels = new Map<string, string>()
    for (const pkg of rawPackages) {
      if (pkg.rawProfile === UNKNOWN_PROFILE || pkg.rawProfile === MIXED_PROFILE) continue
      const key = dominantKey(packageSections.get(pkg.file))
      if (key && !labels.has(key)) labels.set(key, pkg.rawProfile)
    }
    return labels
  }, [rawPackages, packageSections])
  /** Fallback label (the parts-table section) when no folder names the section. */
  const sectionLabelByKey = useMemo(() => {
    const labels = new Map<string, string>()
    for (const part of parts) {
      if (!part.profile || part.profile === '—') continue
      const key = profileKey(part.profile)
      if (!labels.has(key)) labels.set(key, part.profile)
    }
    return labels
  }, [parts])
  const packages = useMemo<LoadedPackage[]>(
    () =>
      rawPackages.map((pkg) => {
        const key = dominantKey(packageSections.get(pkg.file))
        // Always prefer the real section label the parts carry (`RHS150*100*9.0`,
        // `200UB29.8`); the folder label is only a fallback when the parts name no section.
        const profile = key
          ? (sectionLabelByKey.get(key) ?? labelByKey.get(key) ?? pkg.rawProfile)
          : (matchSectionLabel(pkg.rawProfile, sectionLabelByKey) ?? pkg.rawProfile)
        return { file: pkg.file, package: pkg.package, profile }
      }),
    [rawPackages, packageSections, labelByKey, sectionLabelByKey],
  )
  const paths = useMemo(() => packages.map((pkg) => pkg.file), [packages])
  const profiles = useMemo(() => {
    const counts = new Map<string, number>()
    for (const pkg of packages) counts.set(pkg.profile, (counts.get(pkg.profile) ?? 0) + 1)
    return [...counts]
      .map(([profile, count]) => ({ profile, count }))
      .sort((a, b) => a.profile.localeCompare(b.profile, undefined, { numeric: true }))
  }, [packages])
  const pathSet = useMemo(() => new Set(paths), [paths])
  const selected = useMemo(
    () => (selection ? new Set(selection.filter((path) => pathSet.has(path))) : new Set(paths)),
    [selection, paths, pathSet],
  )
  const plannedByFile = useMemo(
    () =>
      new Map(
        packages.map((pkg) => [
          pkg.file,
          pkg.package.results.reduce((total, result) => total + result.copies, 0),
        ]),
      ),
    [packages],
  )
  const cutByFile = useMemo(
    () => new Map(paths.map((path) => [path, cuts[path] ?? plannedByFile.get(path) ?? 0])),
    [paths, cuts, plannedByFile],
  )

  /**
   * One entry per section. The nesting folder label is not reliable (NW30's `PFC 150` holds
   * PFC100*50 nests), so the section's parts are attributed by the marks its nestings actually
   * match, then every part of those sections is included — that keeps the section's missing marks
   * in the table.
   */
  const sections = useMemo<SectionData[]>(() => {
    return profiles.map(({ profile }) => {
      const sectionPackages = packages.filter((pkg) => pkg.profile === profile)
      const selectedPackages = sectionPackages.filter((pkg) => selected.has(pkg.file))
      const summary = summarizeNests(selectedPackages, cutByFile)
      // Attribute the section's parts from every file in it, so deselecting a file does not
      // change which marks the section covers (only their nested/cut quantities).
      const sectionSummary = summarizeNests(sectionPackages)
      const base = matchNestNames(
        sectionSummary.names.map((row) => row.name),
        parts.map((part) => part.mark),
        rule,
      )
      const covered = new Set(base.rows.filter((row) => row.matched).map((row) => row.projectMark))
      const keys = new Set<string>([profileKey(profile)])
      for (const part of parts) if (covered.has(part.mark)) keys.add(profileKey(part.profile))
      const sectionParts = parts.filter(
        (part) => covered.has(part.mark) || keys.has(profileKey(part.profile)),
      )
      const matcher = matchNestNames(
        summary.names.map((row) => row.name),
        sectionParts.map((part) => part.mark),
        rule,
      )
      const coverage = buildCoverage(sectionParts, matcher, summary)
      return {
        profile,
        packages: sectionPackages,
        selectedPackages,
        summary,
        parts: sectionParts,
        matcher,
        coverage,
        abnormalities: coverage.reduce((total, row) => total + Math.abs(row.diff), 0),
      }
    })
  }, [profiles, packages, parts, selected, cutByFile, rule])

  const openSection = openProfile
    ? (sections.find((section) => section.profile === openProfile) ?? null)
    : null
  const openIndex = openSection
    ? sections.findIndex((section) => section.profile === openSection.profile)
    : -1
  const stepSection = (offset: number) => {
    const next = sections[openIndex + offset]
    if (next) setOpenProfile(next.profile)
  }

  // The name rule is global; its preview shows every selected nesting name against every part.
  const allSelectedPackages = useMemo(
    () => packages.filter((pkg) => selected.has(pkg.file)),
    [packages, selected],
  )
  const allSummary = useMemo(
    () => summarizeNests(allSelectedPackages, cutByFile),
    [allSelectedPackages, cutByFile],
  )
  const allMatcher = useMemo(
    () =>
      matchNestNames(
        allSummary.names.map((row) => row.name),
        parts.map((part) => part.mark),
        rule,
      ),
    [allSummary.names, parts, rule],
  )
  const allNamesByName = useMemo(
    () => new Map(allSummary.names.map((row) => [row.name, row])),
    [allSummary.names],
  )
  const previewRows = useMemo(() => {
    const query = previewQuery.trim().toLowerCase()
    return allMatcher.rows.filter((row) => {
      if (onlyUnmatched && row.matched) return false
      if (!query) return true
      return (
        row.name.toLowerCase().includes(query) ||
        (row.key ?? '').toLowerCase().includes(query) ||
        (row.projectMark ?? '').toLowerCase().includes(query)
      )
    })
  }, [allMatcher.rows, previewQuery, onlyUnmatched])

  const toggle = (pathsToToggle: string[], allSelected: boolean) => {
    const next = new Set(selected)
    for (const path of pathsToToggle) {
      if (allSelected) next.delete(path)
      else next.add(path)
    }
    onSelectionChange(next.size === paths.length ? null : [...next])
  }
  const changeFileCut = (file: string, value: number) => {
    onCutsChange({ ...cuts, [file]: value })
  }

  return (
    <section>
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <button
            type="button"
            onClick={() => setCardOpen((current) => !current)}
            aria-expanded={cardOpen}
            className="flex min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform',
                cardOpen && 'rotate-90',
              )}
            />
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold">
                {t('preflight.nestingCoverage.title')}
              </span>
              {packages.length > 0 && (
                <span className="text-sm font-normal text-muted-foreground">
                  {t('preflight.nestingCoverage.selected', {
                    selected: allSelectedPackages.length,
                    total: packages.length,
                  })}
                </span>
              )}
            </CardTitle>
          </button>
          <Button variant="outline" size="sm" onClick={() => setRuleOpen(true)}>
            <Settings2 className="size-3.5" />
            {t('preflight.nestingCoverage.rule')}
          </Button>
        </CardHeader>
        {cardOpen && (
          <CardContent className="flex flex-col gap-3">
            {packages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('preflight.nestingCoverage.empty')}
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {t('preflight.nestingCoverage.sectionsHint')}
                </p>
                <SectionOverview
                  sections={sections}
                  openProfile={openProfile}
                  onToggle={(profile) =>
                    setOpenProfile((current) => (current === profile ? null : profile))
                  }
                />
              </>
            )}
          </CardContent>
        )}
      </Card>

      <Dialog
        open={ruleOpen}
        onClose={() => setRuleOpen(false)}
        title={t('preflight.nestingCoverage.rule')}
        className="max-w-3xl"
      >
        <div className="flex flex-col gap-3 p-5">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('preflight.nestingCoverage.clean')}
              <input
                value={rule.clean}
                onChange={(event) => onRuleChange({ ...rule, clean: event.target.value })}
                spellCheck={false}
                className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('preflight.nestingCoverage.extract')}
              <input
                value={rule.extract}
                onChange={(event) => onRuleChange({ ...rule, extract: event.target.value })}
                spellCheck={false}
                className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t('preflight.nestingCoverage.ruleHint')}</p>
          {allMatcher.error && <p className="text-xs text-red-400">{allMatcher.error}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium">{t('preflight.nestingCoverage.preview')}</span>
            <input
              value={previewQuery}
              onChange={(event) => setPreviewQuery(event.target.value)}
              placeholder={t('preflight.nestingCoverage.filterPlaceholder')}
              className="h-8 min-w-48 flex-1 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Toggle pressed={onlyUnmatched} onPressedChange={setOnlyUnmatched}>
              {t('preflight.nestingCoverage.onlyUnmatched')}
            </Toggle>
            <span className="text-xs text-muted-foreground">
              {previewRows.length}/{allMatcher.rows.length}
            </span>
          </div>

          <Table containerClassName="max-h-[45vh] overflow-auto">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('preflight.nestingCoverage.asWritten')}</TableHead>
                <TableHead>{t('preflight.nestingCoverage.keyColumn')}</TableHead>
                <TableHead>{t('preflight.nestingCoverage.matchColumn')}</TableHead>
                <TableHead className="w-px text-right">
                  {t('preflight.nestingCoverage.quantity')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {previewRows.map((row) => (
                <TableRow key={row.name}>
                  <TableCell className="font-mono text-xs">{row.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.key ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.matched ? (
                      <span className="text-emerald-400">{row.projectMark}</span>
                    ) : (
                      <span className="text-amber-400">
                        {t('preflight.nestingCoverage.noMatch')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(allNamesByName.get(row.name)?.nested ?? 0, 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {previewRows.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t('preflight.nestingCoverage.previewEmpty')}
            </p>
          )}
        </div>
      </Dialog>

      <Dialog
        open={openSection !== null}
        onClose={() => setOpenProfile(null)}
        fullscreen
        title={
          openSection ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {openSection.profile}
              </span>
              <span className="text-xs font-normal text-muted-foreground">
                {t('preflight.nestingCoverage.selected', {
                  selected: openSection.selectedPackages.length,
                  total: openSection.packages.length,
                })}
              </span>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={openIndex <= 0}
                  onClick={() => stepSection(-1)}
                  aria-label={t('preflight.nestingCoverage.prevSection')}
                  title={t('preflight.nestingCoverage.prevSection')}
                >
                  <ChevronLeft />
                </Button>
                <span
                  className="w-16 whitespace-nowrap text-center text-xs font-normal tabular-nums text-muted-foreground"
                  aria-live="polite"
                >
                  {openIndex + 1} / {sections.length}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={openIndex >= sections.length - 1}
                  onClick={() => stepSection(1)}
                  aria-label={t('preflight.nestingCoverage.nextSection')}
                  title={t('preflight.nestingCoverage.nextSection')}
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          ) : undefined
        }
      >
        {openSection && (
          <div className="h-full min-h-0 p-4">
            <SectionView
              key={openSection.profile}
              data={openSection}
              selected={selected}
              plannedByFile={plannedByFile}
              cutByFile={cutByFile}
              onToggle={toggle}
              onCutChange={changeFileCut}
            />
          </div>
        )}
      </Dialog>
    </section>
  )
}
