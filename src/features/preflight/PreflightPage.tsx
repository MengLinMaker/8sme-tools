import { useNavigate, useSearch } from '@tanstack/react-router'
import { zipSync } from 'fflate'
import { Eye } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
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
import { type PartSortKey, sortParts } from '@/lib/audit/partSort'
import type { SeverityFilter } from '@/lib/audit/schemas'
import type { AuditResult, Finding, PartRecord, Severity } from '@/lib/audit/types'
import { downloadBlob, downloadText } from '@/lib/download'
import { type DrawingMaterial, resolveDrawingMaterial } from '@/lib/parsers/pdfText'
import type { InputBundle } from '@/lib/readInput'
import { resolveStockOutline, type StockOutline } from '@/lib/sections/stock'
import { cleanStep } from '@/lib/step/clean'
import { compareSize, measureStep, type SizeCheck } from '@/lib/step/measure'
import { reconstructStepFromNc } from '@/lib/step/reconstructFromNc'
import { cn } from '@/lib/utils'
import { createOrbitBus, requestView, type ViewPreset } from './orbitSync'

const PartViewer = lazy(() => import('./PartViewer'))
const Nc3dViewer = lazy(() => import('./Nc3dViewer'))

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** How many drawings to parse at once (pdf.js runs each in its own worker). */
const CONCURRENCY = 6

const PART_COLUMNS: { label: string; key: PartSortKey }[] = [
  { label: 'Mark', key: 'mark' },
  { label: 'NC qty', key: 'ncQty' },
  { label: 'PDF qty', key: 'pdfQty' },
  { label: 'NC len', key: 'ncLen' },
  { label: 'PDF len', key: 'pdfLen' },
  { label: 'Profile', key: 'profile' },
  { label: 'NC', key: 'nc' },
  { label: 'STEP', key: 'step' },
  { label: 'PDF', key: 'pdf' },
  { label: 'Model size', key: 'model' },
]

type Filter = SeverityFilter

const VIEW_PRESETS: { id: ViewPreset; label: string }[] = [
  { id: 'iso', label: 'Iso' },
  { id: 'front', label: 'Front' },
  { id: 'top', label: 'Top' },
  { id: 'side', label: 'Side' },
]

