import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  type DragEvent,
  type InputHTMLAttributes,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
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
import { auditEntries } from '@/lib/audit/auditJob'
import { findingsToCsv, partsToCsv } from '@/lib/audit/csv'
import type { SeverityFilter } from '@/lib/audit/schemas'
import type { AuditResult, Severity } from '@/lib/audit/types'
import { downloadText } from '@/lib/download'
import { type InputBundle, readDataTransfer, readFiles } from '@/lib/readInput'
import { cn } from '@/lib/utils'

type Filter = SeverityFilter

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'info', label: 'Info' },
]

const SEVERITY_VARIANT = {
  error: 'destructive',
  warning: 'warning',
  info: 'info',
} as const

const DIRECTORY_INPUT_PROPS = {
  webkitdirectory: '',
  directory: '',
} as unknown as InputHTMLAttributes<HTMLInputElement>

export function PreflightPage() {
  const [result, setResult] = useState<AuditResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const search = useSearch({ from: '/preflight' })
  const navigate = useNavigate({ from: '/preflight' })
  const filter: Filter = search.severity ?? 'all'

  const setFilter = useCallback(
    (next: Filter) => {
      void navigate({ search: { severity: next }, replace: true })
    },
    [navigate],
  )

  const ingest = useCallback(
    async (read: () => Promise<InputBundle>) => {
      setBusy(true)
      setError(null)
      try {
        const { sourceName, entries } = await read()
        if (entries.length === 0) {
          throw new Error('No readable NC / STEP / PDF / part-list files found.')
        }
        setResult(auditEntries(sourceName, entries))
        setFilter('all')
      } catch (err) {
        setResult(null)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [setFilter],
  )

  const run = useCallback(
    (files: File[]) => {
      if (files.length > 0) void ingest(() => readFiles(files))
    },
    [ingest],
  )

  const findings = useMemo(() => {
    if (!result) return []
    return filter === 'all'
      ? result.findings
      : result.findings.filter((finding) => finding.severity === filter)
  }, [result, filter])

  const onDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault()
      setDragging(false)
      void ingest(() => readDataTransfer(event.dataTransfer))
    },
    [ingest],
  )

  return (
    <div className="flex flex-col gap-6">
      <section className="max-w-2xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">WiseCAM Preflight</h1>
        <p className="text-muted-foreground">
          Drop a job .zip (NC + STEP + PDF, optionally a part list .xlsx). Everything is checked
          locally in your browser — nothing is uploaded.
        </p>
      </section>

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void run(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        hidden
        {...DIRECTORY_INPUT_PROPS}
        onChange={(event) => {
          void run(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <button
        type="button"
        className={cn(
          'flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed px-5 py-9 text-center transition-colors',
          dragging
            ? 'border-primary bg-primary/5'
            : 'border-input hover:border-primary/50 hover:bg-accent/40',
          busy && 'cursor-default opacity-70',
        )}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <span className="text-lg font-semibold">
          {busy ? 'Auditing…' : 'Drop a .zip, files, or a folder'}
        </span>
        <span className="text-sm text-muted-foreground">or click to browse files</span>
        <span className="mt-1 text-xs tracking-wide text-muted-foreground">
          .zip · .nc1 · .stp · .pdf · .xlsx
        </span>
      </button>
      <div className="text-center text-sm text-muted-foreground">
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => folderInputRef.current?.click()}
        >
          choose a folder
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 px-3.5 py-3 text-sm text-destructive-foreground">
          {error}
        </div>
      )}

      {result && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Parts" value={result.summary.parts} />
            <Stat label="Errors" value={result.summary.errors} tone="error" />
            <Stat label="Warnings" value={result.summary.warnings} tone="warning" />
            <Stat label="Info" value={result.summary.infos} tone="info" />
            <Stat label="Files" value={result.entriesTotal} />
            <Stat label="Part list" value={result.summary.hasPartList ? 'yes' : 'no'} />
          </section>

          <Card>
            <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between">
              <CardTitle>Findings</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex gap-1 rounded-full border border-border bg-secondary p-1">
                  {FILTERS.map((filterOption) => (
                    <button
                      key={filterOption.id}
                      type="button"
                      className={cn(
                        'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
                        filter === filterOption.id
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => setFilter(filterOption.id)}
                    >
                      {filterOption.label}
                    </button>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    downloadText(`preflight-${result.sourceName}.csv`, findingsToCsv(result))
                  }
                >
                  Export findings
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadText(`parts-${result.sourceName}.csv`, partsToCsv(result))}
                >
                  Export parts
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {findings.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing to report for this filter.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Severity</TableHead>
                      <TableHead>Code</TableHead>
                      <TableHead>Mark</TableHead>
                      <TableHead>Message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {findings.map((finding) => (
                      <TableRow key={`${finding.code}-${finding.mark ?? ''}-${finding.message}`}>
                        <TableCell>
                          <Badge variant={SEVERITY_VARIANT[finding.severity]}>
                            {finding.severity}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {finding.code}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{finding.mark ?? '—'}</TableCell>
                        <TableCell>{finding.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Parts</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Mark</TableHead>
                    <TableHead>NC qty</TableHead>
                    <TableHead>List qty</TableHead>
                    <TableHead>NC len</TableHead>
                    <TableHead>List len</TableHead>
                    <TableHead>Profile</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead>NC</TableHead>
                    <TableHead>STEP</TableHead>
                    <TableHead>PDF</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.parts.map((part) => (
                    <TableRow key={part.mark}>
                      <TableCell className="font-mono text-xs">{part.mark}</TableCell>
                      <TableCell>{part.nc?.quantity ?? '—'}</TableCell>
                      <TableCell>{part.expected?.qty ?? '—'}</TableCell>
                      <TableCell>{part.nc?.length ?? '—'}</TableCell>
                      <TableCell>{part.expected?.length ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {part.nc?.profile ?? part.expected?.profile ?? '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {part.nc?.grade ?? part.expected?.grade ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Status value={part.nc ? part.nc.valid : null} />
                      </TableCell>
                      <TableCell>
                        <Status value={part.step ? part.step.valid : null} />
                      </TableCell>
                      <TableCell>
                        <Status value={part.pdf ? part.pdf.valid : null} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

const STAT_TONE: Record<Severity, string> = {
  error: 'text-red-400',
  warning: 'text-amber-400',
  info: 'text-sky-400',
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: Severity }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-card px-3.5 py-3">
      <span className={cn('text-2xl font-bold tracking-tight', tone && STAT_TONE[tone])}>
        {value}
      </span>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  )
}

function Status({ value }: { value: boolean | null }) {
  if (value === null) return <Badge variant="muted">missing</Badge>
  return <Badge variant={value ? 'success' : 'destructive'}>{value ? 'ok' : 'bad'}</Badge>
}
