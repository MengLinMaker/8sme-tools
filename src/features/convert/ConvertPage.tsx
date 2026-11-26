import type { TFunction } from 'i18next'
import {
  AlertCircle,
  CircleCheck,
  Download,
  Eraser,
  FileCog,
  Info,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropZone } from '@/components/DropZone'
import { Badge } from '@/components/ui/badge'
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
import type { SatAnalysis } from '@/lib/convert/sat'
import { analyzeSat } from '@/lib/convert/sat'
import { downloadBlob, fileStem } from '@/lib/download'
import { formatBytes, formatNumber } from '@/lib/format'
import type { InputBundle } from '@/lib/readInput'
import { getStepWorkerPool, PRIORITY_FOREGROUND } from '@/lib/step/stepPool'
import type { SatConvertResult } from '@/lib/step/stepWorkerProtocol'
import { cn } from '@/lib/utils'
import { SatSectionView } from './SatSectionView'

type ConvertFormat = 'sat' | 'sab' | 'step' | 'iges' | 'brep' | 'other'
type JobStatus = 'ready' | 'converting' | 'done' | 'error'

interface ConvertJob {
  id: string
  path: string
  format: ConvertFormat
  bytes: Uint8Array
  /** SAT text (only for text SAT; SAB is binary and is refused). */
  text?: string
  analysis?: SatAnalysis
  status: JobStatus
  result?: SatConvertResult
  /** A short failure/status note for formats that have no full analysis. */
  note?: string
  /** The cleaned STEP bytes for a STEP input. */
  cleaned?: Uint8Array
  cleanedSummary?: { kept: number; removed: number; opened: number }
  /** STEP text produced by an IGES translation. */
  output?: string
  igesRoots?: number
}

type IssueSeverity = 'error' | 'warning' | 'info' | 'success'
type IssueAction = 'convertSat' | 'cleanStep' | 'convertIges'

interface ConvertIssue {
  key: string
  /** Short pill text for the table's Issues column. */
  label: string
  severity: IssueSeverity
  message: string
  action?: IssueAction
  actionLabel?: string
}

const FORMAT_LABEL: Record<ConvertFormat, string> = {
  sat: 'SAT',
  sab: 'SAB',
  step: 'STEP',
  iges: 'IGES',
  brep: 'BREP',
  other: 'FILE',
}

const SEVERITY_VARIANT = {
  error: 'destructive',
  warning: 'warning',
  info: 'info',
  success: 'success',
} as const

const SEVERITY_ICON = {
  error: AlertCircle,
  warning: TriangleAlert,
  info: Info,
  success: CircleCheck,
} as const

/** Problems first, then the resolution, then notes. Stable within a severity. */
function sortIssues(issues: ConvertIssue[]): ConvertIssue[] {
  const order: Record<IssueSeverity, number> = { error: 0, warning: 1, success: 2, info: 3 }
  return [...issues].sort((a, b) => order[a.severity] - order[b.severity])
}

