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
import { cn } from '@/lib/utils'
import { type NcexPackage, parseNexPackage } from '@/lib/wisecam/ncexParse'
import { matchNestNames, type NestNameRule } from '@/lib/wisecam/nestNameRule'
import { nestProfile } from '@/lib/wisecam/nestProfile'
import { summarizeNests } from '@/lib/wisecam/nestSummary'
import type { ZipEntry } from '@/lib/zip'
import { NestingFileTree } from './NestingFileTree'

const SECONDARY_TABLE_ROW = 'bg-violet-500/25 ring-1 ring-inset ring-violet-300/70'
const EMPTY: Set<string> = new Set()

export interface ProjectPartQuantity {
  mark: string
  required: number
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

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function looseKey(value: string): string {
  return value.toLowerCase().replace(/[\s_/,.-]+/g, '')
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{formatNumber(value, 0)}</div>
    </div>
  )
}

/**
 * Nesting coverage for the preflight Parts quantities.
 *
 * The Parts card is the quantity truth; nestings live in the project's JOB file list. Files are
 * cherry-picked in the tree, and only the ticked ones contribute to the coverage and preview.
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
  const [hoveredFiles, setHoveredFiles] = useState<Set<string>>(new Set())
  const [hoveredMark, setHoveredMark] = useState<string | null>(null)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [previewQuery, setPreviewQuery] = useState('')
  const [onlyUnmatched, setOnlyUnmatched] = useState(false)
  const [profileFilter, setProfileFilter] = useState('all')

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
  const activeProfile = profiles.some((entry) => entry.profile === profileFilter)
    ? profileFilter
    : 'all'
  const visiblePaths = useMemo(
    () =>
      activeProfile === 'all'
        ? paths
        : packages.filter((pkg) => pkg.profile === activeProfile).map((pkg) => pkg.file),
    [activeProfile, packages, paths],
  )
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

  const selectedPackages = useMemo(
    () => packages.filter((pkg) => selected.has(pkg.file)),
    [packages, selected],
  )
  const summary = useMemo(
    () => summarizeNests(selectedPackages, cutByFile),
    [selectedPackages, cutByFile],
  )
  const matcher = useMemo(
    () =>
      matchNestNames(
        summary.names.map((row) => row.name),
        parts.map((part) => part.mark),
        rule,
      ),
    [summary.names, parts, rule],
  )
  const namesByName = useMemo(
    () => new Map(summary.names.map((row) => [row.name, row])),
    [summary.names],
  )
  const previewRows = useMemo(() => {
    const query = previewQuery.trim().toLowerCase()
    return matcher.rows.filter((row) => {
      if (onlyUnmatched && row.matched) return false
      if (!query) return true
      return (
        row.name.toLowerCase().includes(query) ||
        (row.key ?? '').toLowerCase().includes(query) ||
        (row.projectMark ?? '').toLowerCase().includes(query)
      )
    })
  }, [matcher.rows, previewQuery, onlyUnmatched])

  const coverage = useMemo(() => {
    const rows: CoverageRow[] = parts.map((part) => {
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
  }, [parts, matcher.rows, namesByName])

  const unmatched = matcher.rows.filter((row) => !row.matched)
  const missingRows = matcher.missingProjectMarks.map((mark) => {
    const key = looseKey(mark)
    return {
      mark,
      candidates: unmatched.filter((row) => looseKey(row.name).includes(key)),
    }
  })
  const hoveredRow = hoveredMark ? coverage.find((row) => row.mark === hoveredMark) : undefined
  const secondaryFiles = hoveredRow
    ? new Set(hoveredRow.sources.map((source) => source.file))
    : EMPTY
  const visible = onlyProblems ? coverage.filter((row) => row.diff !== 0) : coverage
  const diffMarks = coverage.filter((row) => row.diff !== 0).length

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
  const toggleExpanded = (mark: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(mark)) next.delete(mark)
      else next.add(mark)
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
            selected: selectedPackages.length,
            total: packages.length,
          })}
        </span>
      </div>
      {packages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('preflight.nestingCoverage.empty')}</p>
      ) : (
        <div className="flex h-dvh flex-row items-stretch gap-4">
          <Card className="flex h-full min-h-0 w-2/5 min-w-[12rem] shrink-0 flex-col">
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
              <CardTitle>{t('preflight.nestingCoverage.files')}</CardTitle>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSelection((current) => {
                      const next = new Set(current ?? paths)
                      for (const path of visiblePaths) next.add(path)
                      return next
                    })
                  }
                >
                  {t('preflight.nestingCoverage.all')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSelection((current) => {
                      const next = new Set(current ?? paths)
                      for (const path of visiblePaths) next.delete(path)
                      return next
                    })
                  }
                >
                  {t('preflight.nestingCoverage.none')}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              <select
                value={activeProfile}
                onChange={(event) => setProfileFilter(event.target.value)}
                aria-label={t('preflight.nestingCoverage.profileFilter')}
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">
                  {t('preflight.nestingCoverage.allProfiles', { count: profiles.length })}
                </option>
                {profiles.map((entry) => (
                  <option key={entry.profile} value={entry.profile}>
                    {entry.profile} ({entry.count})
                  </option>
                ))}
              </select>
              <div className="min-h-0 flex-1 overflow-auto">
                <NestingFileTree
                  paths={visiblePaths}
                  selected={selected}
                  primaryFiles={hoveredFiles}
                  secondaryFiles={secondaryFiles}
                  plannedByFile={plannedByFile}
                  cutByFile={cutByFile}
                  onToggle={toggle}
                  onHoverFiles={(files) => setHoveredFiles(new Set(files))}
                  onCutChange={changeFileCut}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
            <CardHeader>
              <CardTitle>{t('preflight.nestingCoverage.marks')}</CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto">
              {selectedPackages.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('preflight.nestingCoverage.selectHint')}
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <Stat
                      label={t('preflight.nestingCoverage.files')}
                      value={selectedPackages.length}
                    />
                    <Stat
                      label={t('preflight.nestingCoverage.pieces')}
                      value={summary.totals.pieces}
                    />
                    <Stat
                      label={t('preflight.nestingCoverage.cutPieces')}
                      value={summary.totals.cutPieces}
                    />
                    <Stat label={t('preflight.nestingCoverage.matched')} value={matcher.matched} />
                    <Stat label={t('preflight.nestingCoverage.diffMarks')} value={diffMarks} />
                  </div>

                  <details className="rounded-lg border border-border px-3 py-2">
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
                          onChange={(event) =>
                            onRuleChange({ ...rule, extract: event.target.value })
                          }
                          spellCheck={false}
                          className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </label>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('preflight.nestingCoverage.ruleHint')}
                    </p>
                    {matcher.error && <p className="mt-1 text-xs text-red-400">{matcher.error}</p>}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium">
                        {t('preflight.nestingCoverage.preview')}
                      </span>
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
                        {previewRows.length}/{matcher.rows.length}
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
                              {formatNumber(namesByName.get(row.name)?.nested ?? 0, 0)}
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
                        const isExpanded = expanded.has(row.mark)
                        const highlighted =
                          hoveredFiles.size > 0 &&
                          row.sources.some((source) => hoveredFiles.has(source.file))
                        return (
                          <Fragment key={row.mark}>
                            <TableRow
                              onMouseEnter={() => setHoveredMark(row.mark)}
                              onMouseLeave={() => setHoveredMark(null)}
                              className={cn(
                                'transition-colors',
                                highlighted && SECONDARY_TABLE_ROW,
                              )}
                            >
                              <TableCell>
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => toggleExpanded(row.mark)}
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
      )}
    </section>
  )
}
