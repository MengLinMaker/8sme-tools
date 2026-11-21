import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropZone } from '@/components/DropZone'
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
import type { InputBundle } from '@/lib/readInput'
import { yieldToMain } from '@/lib/scheduler'
import { type NcexPackage, parseNexPackage } from '@/lib/wisecam/ncexParse'
import { matchNestNames, type NestNameRule } from '@/lib/wisecam/nestNameRule'
import { summarizeNests } from '@/lib/wisecam/nestSummary'

export interface ProjectPartQuantity {
  mark: string
  required: number
}

interface LoadedPackage {
  file: string
  package: NcexPackage
}

interface CoverageRow {
  mark: string
  required: number
  nested: number
  missing: number
  over: number
  sources: { file: string; quantity: number }[]
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
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
 * The Parts card is the quantity truth; this panel extracts `Part.Name` from dropped `.ncexa`
 * files with the editable rule and compares the matched totals. Files are held in memory only —
 * they never enter the project store.
 */
export function NestingAnalysis({
  parts,
  rule,
  onRuleChange,
}: {
  parts: ProjectPartQuantity[]
  rule: NestNameRule
  onRuleChange: (rule: NestNameRule) => void
}) {
  const { t } = useTranslation()
  const [packages, setPackages] = useState<LoadedPackage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const ingest = async (bundle: InputBundle) => {
    const entries = bundle.entries.filter((entry) => NEST_FILE.test(entry.path))
    if (entries.length === 0) {
      setError(t('nest.empty'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const loaded: LoadedPackage[] = []
      for (const entry of entries) {
        loaded.push({ file: entry.path, package: parseNexPackage(entry.bytes) })
        await yieldToMain()
      }
      setPackages((current) => {
        const byPath = new Map(current.map((pkg) => [pkg.file, pkg]))
        for (const pkg of loaded) byPath.set(pkg.file, pkg)
        return [...byPath.values()].sort((a, b) => a.file.localeCompare(b.file))
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const summary = useMemo(() => summarizeNests(packages), [packages])
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
  const coverage = useMemo(() => {
    const rows: CoverageRow[] = parts.map((part) => {
      const matched = matcher.rows.filter((row) => row.matched && row.projectMark === part.mark)
      let nested = 0
      const sources = new Map<string, number>()
      for (const match of matched) {
        const name = namesByName.get(match.name)
        if (!name) continue
        nested += name.nested
        for (const source of name.sources) {
          sources.set(source.file, (sources.get(source.file) ?? 0) + source.quantity)
        }
      }
      const required = Math.max(0, part.required)
      return {
        mark: part.mark,
        required,
        nested,
        missing: Math.max(0, required - nested),
        over: Math.max(0, nested - required),
        sources: [...sources]
          .map(([file, quantity]) => ({ file, quantity }))
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
  const visible = onlyProblems
    ? coverage.filter((row) => row.missing > 0 || row.over > 0)
    : coverage
  const missingMarks = coverage.filter((row) => row.missing > 0).length
  const overMarks = coverage.filter((row) => row.over > 0).length
  const toggleExpanded = (mark: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(mark)) next.delete(mark)
      else next.add(mark)
      return next
    })
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{t('preflight.nestingCoverage.title')}</CardTitle>
          <span className="text-sm font-normal text-muted-foreground">({packages.length})</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setPackages([])
            setExpanded(new Set())
            setError(null)
          }}
        >
          {t('nest.clear')}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <DropZone
          compact
          title={t('preflight.nestingCoverage.dropTitle')}
          onBundle={(bundle) => void ingest(bundle)}
          onError={setError}
          accept=".ncexa,.ncex"
          chooseLabel={t('nest.chooseFiles')}
        />
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('nest.reading')}
          </p>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}

        {packages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('preflight.nestingCoverage.empty')}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label={t('preflight.nestingCoverage.files')} value={packages.length} />
              <Stat label={t('preflight.nestingCoverage.pieces')} value={summary.totals.pieces} />
              <Stat label={t('preflight.nestingCoverage.matched')} value={matcher.matched} />
              <Stat label={t('preflight.nestingCoverage.missing')} value={missingMarks} />
              <Stat label={t('preflight.nestingCoverage.over')} value={overMarks} />
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
                    onChange={(event) => onRuleChange({ ...rule, extract: event.target.value })}
                    spellCheck={false}
                    className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {t('preflight.nestingCoverage.ruleHint')}
              </p>
              {matcher.error && <p className="mt-1 text-xs text-red-400">{matcher.error}</p>}
            </details>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{t('preflight.nestingCoverage.hint')}</p>
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
                    {t('preflight.nestingCoverage.missingQty')}
                  </TableHead>
                  <TableHead className="w-px text-right">
                    {t('preflight.nestingCoverage.overQty')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => {
                  const isExpanded = expanded.has(row.mark)
                  return (
                    <Fragment key={row.mark}>
                      <TableRow>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => toggleExpanded(row.mark)}
                              aria-expanded={isExpanded}
                              aria-label={
                                isExpanded
                                  ? t('preflight.nestingCoverage.hideSources', { mark: row.mark })
                                  : t('preflight.nestingCoverage.showSources', { mark: row.mark })
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
                        <TableCell
                          className={
                            row.missing > 0
                              ? 'text-right font-semibold tabular-nums text-amber-400'
                              : 'text-right tabular-nums text-muted-foreground'
                          }
                        >
                          {row.missing > 0 ? formatNumber(row.missing, 0) : '—'}
                        </TableCell>
                        <TableCell
                          className={
                            row.over > 0
                              ? 'text-right font-semibold tabular-nums text-red-400'
                              : 'text-right tabular-nums text-muted-foreground'
                          }
                        >
                          {row.over > 0 ? `+${formatNumber(row.over, 0)}` : '—'}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow className="hover:bg-transparent">
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
                                    <span className="shrink-0 tabular-nums">
                                      {formatNumber(source.quantity, 0)}
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
              <div className="flex flex-col gap-1 text-xs text-amber-400">
                <span className="font-medium">
                  {t('preflight.nestingCoverage.unmatched', { count: unmatched.length })}
                </span>
                {unmatched.map((row) => (
                  <span key={row.name}>
                    {row.name} ({formatNumber(namesByName.get(row.name)?.nested ?? 0, 0)})
                  </span>
                ))}
              </div>
            )}
            {matcher.ambiguous.length > 0 && (
              <div className="flex flex-col gap-1 text-xs text-amber-400">
                <span className="font-medium">
                  {t('preflight.nestingCoverage.ambiguous', { count: matcher.ambiguous.length })}
                </span>
                {matcher.ambiguous.map((row) => (
                  <span key={row.key}>
                    {row.key}: {row.names.join(' · ')}
                  </span>
                ))}
              </div>
            )}
            {matcher.missingProjectMarks.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('preflight.nestingCoverage.missingMarks', {
                  count: matcher.missingProjectMarks.length,
                })}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
