import { useNavigate, useSearch } from '@tanstack/react-router'
import { Eye } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { DropZone } from '@/components/DropZone'
import { Badge } from '@/components/ui/badge'
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
import { auditEntries } from '@/lib/audit/auditJob'
import { findingsToCsv, partsToCsv } from '@/lib/audit/csv'
import type { SeverityFilter } from '@/lib/audit/schemas'
import type { AuditResult, PartRecord, Severity } from '@/lib/audit/types'
import { downloadText } from '@/lib/download'
import type { InputBundle } from '@/lib/readInput'
import { resolveStockOutline, type StockOutline } from '@/lib/sections/stock'
import { cn } from '@/lib/utils'

const PartViewer = lazy(() => import('./PartViewer'))

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

export function PreflightPage() {
  const [result, setResult] = useState<AuditResult | null>(null)
  const [bundle, setBundle] = useState<InputBundle | null>(null)
  const [viewing, setViewing] = useState<PartRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const search = useSearch({ from: '/preflight' })
  const navigate = useNavigate({ from: '/preflight' })
  const filter: Filter = search.severity ?? 'all'

  const setFilter = useCallback(
    (next: Filter) => {
      void navigate({ search: { severity: next }, replace: true })
    },
    [navigate],
  )

  const handleBundle = useCallback(
    (input: InputBundle) => {
      setError(null)
      setBundle(input)
      setViewing(null)
      setResult(auditEntries(input.sourceName, input.entries))
      setFilter('all')
    },
    [setFilter],
  )

  const bytesByPath = useMemo(() => {
    const map = new Map<string, Uint8Array>()
    for (const entry of bundle?.entries ?? []) map.set(entry.path, entry.bytes)
    return map
  }, [bundle])

  const [stock, setStock] = useState<StockOutline | null>(null)
  useEffect(() => {
    setStock(null)
    if (!viewing) return
    let cancelled = false
    const pdfBytes = viewing.pdf ? bytesByPath.get(viewing.pdf.path) : undefined
    void resolveStockOutline(viewing, pdfBytes).then(
      (outline) => {
        if (!cancelled) setStock(outline)
      },
      () => {
        if (!cancelled) setStock(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [viewing, bytesByPath])

  const findings = useMemo(() => {
    if (!result) return []
    return filter === 'all'
      ? result.findings
      : result.findings.filter((finding) => finding.severity === filter)
  }, [result, filter])

  return (
    <div className="flex flex-col gap-6">
      <section className="max-w-2xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">WiseCAM Preflight</h1>
        <p className="text-muted-foreground">
          Drop a job .zip (NC + STEP + PDF, optionally a part list .xlsx). Everything is checked
          locally in your browser — nothing is uploaded.
        </p>
      </section>

      <DropZone
        onBundle={handleBundle}
        onError={setError}
        title="Drop a job .zip, files, or a folder"
      />

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
                    <TableHead className="text-right">3D</TableHead>
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
                      <TableCell className="text-right">
                        {part.step ? (
                          <Button variant="ghost" size="sm" onClick={() => setViewing(part)}>
                            <Eye />
                            View
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing ? `${viewing.mark} · 3D view` : undefined}
        className="max-w-4xl"
      >
        {viewing?.step && (
          <>
            <div className="relative h-[58vh] min-h-72 w-full bg-[#0b0f14]">
              <Suspense
                fallback={
                  <div className="grid h-full place-items-center text-sm text-muted-foreground">
                    Loading viewer…
                  </div>
                }
              >
                <PartViewer
                  name={viewing.step.path}
                  bytes={bytesByPath.get(viewing.step.path)}
                  stock={stock}
                />
              </Suspense>
            </div>
            {stock && (
              <div className="flex items-center gap-2 border-t border-border px-5 py-2 text-xs text-muted-foreground">
                <span
                  className="inline-block size-3 rounded-sm border"
                  style={{
                    borderColor: '#3ddc84',
                    background: 'rgba(61, 220, 132, 0.18)',
                  }}
                />
                Green outline = uncut stock ({stock.label}) overlaid for comparison
              </div>
            )}
            <PartMeta part={viewing} />
          </>
        )}
      </Dialog>
    </div>
  )
}

function PartMeta({ part }: { part: PartRecord }) {
  const rows: [string, string][] = [
    ['File', part.step?.path.split('/').pop() ?? '—'],
    ['Profile', part.nc?.profile ?? part.expected?.profile ?? '—'],
    ['Grade', part.nc?.grade ?? part.expected?.grade ?? '—'],
    ['NC length', part.nc?.length != null ? `${part.nc.length} mm` : '—'],
    ['List length', part.expected?.length != null ? `${part.expected.length} mm` : '—'],
    ['NC qty', part.nc?.quantity != null ? String(part.nc.quantity) : '—'],
    ['List qty', part.expected?.qty != null ? String(part.expected.qty) : '—'],
    ['Schema', part.step?.schema ?? '—'],
    ['Entities', part.step ? part.step.entityCount.toLocaleString() : '—'],
  ]
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border px-5 py-4 text-sm sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
            <dd className="font-mono text-xs break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {part.step && !part.step.valid && (
        <div className="border-t border-destructive/40 bg-destructive/10 px-5 py-2 text-xs text-destructive-foreground">
          {part.step.problems.join('; ')}
        </div>
      )}
    </>
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
