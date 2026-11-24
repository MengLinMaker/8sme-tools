import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { profileKey } from '@/lib/sections/fromFilename'
import { cn } from '@/lib/utils'
import { type NcexPackage, parseNexPackage } from '@/lib/wisecam/ncexParse'
import {
  matchNestNames,
  type NestNameMatchSummary,
  type NestNameRule,
} from '@/lib/wisecam/nestNameRule'
import { nestProfile } from '@/lib/wisecam/nestProfile'
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
  diffMarks: number
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function looseKey(value: string): string {
  return value.toLowerCase().replace(/[\s_/,.-]+/g, '')
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-32 rounded-lg border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{formatNumber(value, 0)}</div>
    </div>
  )
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
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>{t('preflight.nestingCoverage.sections')}</CardTitle>
        <span className="text-xs text-muted-foreground">
          {t('preflight.nestingCoverage.sectionsHint')}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('preflight.nestingCoverage.section')}</TableHead>
              <TableHead className="w-px text-right">
                {t('preflight.nestingCoverage.files')}
              </TableHead>
              <TableHead className="w-px text-right">
                {t('preflight.nestingCoverage.pieces')}
              </TableHead>
              <TableHead className="w-px text-right">
                {t('preflight.nestingCoverage.cutPieces')}
              </TableHead>
              <TableHead className="w-px text-right">
                {t('preflight.nestingCoverage.marks')}
              </TableHead>
              <TableHead className="w-px text-right">
                {t('preflight.nestingCoverage.diffMarks')}
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
                      section.diffMarks > 0 ? 'text-amber-400' : 'text-muted-foreground',
                    )}
                  >
                    {formatNumber(section.diffMarks, 0)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
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

  const toggleMark = (mark: string) => {
    setExpandedMarks((current) => {
      const next = new Set(current)
      if (next.has(mark)) next.delete(mark)
      else next.add(mark)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">{data.profile}</h3>
        <span className="text-xs text-muted-foreground">
          {t('preflight.nestingCoverage.selected', {
            selected: data.selectedPackages.length,
            total: data.packages.length,
          })}
        </span>
      </div>
      <div className="flex h-dvh flex-row items-stretch">
        <Card className="flex h-full min-h-0 w-2/5 min-w-[12rem] shrink-0 flex-col rounded-r-none border-r-0">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
            <CardTitle>{t('preflight.nestingCoverage.files')}</CardTitle>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => onToggle(paths, false)}>
                {t('preflight.nestingCoverage.all')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onToggle(paths, true)}>
                {t('preflight.nestingCoverage.none')}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden pr-3">
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
          </CardContent>
        </Card>

        <Card className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-l-none border-l-0">
          <CardHeader>
            <CardTitle>{t('preflight.nestingCoverage.marks')}</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto pl-3">
            {data.selectedPackages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('preflight.nestingCoverage.selectHint')}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Stat
                    label={t('preflight.nestingCoverage.files')}
                    value={data.selectedPackages.length}
                  />
                  <Stat
                    label={t('preflight.nestingCoverage.pieces')}
                    value={data.summary.totals.pieces}
                  />
                  <Stat
                    label={t('preflight.nestingCoverage.cutPieces')}
                    value={data.summary.totals.cutPieces}
                  />
                  <Stat
                    label={t('preflight.nestingCoverage.matched')}
                    value={data.matcher.matched}
                  />
                  <Stat label={t('preflight.nestingCoverage.diffMarks')} value={data.diffMarks} />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {t('preflight.nestingCoverage.hint')}
                  </p>
                  <Toggle pressed={onlyProblems} onPressedChange={setOnlyProblems}>
                    {t('preflight.nestingCoverage.onlyProblems')}
                  </Toggle>
                </div>

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
          </CardContent>
        </Card>
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
  entries,
}: {
  parts: ProjectPartQuantity[]
  rule: NestNameRule
  onRuleChange: (rule: NestNameRule) => void
  cuts: Record<string, number>
  onCutsChange: (cuts: Record<string, number>) => void
  entries: ZipEntry[]
}) {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<Set<string> | null>(null)
  const [openProfile, setOpenProfile] = useState<string | null>(null)
  const [previewQuery, setPreviewQuery] = useState('')
  const [onlyUnmatched, setOnlyUnmatched] = useState(false)

  const packages = useMemo<LoadedPackage[]>(
    () =>
      entries
        .filter((entry) => NEST_FILE.test(entry.path))
        .map((entry) => {
          const pkg = parseNexPackage(entry.bytes)
          return {
            file: entry.path,
            package: pkg,
            profile: nestProfile(entry.path, pkg),
          }
        })
        .sort((a, b) => a.file.localeCompare(b.file)),
    [entries],
  )
  const paths = useMemo(() => packages.map((pkg) => pkg.file), [packages])
  const profiles = useMemo(() => {
    const counts = new Map<string, number>()
    for (const pkg of packages) counts.set(pkg.profile, (counts.get(pkg.profile) ?? 0) + 1)
    return [...counts]
      .map(([profile, count]) => ({ profile, count }))
      .sort((a, b) => a.profile.localeCompare(b.profile, undefined, { numeric: true }))
  }, [packages])
  const selected = useMemo(() => selection ?? new Set(paths), [selection, paths])
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
        diffMarks: coverage.filter((row) => row.diff !== 0).length,
      }
    })
  }, [profiles, packages, parts, selected, cutByFile, rule])

  const openSection = openProfile
    ? (sections.find((section) => section.profile === openProfile) ?? null)
    : null

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
    setSelection((current) => {
      const next = new Set(current ?? paths)
      for (const path of pathsToToggle) {
        if (allSelected) next.delete(path)
        else next.add(path)
      }
      return next
    })
  }
  const changeFileCut = (file: string, value: number) => {
    onCutsChange({ ...cuts, [file]: value })
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{t('preflight.nestingCoverage.title')}</h2>
        <span className="text-sm font-normal text-muted-foreground">
          {t('preflight.nestingCoverage.selected', {
            selected: allSelectedPackages.length,
            total: packages.length,
          })}
        </span>
      </div>
      {packages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('preflight.nestingCoverage.empty')}</p>
      ) : (
        <>
          <details className="max-w-3xl rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              {t('preflight.nestingCoverage.rule')}
            </summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
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
            <p className="mt-2 text-xs text-muted-foreground">
              {t('preflight.nestingCoverage.ruleHint')}
            </p>
            {allMatcher.error && <p className="mt-1 text-xs text-red-400">{allMatcher.error}</p>}

            <div className="mt-3 flex flex-wrap items-center gap-2">
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

            <Table containerClassName="mt-2 max-h-[35vh] overflow-auto">
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
              <p className="mt-1 text-xs text-muted-foreground">
                {t('preflight.nestingCoverage.previewEmpty')}
              </p>
            )}
          </details>

          <SectionOverview
            sections={sections}
            openProfile={openProfile}
            onToggle={(profile) =>
              setOpenProfile((current) => (current === profile ? null : profile))
            }
          />

          {openSection && (
            <SectionView
              key={openSection.profile}
              data={openSection}
              selected={selected}
              plannedByFile={plannedByFile}
              cutByFile={cutByFile}
              onToggle={toggle}
              onCutChange={changeFileCut}
            />
          )}
        </>
      )}
    </section>
  )
}