function formatOf(path: string): ConvertFormat {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  if (ext === 'sat') return 'sat'
  if (ext === 'sab') return 'sab'
  if (ext === 'stp' || ext === 'step') return 'step'
  if (ext === 'igs' || ext === 'iges') return 'iges'
  if (ext === 'brep') return 'brep'
  return 'other'
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

/** The section and length the table keeps — everything else lives in the issues/result. */
function sectionLabel(job: ConvertJob, t: TFunction): string {
  if (job.format !== 'sat') return '—'
  return job.analysis?.guess?.code ?? (job.analysis ? t('convert.sat.noMatch') : '—')
}

function lengthLabel(job: ConvertJob): string {
  if (job.format !== 'sat' || !job.analysis) return '—'
  return `${formatNumber(job.analysis.length, 1)} mm`
}

/**
 * Converter tab.
 *
 * The SAT path is a diagnosis, not a blind conversion: WiseCAM cannot import SAT, and a modeller
 * often splits a 90° fillet into two 45° faces, so a straight translation would still read as a
 * custom section. The tab shows the section and length in a file table, lists the issues it found,
 * and offers the rebuild as the fix — the same shape as preflight's findings and one-click fixes.
 */
export function ConvertPage() {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<ConvertJob[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? jobs[0] ?? null,
    [jobs, selectedId],
  )
  const pendingSats = useMemo(
    () =>
      jobs.filter(
        (job) =>
          job.format === 'sat' &&
          job.text &&
          job.analysis?.plan &&
          (job.status === 'ready' || job.status === 'error'),
      ),
    [jobs],
  )

  const onBundle = useCallback(
    (bundle: InputBundle) => {
      setError(null)
      const next: ConvertJob[] = bundle.entries.map((entry) => {
        const format = formatOf(entry.path)
        const id = `${entry.path}:${entry.bytes.length}`
        if (format === 'sat') {
          const text = new TextDecoder().decode(entry.bytes)
          try {
            const analysis = analyzeSat(text)
            return {
              id,
              path: entry.path,
              format,
              bytes: entry.bytes,
              text,
              analysis,
              status: analysis.plan ? 'ready' : 'error',
            }
          } catch (err) {
            return {
              id,
              path: entry.path,
              format,
              bytes: entry.bytes,
              text,
              status: 'error',
              note: err instanceof Error ? err.message : String(err),
            }
          }
        }
        if (format === 'sab') {
          return {
            id,
            path: entry.path,
            format,
            bytes: entry.bytes,
            status: 'error',
            note: t('convert.sabNote'),
          }
        }
        if (format === 'step' || format === 'iges') {
          return { id, path: entry.path, format, bytes: entry.bytes, status: 'ready' }
        }
        return {
          id,
          path: entry.path,
          format,
          bytes: entry.bytes,
          status: 'error',
          note: t('convert.unsupportedNote'),
        }
      })
      setJobs((current) => {
        const byId = new Map(current.map((job) => [job.id, job]))
        for (const job of next) byId.set(job.id, job)
        return [...byId.values()]
      })
      setSelectedId(next[0]?.id ?? null)
    },
    [t],
  )

  const convertSat = useCallback(async (job: ConvertJob) => {
    if (!job.text) return
    setSelectedId(job.id)
    setJobs((current) =>
      current.map((entry) =>
        entry.id === job.id ? { ...entry, status: 'converting', result: undefined } : entry,
      ),
    )
    try {
      const result = await getStepWorkerPool().sat(job.text, {
        priority: PRIORITY_FOREGROUND,
      })
      setJobs((current) =>
        current.map((entry) =>
          entry.id === job.id
            ? {
                ...entry,
                result,
                status: result.step ? 'done' : 'error',
                note: result.error ?? undefined,
              }
            : entry,
        ),
      )
    } catch (err) {
      setJobs((current) =>
        current.map((entry) =>
          entry.id === job.id
            ? { ...entry, status: 'error', note: err instanceof Error ? err.message : String(err) }
            : entry,
        ),
      )
    }
  }, [])

  const convertAll = useCallback(async () => {
    if (pendingSats.length === 0) return
    setBusy(true)
    try {
      for (const job of pendingSats) await convertSat(job)
    } finally {
      setBusy(false)
    }
  }, [convertSat, pendingSats])

  const cleanStep = useCallback(
    async (job: ConvertJob) => {
      setSelectedId(job.id)
      setJobs((current) =>
        current.map((entry) => (entry.id === job.id ? { ...entry, status: 'converting' } : entry)),
      )
      try {
        const cleaned = await getStepWorkerPool().clean(job.bytes, {
          priority: PRIORITY_FOREGROUND,
        })
        setJobs((current) =>
          current.map((entry) =>
            entry.id === job.id
              ? cleaned
                ? {
                    ...entry,
                    status: 'done',
                    cleaned: cleaned.bytes,
                    cleanedSummary: {
                      kept: cleaned.kept,
                      removed: cleaned.removed,
                      opened: cleaned.opened,
                    },
                    note: undefined,
                  }
                : { ...entry, status: 'done', note: t('convert.step.unchanged') }
              : entry,
          ),
        )
      } catch (err) {
        setJobs((current) =>
          current.map((entry) =>
            entry.id === job.id
              ? {
                  ...entry,
                  status: 'error',
                  note: err instanceof Error ? err.message : String(err),
                }
              : entry,
          ),
        )
      }
    },
    [t],
  )

  const convertIges = useCallback(async (job: ConvertJob) => {
    setSelectedId(job.id)
    setJobs((current) =>
      current.map((entry) =>
        entry.id === job.id ? { ...entry, status: 'converting', output: undefined } : entry,
      ),
    )
    try {
      const result = await getStepWorkerPool().iges(job.bytes, {
        name: baseName(job.path),
        priority: PRIORITY_FOREGROUND,
      })
      setJobs((current) =>
        current.map((entry) =>
          entry.id === job.id
            ? {
                ...entry,
                status: result.step ? 'done' : 'error',
                output: result.step ?? undefined,
                igesRoots: result.roots,
                note: result.error ?? undefined,
              }
            : entry,
        ),
      )
    } catch (err) {
      setJobs((current) =>
        current.map((entry) =>
          entry.id === job.id
            ? { ...entry, status: 'error', note: err instanceof Error ? err.message : String(err) }
            : entry,
        ),
      )
    }
  }, [])

  const runFix = useCallback(
    (job: ConvertJob, action: IssueAction) => {
      if (action === 'convertSat') void convertSat(job)
      else if (action === 'cleanStep') void cleanStep(job)
      else void convertIges(job)
    },
    [cleanStep, convertIges, convertSat],
  )

  const downloadSat = useCallback((job: ConvertJob) => {
    if (!job.result?.step) return
    downloadBlob(
      `${fileStem(baseName(job.path))}.step`,
      new Blob([job.result.step], { type: 'model/step' }),
    )
  }, [])

  const downloadStep = useCallback((job: ConvertJob) => {
    const bytes = job.cleaned ?? job.bytes
    const suffix = job.cleaned ? '-clean' : ''
    downloadBlob(
      `${fileStem(baseName(job.path))}${suffix}.step`,
      new Blob([new Uint8Array(bytes)], { type: 'model/step' }),
    )
  }, [])

  const downloadOutput = useCallback((job: ConvertJob) => {
    if (!job.output) return
    downloadBlob(
      `${fileStem(baseName(job.path))}.step`,
      new Blob([job.output], { type: 'model/step' }),
    )
  }, [])

  return (
    <div className="flex flex-col gap-5">
      <section className="max-w-3xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">{t('convert.title')}</h1>
        <p className="text-muted-foreground">{t('convert.subtitle')}</p>
      </section>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">{t('convert.dropTitle')}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || pendingSats.length === 0}
              onClick={() => void convertAll()}
            >
              <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
              {t('convert.convertAll')}
            </Button>
            {jobs.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setJobs([])}>
                {t('convert.clear')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <DropZone
            compact
            title={t('convert.dropTitle')}
            accept=".sat,.sab,.stp,.step,.igs,.iges,.brep"
            chooseLabel={t('convert.chooseFiles')}
            onBundle={onBundle}
            onError={setError}
          />
          <p className="text-xs text-muted-foreground">{t('convert.outputNote')}</p>
          {error && <p className="text-sm text-destructive-foreground">{error}</p>}
          {jobs.length === 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-dashed border-input px-3 py-3 text-sm text-muted-foreground">
              <FileCog className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{t('convert.empty')}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {jobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('convert.table.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table className="table-fixed" containerClassName="overflow-auto">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[26%]">{t('convert.table.file')}</TableHead>
                  <TableHead className="w-[20%]">{t('convert.table.section')}</TableHead>
                  <TableHead className="w-[20%] text-right">{t('convert.table.length')}</TableHead>
                  <TableHead className="w-[14%]">{t('convert.table.status')}</TableHead>
                  <TableHead className="w-[20%]">{t('convert.table.issues')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => {
                  const issues = sortIssues(issuesFor(job, t))
                  return (
                    <TableRow
                      key={job.id}
                      onClick={() => setSelectedId(job.id)}
                      className={cn(
                        'cursor-pointer',
                        selected?.id === job.id && 'bg-accent/60 hover:bg-accent/60',
                      )}
                    >
                      <TableCell className="min-w-0 font-mono text-xs" title={job.path}>
                        <span className="flex min-w-0 items-center gap-2">
                          <Badge variant="muted" className="shrink-0 font-mono">
                            {FORMAT_LABEL[job.format]}
                          </Badge>
                          <span className="truncate">{baseName(job.path)}</span>
                        </span>
                      </TableCell>
                      <TableCell className="truncate whitespace-nowrap font-mono text-sm">
                        {sectionLabel(job, t)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono text-sm tabular-nums">
                        {lengthLabel(job)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge variant={jobStatusVariant(job)}>{jobStatusLabel(job, t)}</Badge>
                      </TableCell>
                      <TableCell>
                        {issues.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {issues.map((issue) => (
                              <Badge
                                key={issue.key}
                                variant={SEVERITY_VARIANT[issue.severity]}
                                className="whitespace-nowrap"
                                title={issue.message}
                              >
                                {issue.label}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {selected && (
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex min-w-0 items-center gap-2 text-base">
              <Badge variant="muted" className="font-mono">
                {FORMAT_LABEL[selected.format]}
              </Badge>
              <span className="truncate font-mono" title={selected.path}>
                {baseName(selected.path)}
              </span>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant={jobStatusVariant(selected)}>{jobStatusLabel(selected, t)}</Badge>
              {selected.format === 'step' &&
                !selected.cleanedSummary &&
                selected.status !== 'converting' && (
                  <Button size="sm" variant="outline" onClick={() => void cleanStep(selected)}>
                    <Eraser className="size-3.5" />
                    {t('convert.step.clean')}
                  </Button>
                )}
              {selected.format === 'sat' &&
                selected.analysis?.plan &&
                !selected.result?.step &&
                selected.status !== 'converting' && (
                  <Button size="sm" onClick={() => void convertSat(selected)}>
                    <FileCog className="size-3.5" />
                    {t('convert.sat.convert')}
                  </Button>
                )}
              {selected.format === 'iges' &&
                !selected.output &&
                selected.status !== 'converting' && (
                  <Button size="sm" onClick={() => void convertIges(selected)}>
                    <FileCog className="size-3.5" />
                    {t('convert.sat.convert')}
                  </Button>
                )}
              <DownloadButton
                job={selected}
                onDownloadSat={downloadSat}
                onDownloadStep={downloadStep}
                onDownloadOutput={downloadOutput}
              />
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <IssueList job={selected} issues={sortIssues(issuesFor(selected, t))} onRun={runFix} />
            {selected.format === 'sat' && selected.analysis?.section && (
              <SatSectionView analysis={selected.analysis} />
            )}
            <Verification job={selected} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function DownloadButton({
  job,
  onDownloadSat,
  onDownloadStep,
  onDownloadOutput,
}: {
  job: ConvertJob
  onDownloadSat: (job: ConvertJob) => void
  onDownloadStep: (job: ConvertJob) => void
  onDownloadOutput: (job: ConvertJob) => void
}) {
  const { t } = useTranslation()
  if (job.format === 'sat' && job.result?.step) {
    return (
      <Button size="sm" onClick={() => onDownloadSat(job)}>
        <Download className="size-3.5" />
        {t('convert.result.download')}
      </Button>
    )
  }
  if (job.format === 'iges' && job.output) {
    return (
      <Button size="sm" onClick={() => onDownloadOutput(job)}>
        <Download className="size-3.5" />
        {t('convert.result.download')}
      </Button>
    )
  }
  if (job.format === 'step') {
    return (
      <Button
        size="sm"
        variant={job.cleaned ? 'default' : 'outline'}
        onClick={() => onDownloadStep(job)}
      >
        <Download className="size-3.5" />
        {t('convert.step.download')}
      </Button>
    )
  }
  return null
}

/** The issues list, with the fix for each one — the same shape as a preflight part's findings. */
function IssueList({
  job,
  issues,
  onRun,
}: {
  job: ConvertJob
  issues: ConvertIssue[]
  onRun: (job: ConvertJob, action: IssueAction) => void
}) {
  const { t } = useTranslation()
  if (issues.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('convert.issues.none')}</p>
  }
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('convert.table.issues')}
      </h2>
      {issues.map((issue) => {
        const Icon = SEVERITY_ICON[issue.severity]
        return (
          <div
            key={issue.key}
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border px-3 py-2"
          >
            <div className="flex min-w-0 items-start gap-2">
              <Icon
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  issue.severity === 'error' && 'text-destructive-foreground',
                  issue.severity === 'warning' && 'text-amber-300',
                  issue.severity === 'info' && 'text-muted-foreground',
                  issue.severity === 'success' && 'text-emerald-400',
                )}
                aria-hidden
              />
              <div className="flex min-w-0 flex-col gap-1">
                <Badge variant={SEVERITY_VARIANT[issue.severity]} className="w-fit">
                  {t(`convert.severity.${issue.severity}`)}
                </Badge>
                <p className="text-sm">{issue.message}</p>
              </div>
            </div>
            {issue.action && (
              <Button
                size="sm"
                variant={issue.severity === 'warning' ? 'default' : 'outline'}
                onClick={() => onRun(job, issue.action as IssueAction)}
              >
                {issue.action === 'cleanStep' ? (
                  <Eraser className="size-3.5" />
                ) : (
                  <FileCog className="size-3.5" />
                )}
                {issue.actionLabel ?? t('convert.sat.convert')}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The converted/cleaned result: the measurements that verify the output. */
function Verification({ job }: { job: ConvertJob }) {
  const { t } = useTranslation()
  if (job.format === 'sat' && job.result?.build) {
    const build = job.result.build
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('convert.result.title')}
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <ResultItem
            label={t('convert.result.size')}
            value={build.size.map((value) => formatNumber(value, 1)).join(' × ')}
          />
          <ResultItem
            label={t('convert.result.volume')}
            value={`${formatNumber(build.volume / 1000, 0)} cm³`}
          />
          <ResultItem label={t('convert.result.arcFaces')} value={build.arcFaces} />
          <ResultItem
            label={t('convert.result.detected')}
            value={build.detected ?? t('convert.sat.noMatch')}
          />
          <ResultItem
            label={t('convert.result.deviation')}
            value={
              job.result?.analysis.plan
                ? `${formatNumber(job.result.analysis.plan.deviation, 3)} mm`
                : '—'
            }
          />
        </dl>
        <p className="text-xs text-muted-foreground">
          {t('convert.result.volumeCheck', {
            volume: formatNumber(build.volume / 1000, 0),
            expected: formatNumber(build.expectedVolume / 1000, 0),
          })}
        </p>
      </div>
    )
  }
  if (job.format === 'step' && job.cleanedSummary) {
    return (
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ResultItem label={t('convert.step.kept')} value={job.cleanedSummary.kept} />
        <ResultItem label={t('convert.step.removed')} value={job.cleanedSummary.removed} />
        <ResultItem label={t('convert.step.opened')} value={job.cleanedSummary.opened} />
        <ResultItem
          label={t('convert.result.size')}
          value={formatBytes(job.cleaned?.length ?? job.bytes.length)}
        />
      </dl>
    )
  }
  if (job.format === 'iges' && job.output) {
    return (
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ResultItem label={t('convert.iges.roots')} value={job.igesRoots ?? 0} />
        <ResultItem label={t('convert.result.size')} value={formatBytes(job.output.length)} />
      </dl>
    )
  }
  return null
}

function ResultItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="break-words font-mono text-sm tabular-nums">{value}</dd>
    </div>
  )
}

function jobStatusVariant(job: ConvertJob) {
  if (job.status === 'done') return 'success' as const
  if (job.status === 'converting') return 'warning' as const
  if (job.status === 'error') return 'destructive' as const
  return 'muted' as const
}

/** A STEP that needs nothing is simply OK; only an actual clean is reported as "Cleaned". */
function jobStatusLabel(job: ConvertJob, t: TFunction): string {
  if (job.format === 'step' && (job.status === 'ready' || job.status === 'done')) {
    const changed =
      job.cleanedSummary && (job.cleanedSummary.removed > 0 || job.cleanedSummary.opened > 0)
    return changed ? t('convert.status.cleaned') : t('convert.status.ok')
  }
  return t(`convert.status.${job.status}`)
}

/** All detected issues, with the fix that resolves each one. */
function issuesFor(job: ConvertJob, t: TFunction): ConvertIssue[] {
  const issues: ConvertIssue[] = []
  if (job.format === 'sat') {
    const analysis = job.analysis
    if (!analysis) {
      issues.push({
        key: 'unreadable',
        label: t('convert.issueLabels.unreadable'),
        severity: 'error',
        message: job.note ?? t('convert.issues.unreadable'),
      })
      return issues
    }
    const plan = analysis.plan
    for (const problem of analysis.problems) {
      issues.push({
        key: `problem:${problem}`,
        // Parser reasons are free text; keep the pill short and put the full text in the detail.
        label: problem.length > 28 ? `${problem.slice(0, 27)}…` : problem,
        severity: 'error',
        message: problem,
      })
    }
    const compoundMitre = analysis.endCuts.some(
      (cut) => Math.abs(cut.normal[0]) > 1e-6 && Math.abs(cut.normal[1]) > 1e-6,
    )
    if (compoundMitre && !analysis.problems.some((problem) => /compound/i.test(problem))) {
      issues.push({
        key: 'compound-mitre',
        label: t('convert.issueLabels.compoundMitre'),
        severity: 'error',
        message: t('convert.issues.compoundMitre'),
      })
    }
    if (!plan) {
      if (analysis.cornerArcs === 0) {
        issues.push({
          key: 'chorded',
          label: t('convert.issueLabels.chorded'),
          severity: 'warning',
          message: t('convert.issues.chorded'),
        })
      } else if (analysis.guess && analysis.problems.length === 0) {
        issues.push({
          key: 'no-plan',
          label: t('convert.issueLabels.noSection'),
          severity: 'error',
          message: t('convert.issues.planFailed', { reason: t('convert.issues.unknownReason') }),
        })
      }
    } else if (!job.result?.build) {
      if (analysis.cornerArcs > 4) {
        issues.push({
          key: 'split-fillets',
          label: t('convert.issueLabels.split'),
          severity: 'warning',
          message: t('convert.issues.splitFillets', { corners: analysis.cornerArcs }),
          action: 'convertSat',
          actionLabel: t('convert.issues.splitFix'),
        })
      } else if (analysis.cornerArcs < 4) {
        issues.push({
          key: 'chorded-fillets',
          label: t('convert.issueLabels.chorded'),
          severity: 'warning',
          message: t('convert.issues.chordedFix', { corners: analysis.cornerArcs }),
          action: 'convertSat',
          actionLabel: t('convert.issues.splitFix'),
        })
      }
    }
    if (job.result?.error && !issues.some((issue) => issue.message === job.result?.error)) {
      issues.push({
        key: 'build-error',
        label: t('convert.issueLabels.failed'),
        severity: 'error',
        message: job.result.error,
        action: plan ? 'convertSat' : undefined,
        actionLabel: plan ? t('convert.sat.convert') : undefined,
      })
    }
    return issues
  }

  if (job.format === 'step') {
    if (job.note && job.status === 'error') {
      issues.push({
        key: 'clean-error',
        label: t('convert.issueLabels.cleanFailed'),
        severity: 'error',
        message: job.note,
        action: 'cleanStep',
        actionLabel: t('convert.step.clean'),
      })
    }
    // An untouched (or already clean) STEP is fine: no issue, no cleaning nag. A successful clean is
    // reported by the status and the verification table, not as a problem.
    return issues
  }

  if (job.format === 'iges') {
    if (!job.output && job.note) {
      issues.push({
        key: 'iges-missing',
        label: t('convert.issueLabels.igesKernel'),
        severity: 'error',
        message: job.note,
        action: 'convertIges',
        actionLabel: t('convert.sat.convert'),
      })
    }
    return issues
  }

  issues.push({
    key: 'unsupported',
    label: t('convert.issueLabels.unsupported'),
    severity: 'error',
    message: job.note ?? t('convert.issues.unsupported'),
  })
  return issues
}