/** How the 3D area shows the manufactured (NC) model against the STEP model. */
type ViewMode = 'step' | 'manufactured' | 'split' | 'overlay'

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'manufactured', label: 'Manufactured' },
  { id: 'step', label: 'STEP' },
  { id: 'split', label: 'Side by side' },
  { id: 'overlay', label: 'Overlay' },
]

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
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
  const [modelChecks, setModelChecks] = useState<Map<string, SizeCheck>>(new Map())
  const [checking, setChecking] = useState(false)
  const [drawingMaterials, setDrawingMaterials] = useState<Map<string, DrawingMaterial>>(new Map())
  const [drawingChecking, setDrawingChecking] = useState(false)
  const [drawingDone, setDrawingDone] = useState(0)
  const [drawingTotal, setDrawingTotal] = useState(0)
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

  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  useEffect(() => {
    const bytes = viewing?.pdf ? bytesByPath.get(viewing.pdf.path) : undefined
    if (!bytes) {
      setPdfUrl(null)
      return
    }
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))
    setPdfUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [viewing, bytesByPath])

  const [rightTab, setRightTab] = useState<'drawing' | 'nc1'>('drawing')
  const ncBytes = viewing?.nc ? bytesByPath.get(viewing.nc.path) : undefined
  const stepBytes = viewing?.step ? bytesByPath.get(viewing.step.path) : undefined

  // Manufactured model = the stock with the NC applied, rebuilt from the NC (T profiles only).
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  const [manufactured, setManufactured] = useState<Uint8Array | null>(null)
  useEffect(() => {
    setManufactured(null)
    if (!ncBytes) return
    let cancelled = false
    void reconstructStepFromNc(new TextDecoder().decode(ncBytes)).then(
      (step) => {
        if (!cancelled && step) setManufactured(new TextEncoder().encode(step))
      },
      () => {
        // reconstruction is best-effort; fall back to the STEP view
      },
    )
    return () => {
      cancelled = true
    }
  }, [ncBytes])

  const hasManufactured = Boolean(manufactured)
  const hasStep = Boolean(stepBytes)
  const effectiveMode: ViewMode = !hasManufactured
    ? 'step'
    : viewMode === 'split' && !hasStep
      ? 'manufactured'
      : viewMode

  // One orbit bus per part, shared by the STEP and NC viewports so they rotate together.
  const [orbitBus, setOrbitBus] = useState(() => createOrbitBus())
  const openPart = useCallback((part: PartRecord) => {
    setRightTab('drawing')
    setViewMode('split')
    setOrbitBus(createOrbitBus())
    setViewing(part)
  }, [])

  // Read the drawings (ground-truth qty/length) first — parsed concurrently, since
  // pdf.js does the work off-thread — then measure the STEP models (CPU-bound, so
  // sequential). Running them in order avoids the OCC kernel and pdf.js competing.
  useEffect(() => {
    setDrawingMaterials(new Map())
    setDrawingDone(0)
    setDrawingTotal(0)
    setModelChecks(new Map())
    if (!result) return
    let cancelled = false

    const pdfParts = result.parts.filter((part) => {
      const path = part.pdf?.path
      return path != null && bytesByPath.has(path)
    })
    setDrawingTotal(pdfParts.length)
    setDrawingChecking(pdfParts.length > 0)

    void (async () => {
      // Phase 1: drawings, up to CONCURRENCY at a time.
      const materials = new Map<string, DrawingMaterial>()
      let done = 0
      let cursor = 0
      const run = async () => {
        while (!cancelled && cursor < pdfParts.length) {
          const part = pdfParts[cursor++]
          const path = part.pdf?.path
          const bytes = path ? bytesByPath.get(path) : undefined
          if (bytes) {
            try {
              const material = await resolveDrawingMaterial(bytes, part.mark)
              if (material) materials.set(part.mark, material)
            } catch {
              // ignore an unreadable drawing
            }
          }
          done++
          if (done % 4 === 0 || done === pdfParts.length) {
            setDrawingMaterials(new Map(materials))
            setDrawingDone(done)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pdfParts.length) }, () => run()))
      if (cancelled) return
      setDrawingMaterials(new Map(materials))
      setDrawingDone(pdfParts.length)
      setDrawingChecking(false)

      // Phase 2: STEP model sizes (empty/degenerate measurement is fine).
      setChecking(true)
      const checks = new Map<string, SizeCheck>()
      for (const part of result.parts) {
        if (cancelled) return
        const bytes = part.step ? bytesByPath.get(part.step.path) : undefined
        // Length is compared against the drawing (ground truth) when available.
        const length = materials.get(part.mark)?.length ?? part.expected?.length ?? part.nc?.length
        const cross = part.nc?.dimensions?.slice(0, 2) ?? []
        if (!bytes || length == null || cross.length < 2) {
          checks.set(part.mark, { ok: false, note: 'no STEP / dims' })
          continue
        }
        try {
          const measured = await measureStep(bytes)
          checks.set(
            part.mark,
            compareSize(measured.size, length, cross, measured.bodies, measured.extra),
          )
        } catch {
          checks.set(part.mark, { ok: false, note: 'measure failed' })
        }
      }
      if (!cancelled) {
        setModelChecks(new Map(checks))
        setChecking(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [result, bytesByPath])

  /** True when the NC quantity disagrees with the drawing (ground truth). */
  const drawingQtyMismatch = useCallback(
    (part: PartRecord) => {
      const material = drawingMaterials.get(part.mark)
      return material != null && part.nc?.quantity != null && material.qty !== part.nc.quantity
    },
    [drawingMaterials],
  )

  const allFindings = useMemo(() => {
    if (!result) return []
    const extra: Finding[] = []
    for (const part of result.parts) {
      const material = drawingMaterials.get(part.mark)
      if (material && part.nc?.quantity != null && material.qty !== part.nc.quantity) {
        extra.push({
          severity: 'error',
          code: 'QTY_MISMATCH_DRAWING',
          mark: part.mark,
          message: `NC quantity ${part.nc.quantity} differs from drawing quantity ${material.qty}`,
        })
      }
      const check = modelChecks.get(part.mark)
      if (check?.stray) {
        extra.push({
          severity: 'warning',
          code: 'STRAY_BODY',
          mark: part.mark,
          message: `STEP has ${check.bodies ?? '2+'} solid bodies — extra floating piece(s); can be cleaned`,
        })
      }
    }
    return [...result.findings, ...extra]
      .filter((finding) => finding.severity !== 'info')
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          (a.mark ?? '').localeCompare(b.mark ?? ''),
      )
  }, [result, drawingMaterials, modelChecks])

  const counts = useMemo(() => {
    const result = { error: 0, warning: 0, info: 0 }
    for (const finding of allFindings) result[finding.severity]++
    return result
  }, [allFindings])

  const findings = useMemo(() => {
    return filter === 'all'
      ? allFindings
      : allFindings.filter((finding) => finding.severity === filter)
  }, [allFindings, filter])

  // Parts table sorting — defaults to worst-problem-first so triage is quick.
  const [sort, setSort] = useState<{ key: PartSortKey; dir: 1 | -1 }>({ key: 'severity', dir: 1 })
  const toggleSort = useCallback((key: PartSortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  }, [])
  const sortedParts = useMemo(
    () =>
      result
        ? sortParts(result.parts, sort.key, sort.dir, {
            findings: allFindings,
            materials: drawingMaterials,
            modelChecks,
          })
        : [],
    [result, sort, allFindings, drawingMaterials, modelChecks],
  )

  // Parts whose STEP carries stray bodies that we can clean up.
  const cleanable = useMemo(
    () => (result ? result.parts.filter((p) => modelChecks.get(p.mark)?.stray && p.step) : []),
    [result, modelChecks],
  )
  const [cleaning, setCleaning] = useState(false)

  /** Cleans every stray STEP in the job and re-exports the whole folder as a zip. */
  const cleanAndExport = useCallback(async () => {
    if (!result || !bundle) return
    setCleaning(true)
    try {
      const out: Record<string, Uint8Array> = {}
      for (const entry of bundle.entries) out[entry.path] = entry.bytes
      for (const part of cleanable) {
        const path = part.step?.path
        const bytes = path ? bytesByPath.get(path) : undefined
        if (!path || !bytes) continue
        try {
          const cleanedStep = await cleanStep(bytes)
          if (cleanedStep && cleanedStep.removed > 0) out[path] = cleanedStep.bytes
        } catch {
          // leave the original in place if cleaning fails
        }
      }
      const safeName = result.sourceName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
      downloadBlob(
        `cleaned-${safeName || 'job'}.zip`,
        new Blob([zipSync(out)], { type: 'application/zip' }),
      )
    } finally {
      setCleaning(false)
    }
  }, [result, bundle, cleanable, bytesByPath])

  return (
    <div className="flex flex-col gap-6">
      <section className="max-w-2xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">WiseCAM Preflight</h1>
        <p className="text-muted-foreground">
          Drop a job .zip (NC + STEP + PDF, optionally a part list .xlsx). Everything is checked
          locally in your browser — nothing is uploaded.
        </p>
      </section>

      <DropZone onBundle={handleBundle} onError={setError} />

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 px-3.5 py-3 text-sm text-destructive-foreground">
          {error}
        </div>
      )}

      {result && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Parts" value={result.summary.parts} />
            <Stat label="Errors" value={counts.error} tone="error" />
            <Stat label="Warnings" value={counts.warning} tone="warning" />
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
                    downloadText(
                      `preflight-${result.sourceName}.csv`,
                      findingsToCsv({ ...result, findings: allFindings }),
                    )
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
                {cleanable.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void cleanAndExport()}
                    disabled={cleaning}
                  >
                    {cleaning ? 'Cleaning…' : `Clean & export (${cleanable.length})`}
                  </Button>
                )}
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
              <CardTitle className="flex flex-wrap items-center gap-2">
                Parts
                {drawingChecking && (
                  <span className="text-xs font-normal text-muted-foreground">
                    reading drawings… {drawingDone}/{drawingTotal}
                  </span>
                )}
                {checking && (
                  <span className="text-xs font-normal text-muted-foreground">
                    measuring models…
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table containerClassName="max-h-[70vh] overflow-auto">
                <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:border-b [&_th]:border-border [&_th]:bg-card [&_th:first-child]:left-0 [&_th:first-child]:z-30">
                  <TableRow className="hover:bg-transparent">
                    {PART_COLUMNS.map((column) => (
                      <SortHead
                        key={column.key}
                        label={column.label}
                        sortKey={column.key}
                        sort={sort}
                        onSort={toggleSort}
                      />
                    ))}
                    <TableHead className="text-right">3D</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="[&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:z-10 [&_td:first-child]:bg-card">
                  {sortedParts.map((part) => (
                    <TableRow key={part.mark}>
                      <TableCell className="font-mono text-xs">{part.mark}</TableCell>
                      <TableCell
                        className={cn(
                          drawingQtyMismatch(part) &&
                            'bg-destructive/15 font-semibold text-destructive-foreground',
                        )}
                      >
                        {part.nc?.quantity ?? '—'}
                      </TableCell>
                      <TableCell>
                        {drawingMaterials.get(part.mark)?.qty ?? part.expected?.qty ?? '—'}
                      </TableCell>
                      <TableCell>{part.nc?.length ?? '—'}</TableCell>
                      <TableCell>
                        {drawingMaterials.get(part.mark)?.length ?? part.expected?.length ?? '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {part.nc?.profile ?? part.expected?.profile ?? '—'}
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
                      <TableCell className="text-xs">
                        {modelChecks.has(part.mark) ? (
                          <span
                            className={
                              modelChecks.get(part.mark)?.ok ? 'text-emerald-400' : 'text-amber-400'
                            }
                          >
                            {modelChecks.get(part.mark)?.note}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {part.step || part.nc ? (
                          <Button variant="ghost" size="sm" onClick={() => openPart(part)}>
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
        title={viewing ? `${viewing.mark} · drawing + 3D` : undefined}
        className="max-w-6xl"
      >
        {viewing && (viewing.step || viewing.nc) && (
          <>
            <div className="flex flex-col lg:flex-row">
              <div className="relative h-[45vh] min-h-72 w-full bg-[#0b0f14] lg:h-[70vh] lg:flex-1">
                <Suspense
                  fallback={
                    <div className="grid h-full place-items-center text-sm text-muted-foreground">
                      Loading viewer…
                    </div>
                  }
                >
                  {effectiveMode === 'overlay' && manufactured ? (
                    <PartViewer
                      name={`${viewing.mark} · manufactured`}
                      bytes={manufactured}
                      compareBytes={stepBytes}
                      compareLabel="STEP"
                      stock={stock}
                      bus={orbitBus}
                    />
                  ) : effectiveMode === 'split' && manufactured ? (
                    <div className="grid h-full grid-cols-2">
                      <div className="relative h-full">
                        <PartViewer
                          name={`${viewing.mark} · manufactured`}
                          bytes={manufactured}
                          stock={stock}
                          bus={orbitBus}
                        />
                        <PaneTag tone="manufactured">Manufactured (NC)</PaneTag>
                      </div>
                      <div className="relative h-full border-l border-border">
                        <PartViewer
                          name={viewing.step?.path ?? 'STEP'}
                          bytes={stepBytes}
                          stock={stock}
                          bus={orbitBus}
                        />
                        <PaneTag tone="step">STEP</PaneTag>
                      </div>
                    </div>
                  ) : effectiveMode === 'manufactured' && manufactured ? (
                    <PartViewer
                      name={`${viewing.mark} · manufactured`}
                      bytes={manufactured}
                      stock={stock}
                      bus={orbitBus}
                    />
                  ) : (
                    <PartViewer
                      name={viewing.step?.path ?? 'STEP'}
                      bytes={stepBytes}
                      stock={stock}
                      bus={orbitBus}
                    />
                  )}
                </Suspense>
                <div className="absolute right-3 top-3 z-10 flex gap-1 rounded-md border border-border bg-card/80 p-1 backdrop-blur">
                  {VIEW_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => requestView(orbitBus, preset.id)}
                      className="rounded px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                {hasManufactured && (
                  <div className="absolute bottom-3 left-3 z-10 flex gap-1 rounded-md border border-border bg-card/80 p-1 backdrop-blur">
                    {VIEW_MODES.map((mode) => {
                      const disabled =
                        (mode.id === 'step' && !hasStep) ||
                        (mode.id === 'split' && !hasStep) ||
                        (mode.id === 'overlay' && !hasStep)
                      return (
                        <button
                          key={mode.id}
                          type="button"
                          disabled={disabled}
                          onClick={() => setViewMode(mode.id)}
                          className={cn(
                            'rounded px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-30',
                            effectiveMode === mode.id
                              ? 'bg-accent text-accent-foreground'
                              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                          )}
                        >
                          {mode.label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="flex h-[45vh] w-full flex-col border-t border-border lg:h-[70vh] lg:flex-1 lg:border-l lg:border-t-0">
                <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
                  {[
                    { id: 'drawing' as const, label: 'Drawing' },
                    { id: 'nc1' as const, label: 'NC1' },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      disabled={tab.id === 'nc1' && !ncBytes}
                      onClick={() => setRightTab(tab.id)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40',
                        rightTab === tab.id
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {rightTab === 'nc1' && ncBytes ? (
                    <Suspense
                      fallback={
                        <div className="grid h-full place-items-center text-sm text-muted-foreground">
                          Loading…
                        </div>
                      }
                    >
                      <Nc3dViewer bytes={ncBytes} bus={orbitBus} />
                    </Suspense>
                  ) : pdfUrl ? (
                    <iframe
                      title={`${viewing.mark} drawing`}
                      src={pdfUrl}
                      className="h-full w-full border-0"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-sm text-muted-foreground">
                      No drawing.
                    </div>
                  )}
                </div>
              </div>
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
            <PartMeta part={viewing} material={drawingMaterials.get(viewing.mark)} />
          </>
        )}
      </Dialog>
    </div>
  )
}

function PartMeta({ part, material }: { part: PartRecord; material?: DrawingMaterial }) {
  const pdfLength = material?.length ?? part.expected?.length ?? null
  const pdfQty = material?.qty ?? part.expected?.qty ?? null
  const rows: [string, string][] = [
    ['File', part.step?.path.split('/').pop() ?? '—'],
    ['Profile', part.nc?.profile ?? part.expected?.profile ?? '—'],
    ['NC length', part.nc?.length != null ? `${part.nc.length} mm` : '—'],
    ['PDF length', pdfLength != null ? `${pdfLength} mm` : '—'],
    ['NC qty', part.nc?.quantity != null ? String(part.nc.quantity) : '—'],
    ['PDF qty', pdfQty != null ? String(pdfQty) : '—'],
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

function PaneTag({ children, tone }: { children: ReactNode; tone?: 'manufactured' | 'step' }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full border px-3 py-0.5 text-xs font-semibold backdrop-blur',
        tone === 'manufactured'
          ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
          : tone === 'step'
            ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
            : 'border-border bg-card/85 text-foreground',
      )}
    >
      {children}
    </span>
  )
}

function SortHead({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string
  sortKey: PartSortKey
  sort: { key: PartSortKey; dir: 1 | -1 }
  onSort: (key: PartSortKey) => void
}) {
  const active = sort.key === sortKey
  return (
    <TableHead>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground"
      >
        {label}
        <span className="text-[9px] leading-none">
          {active ? (sort.dir === 1 ? '▲' : '▼') : ''}
        </span>
      </button>
    </TableHead>
  )
}
