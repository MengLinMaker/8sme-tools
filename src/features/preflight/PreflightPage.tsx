import { useNavigate, useSearch } from '@tanstack/react-router'
import { zipSync } from 'fflate'
import type { TFunction } from 'i18next'
import { Eye, Undo2 } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import type { AuditResult, Finding, PartRecord, Severity, StepFile } from '@/lib/audit/types'
import { downloadBlob, downloadText } from '@/lib/download'
import { type DrawingMaterial, resolveDrawingMaterial } from '@/lib/parsers/pdfText'
import type { InputBundle } from '@/lib/readInput'
import { resolveStockOutline, type StockOutline } from '@/lib/sections/stock'
import { cleanStep } from '@/lib/step/clean'
import {
  compareModels,
  compareSize,
  type ModelComparison,
  measureStep,
  type SizeCheck,
  type StepMeasure,
} from '@/lib/step/measure'
import { reconstructStepFromNc } from '@/lib/step/reconstructFromNc'
import { cn } from '@/lib/utils'
import { createOrbitBus, requestView, type ViewPreset } from './orbitSync'

const PartViewer = lazy(() => import('./PartViewer'))
const Nc3dViewer = lazy(() => import('./Nc3dViewer'))

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** How many drawings to parse at once (pdf.js runs each in its own worker). */
const CONCURRENCY = 6

const PART_COLUMNS: { labelKey: string; key: PartSortKey }[] = [
  { labelKey: 'preflight.columns.mark', key: 'mark' },
  { labelKey: 'preflight.columns.ncQty', key: 'ncQty' },
  { labelKey: 'preflight.columns.pdfQty', key: 'pdfQty' },
  { labelKey: 'preflight.columns.ncLen', key: 'ncLen' },
  { labelKey: 'preflight.columns.pdfLen', key: 'pdfLen' },
  { labelKey: 'preflight.columns.profile', key: 'profile' },
  { labelKey: 'preflight.columns.nc', key: 'nc' },
  { labelKey: 'preflight.columns.step', key: 'step' },
  { labelKey: 'preflight.columns.pdf', key: 'pdf' },
  { labelKey: 'preflight.columns.model', key: 'model' },
]

type Filter = SeverityFilter

const VIEW_PRESETS: { id: ViewPreset; labelKey: string }[] = [
  { id: 'iso', labelKey: 'preflight.viewer.iso' },
  { id: 'front', labelKey: 'preflight.viewer.front' },
  { id: 'top', labelKey: 'preflight.viewer.top' },
  { id: 'side', labelKey: 'preflight.viewer.side' },
]

/** How the 3D area shows the manufactured (NC) model against the STEP model. */
type ViewMode = 'step' | 'manufactured' | 'split' | 'overlay'

const VIEW_MODES: { id: ViewMode; labelKey: string }[] = [
  { id: 'manufactured', labelKey: 'preflight.viewer.manufactured' },
  { id: 'step', labelKey: 'preflight.viewer.step' },
  { id: 'split', labelKey: 'preflight.viewer.sideBySide' },
  { id: 'overlay', labelKey: 'preflight.viewer.overlay' },
]

const FILTERS: { id: Filter; labelKey: string }[] = [
  { id: 'all', labelKey: 'preflight.filters.all' },
  { id: 'error', labelKey: 'preflight.filters.error' },
  { id: 'warning', labelKey: 'preflight.filters.warning' },
]

const SEVERITY_VARIANT = {
  error: 'destructive',
  warning: 'warning',
  info: 'info',
} as const

/** A per-part STEP fix the user applied: cleaned (stray bodies dropped) or rebuilt from the NC. */
type StepFixKind = 'cleaned' | 'regenerated'
interface StepOverride {
  bytes: Uint8Array
  kind: StepFixKind
}

/** A finding an override resolves — greyed out in the list, with an undo. */
function resolvedFindings(kind: StepFixKind): string[] {
  return kind === 'regenerated' ? ['STRAY_BODY', 'MANUFACTURE_MISMATCH'] : ['STRAY_BODY']
}

/** Formats a measured-vs-expected size check for display (localised). */
function formatSizeCheck(t: TFunction, check?: SizeCheck): string {
  if (!check) return '—'
  if (check.error === 'noDims') return t('preflight.model.noDims')
  if (check.error === 'measureFailed') return t('preflight.model.measureFailed')
  if (!check.measured || !check.expected) return '—'
  const [l, a, b] = check.measured.map((value) => value.toFixed(0))
  const measured = `L${l} × ${a} × ${b}`
  const [el, ea, eb] = check.expected.map((value) => value.toFixed(0))
  const size = check.ok
    ? t('preflight.model.sizeOk', { measured })
    : t('preflight.model.sizeMismatch', { measured, expected: `L${el} × ${ea} × ${eb}` })
  const annotated = check.bodies != null && !(check.bodies === 1 && !check.stray)
  if (!annotated) return size
  return (
    size +
    t('preflight.model.bodyCount', { count: check.bodies }) +
    (check.stray ? t('preflight.model.straySuffix') : '')
  )
}

/** Formats an NC-vs-STEP model comparison for display (localised). */
function formatModelComparison(t: TFunction, comparison: ModelComparison): string {
  const sizeText = (size?: [number, number, number]) =>
    size ? `${size.map((value) => value.toFixed(0)).join(' × ')} mm` : ''
  const size = sizeText(comparison.size)
  if (comparison.ok) return t('preflight.model.ncMatches', { size })
  const note = t('preflight.model.ncMismatch', {
    size,
    expected: sizeText(comparison.referenceSize),
  })
  if (comparison.volumeOk) return note
  const delta = `${comparison.volumeDelta >= 0 ? '+' : ''}${(comparison.volumeDelta * 100).toFixed(1)}%`
  return note + t('preflight.model.volume', { delta })
}

export function PreflightPage() {
  const { t } = useTranslation()
  const findingText = useCallback(
    (finding: Finding) =>
      t(`findings.${finding.code}`, { ...finding.params, defaultValue: finding.message }),
    [t],
  )
  const [result, setResult] = useState<AuditResult | null>(null)
  const [bundle, setBundle] = useState<InputBundle | null>(null)
  const [viewing, setViewing] = useState<PartRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modelChecks, setModelChecks] = useState<Map<string, SizeCheck>>(new Map())
  const [manufactureChecks, setManufactureChecks] = useState<Map<string, ModelComparison>>(
    new Map(),
  )
  const [checking, setChecking] = useState(false)
  /** True from when a job is dropped until the whole analysis (drawings + models) finishes. */
  const [analyzing, setAnalyzing] = useState(false)
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
      setAnalyzing(true)
      setBundle(input)
      setViewing(null)
      setStepOverrides(new Map())
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
  // Per-part STEP fixes keyed by mark (cleaned or regenerated). The viewer and the export both
  // prefer these over the originals, so a fix is what you see and what ships — and it can be undone.
  const [stepOverrides, setStepOverrides] = useState<Map<string, StepOverride>>(new Map())
  const [fixingMark, setFixingMark] = useState<string | null>(null)
  const ncBytes = viewing?.nc ? bytesByPath.get(viewing.nc.path) : undefined
  const stepBytes = viewing
    ? (stepOverrides.get(viewing.mark)?.bytes ??
      (viewing.step ? bytesByPath.get(viewing.step.path) : undefined))
    : undefined

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
    setManufactureChecks(new Map())
    if (!result) {
      setAnalyzing(false)
      return
    }
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
      const measures = new Map<string, StepMeasure>()
      for (const part of result.parts) {
        if (cancelled) return
        const bytes = part.step ? bytesByPath.get(part.step.path) : undefined
        // Length is compared against the drawing (ground truth) when available.
        const length = materials.get(part.mark)?.length ?? part.expected?.length ?? part.nc?.length
        const cross = part.nc?.dimensions?.slice(0, 2) ?? []
        if (!bytes || length == null || cross.length < 2) {
          checks.set(part.mark, { ok: false, error: 'noDims' })
          continue
        }
        try {
          const measured = await measureStep(bytes)
          measures.set(part.mark, measured)
          checks.set(
            part.mark,
            compareSize(measured.size, length, cross, measured.bodies, measured.extra),
          )
        } catch {
          checks.set(part.mark, { ok: false, error: 'measureFailed' })
        }
      }
      if (cancelled) return
      setModelChecks(new Map(checks))

      // Phase 3: does the NC-built geometry match the STEP? Rebuild each part from its NC and
      // compare sizes/volume. Mismatches get an offer to regenerate the STEP (viewer / findings).
      const manufacture = new Map<string, ModelComparison>()
      for (const part of result.parts) {
        if (cancelled) return
        const ncPath = part.nc?.path
        const ncText = ncPath ? bytesByPath.get(ncPath) : undefined
        const stepMeasure = measures.get(part.mark)
        if (!ncText || !stepMeasure) continue
        try {
          const built = await reconstructStepFromNc(new TextDecoder().decode(ncText))
          if (!built) continue
          const madeMeasure = await measureStep(new TextEncoder().encode(built))
          manufacture.set(part.mark, compareModels(stepMeasure, madeMeasure))
        } catch {
          // best-effort: skip parts the rebuild can't handle
        }
      }
      if (!cancelled) {
        setManufactureChecks(new Map(manufacture))
        setChecking(false)
        setAnalyzing(false)
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
          params: { nc: part.nc.quantity, drawing: material.qty },
        })
      }
      const check = modelChecks.get(part.mark)
      if (check?.stray) {
        extra.push({
          severity: 'warning',
          code: 'STRAY_BODY',
          mark: part.mark,
          message: `STEP has ${check.bodies ?? '2+'} solid bodies — extra floating piece(s); can be cleaned`,
          params: { bodies: check.bodies ?? '2+' },
        })
      }
      const manufacture = manufactureChecks.get(part.mark)
      if (manufacture && !manufacture.ok) {
        const note = formatModelComparison(t, manufacture)
        extra.push({
          severity: 'warning',
          code: 'MANUFACTURE_MISMATCH',
          mark: part.mark,
          message: `${note} — can regenerate STEP from the NC`,
          params: { note },
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
  }, [result, drawingMaterials, modelChecks, manufactureChecks, t])

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

  /** Findings for the part currently open in the viewer, shown above the 3D to debug fast. */
  const viewerFindings = useMemo(
    () => (viewing ? allFindings.filter((finding) => finding.mark === viewing.mark) : []),
    [viewing, allFindings],
  )

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

  const partByMark = useMemo(() => {
    const map = new Map<string, PartRecord>()
    for (const part of result?.parts ?? []) map.set(part.mark, part)
    return map
  }, [result])

  /** The override a part carries, if any (cleaned or regenerated). */
  const overrideFor = useCallback(
    (part: PartRecord | undefined) => (part ? stepOverrides.get(part.mark) : undefined),
    [stepOverrides],
  )

  /** A part can be cleaned when its STEP still carries stray floating bodies (and isn't fixed). */
  const isCleanable = useCallback(
    (part: PartRecord | undefined) =>
      Boolean(
        part?.step &&
          modelChecks.get(part.mark)?.stray &&
          stepOverrides.get(part.mark)?.kind !== 'cleaned',
      ),
    [modelChecks, stepOverrides],
  )

  /** A part can be regenerated when its NC build doesn't match the STEP (and isn't regenerated). */
  const isRegeneratable = useCallback(
    (part: PartRecord | undefined) =>
      Boolean(
        part?.nc &&
          manufactureChecks.get(part.mark)?.ok === false &&
          stepOverrides.get(part.mark)?.kind !== 'regenerated',
      ),
    [manufactureChecks, stepOverrides],
  )

  const setOverride = useCallback((mark: string, bytes: Uint8Array, kind: StepFixKind) => {
    setStepOverrides((prev) => {
      const next = new Map(prev)
      next.set(mark, { bytes, kind })
      return next
    })
  }, [])

  const undoOverride = useCallback((mark: string) => {
    setStepOverrides((prev) => {
      if (!prev.has(mark)) return prev
      const next = new Map(prev)
      next.delete(mark)
      return next
    })
  }, [])

  /** Cleans one part's stray STEP bodies, keeping the real geometry untouched. */
  const cleanPart = useCallback(
    async (part: PartRecord) => {
      const path = part.step?.path
      const bytes = path ? bytesByPath.get(path) : undefined
      if (!path || !bytes) return
      setFixingMark(part.mark)
      try {
        const cleaned = await cleanStep(bytes)
        if (cleaned && cleaned.removed > 0) setOverride(part.mark, cleaned.bytes, 'cleaned')
      } catch {
        // leave the original in place if cleaning fails
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, setOverride],
  )

  /** Rebuilds a part's STEP from its NC, so the export matches what will be manufactured. */
  const regeneratePart = useCallback(
    async (part: PartRecord) => {
      const ncPath = part.nc?.path
      const ncBytes = ncPath ? bytesByPath.get(ncPath) : undefined
      if (!ncBytes) return
      setFixingMark(part.mark)
      try {
        const step = await reconstructStepFromNc(new TextDecoder().decode(ncBytes))
        if (step) setOverride(part.mark, new TextEncoder().encode(step), 'regenerated')
      } catch {
        // leave the original in place if the rebuild fails
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, setOverride],
  )

  /** Exports the job with every STEP the user fixed (cleaned/regenerated) substituted in. */
  const exportFixed = useCallback(() => {
    if (!result || !bundle || stepOverrides.size === 0) return
    const out: Record<string, Uint8Array> = {}
    for (const entry of bundle.entries) out[entry.path] = entry.bytes
    for (const [mark, override] of stepOverrides) {
      const path = result.parts.find((part) => part.mark === mark)?.step?.path
      if (path) out[path] = override.bytes
    }
    const safeName = result.sourceName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
    downloadBlob(
      `fixed-${safeName || 'job'}.zip`,
      new Blob([zipSync(out)], { type: 'application/zip' }),
    )
  }, [result, bundle, stepOverrides])

  return (
    <div className="flex flex-col gap-6">
      <section className="max-w-2xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">{t('preflight.title')}</h1>
        <p className="text-muted-foreground">{t('preflight.subtitle')}</p>
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
            <Stat label={t('preflight.stats.parts')} value={result.summary.parts} />
            <Stat
              label={t('preflight.stats.errors')}
              value={counts.error}
              tone="error"
              pending={analyzing}
            />
            <Stat
              label={t('preflight.stats.warnings')}
              value={counts.warning}
              tone="warning"
              pending={analyzing}
            />
            <Stat label={t('preflight.stats.files')} value={result.entriesTotal} />
            <Stat
              label={t('preflight.stats.partList')}
              value={
                result.summary.hasPartList ? t('preflight.stats.yes') : t('preflight.stats.no')
              }
            />
          </section>

          <Card>
            <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between">
              <CardTitle>{t('preflight.findings.title')}</CardTitle>
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
                      {t(filterOption.labelKey)}
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
                  {t('preflight.findings.exportFindings')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadText(`parts-${result.sourceName}.csv`, partsToCsv(result))}
                >
                  {t('preflight.findings.exportParts')}
                </Button>
                {stepOverrides.size > 0 && (
                  <Button variant="outline" size="sm" onClick={exportFixed}>
                    {t('preflight.findings.exportFixed', { count: stepOverrides.size })}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {analyzing ? (
                <p className="text-sm text-muted-foreground">{t('preflight.findings.analyzing')}</p>
              ) : findings.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('preflight.findings.empty')}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t('preflight.table.severity')}</TableHead>
                      <TableHead>{t('preflight.table.code')}</TableHead>
                      <TableHead>{t('preflight.table.mark')}</TableHead>
                      <TableHead>{t('preflight.table.message')}</TableHead>
                      <TableHead className="text-right">{t('preflight.table.debug')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {findings.map((finding) => {
                      const part = finding.mark ? partByMark.get(finding.mark) : undefined
                      const viewable = part && (part.step || part.nc) ? part : undefined
                      const override = overrideFor(part)
                      const resolved = Boolean(
                        override && resolvedFindings(override.kind).includes(finding.code),
                      )
                      return (
                        <TableRow
                          key={`${finding.code}-${finding.mark ?? ''}-${finding.message}`}
                          className={cn(resolved && 'opacity-50')}
                        >
                          <TableCell>
                            <Badge variant={SEVERITY_VARIANT[finding.severity]}>
                              {t(`common.severity.${finding.severity}`)}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {finding.code}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{finding.mark ?? '—'}</TableCell>
                          <TableCell>
                            <span className={cn(resolved && 'line-through')}>
                              {findingText(finding)}
                            </span>
                            {resolved && (
                              <Badge variant="success" className="ml-2 align-middle">
                                {override?.kind ? t(`common.fix.${override.kind}`) : ''}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              {resolved && viewable && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => undoOverride(viewable.mark)}
                                >
                                  <Undo2 />
                                  {t('common.actions.undo')}
                                </Button>
                              )}
                              {!resolved && isRegeneratable(viewable) && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={fixingMark === viewable?.mark}
                                  onClick={() => viewable && void regeneratePart(viewable)}
                                >
                                  {fixingMark === viewable?.mark
                                    ? t('common.actions.working')
                                    : t('common.actions.regenerateStep')}
                                </Button>
                              )}
                              {!resolved && isCleanable(viewable) && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={fixingMark === viewable?.mark}
                                  onClick={() => viewable && void cleanPart(viewable)}
                                >
                                  {fixingMark === viewable?.mark
                                    ? t('common.actions.cleaning')
                                    : t('common.actions.clean')}
                                </Button>
                              )}
                              {viewable && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openPart(viewable)}
                                >
                                  <Eye />
                                  {t('common.actions.view')}
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {t('preflight.parts.title')}
                {drawingChecking && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {t('preflight.parts.readingDrawings', {
                      done: drawingDone,
                      total: drawingTotal,
                    })}
                  </span>
                )}
                {checking && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {t('preflight.parts.measuringModels')}
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
                        label={t(column.labelKey)}
                        sortKey={column.key}
                        sort={sort}
                        onSort={toggleSort}
                      />
                    ))}
                    <TableHead className="text-right">{t('preflight.table.threeD')}</TableHead>
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
                        {overrideFor(part) ? (
                          <Badge variant="success">
                            {overrideFor(part)?.kind
                              ? t(`common.fix.${overrideFor(part)?.kind}`)
                              : ''}
                          </Badge>
                        ) : modelChecks.has(part.mark) ? (
                          <span
                            className={
                              modelChecks.get(part.mark)?.ok ? 'text-emerald-400' : 'text-amber-400'
                            }
                          >
                            {formatSizeCheck(t, modelChecks.get(part.mark))}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {part.step || part.nc ? (
                          <div className="flex justify-end gap-1">
                            {overrideFor(part) ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => undoOverride(part.mark)}
                              >
                                <Undo2 />
                                {t('common.actions.undo')}
                              </Button>
                            ) : (
                              <>
                                {isRegeneratable(part) && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={fixingMark === part.mark}
                                    onClick={() => void regeneratePart(part)}
                                  >
                                    {fixingMark === part.mark
                                      ? t('common.actions.working')
                                      : t('common.actions.regenerate')}
                                  </Button>
                                )}
                                {isCleanable(part) && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={fixingMark === part.mark}
                                    onClick={() => void cleanPart(part)}
                                  >
                                    {fixingMark === part.mark
                                      ? t('common.actions.cleaning')
                                      : t('common.actions.clean')}
                                  </Button>
                                )}
                              </>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => openPart(part)}>
                              <Eye />
                              {t('common.actions.view')}
                            </Button>
                          </div>
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
        title={viewing ? t('preflight.viewer.dialogTitle', { mark: viewing.mark }) : undefined}
        className="max-w-6xl"
      >
        {viewing && (viewing.step || viewing.nc) && (
          <>
            <ViewerWarnings
              findings={viewerFindings}
              step={viewing.step}
              fix={{
                override: overrideFor(viewing)?.kind,
                canClean: isCleanable(viewing),
                canRegenerate: isRegeneratable(viewing),
                pending: fixingMark === viewing.mark,
                onClean: () => void cleanPart(viewing),
                onRegenerate: () => void regeneratePart(viewing),
                onUndo: () => undoOverride(viewing.mark),
              }}
            />
            <div className="flex flex-col lg:flex-row">
              <div className="relative h-[45vh] min-h-72 w-full bg-[#0b0f14] lg:h-[70vh] lg:flex-1">
                <Suspense
                  fallback={
                    <div className="grid h-full place-items-center text-sm text-muted-foreground">
                      {t('preflight.viewer.loading')}
                    </div>
                  }
                >
                  {effectiveMode === 'overlay' && manufactured ? (
                    <PartViewer
                      name={`${viewing.mark} · manufactured`}
                      bytes={manufactured}
                      compareBytes={stepBytes}
                      compareLabel={t('preflight.viewer.step')}
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
                        <PaneTag tone="manufactured">
                          {t('preflight.viewer.manufacturedNc')}
                        </PaneTag>
                      </div>
                      <div className="relative h-full border-l border-border">
                        <PartViewer
                          name={viewing.step?.path ?? t('preflight.viewer.stepPath')}
                          bytes={stepBytes}
                          stock={stock}
                          bus={orbitBus}
                          highlightStray
                        />
                        <PaneTag tone="step">{t('preflight.viewer.step')}</PaneTag>
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
                      name={viewing.step?.path ?? t('preflight.viewer.stepPath')}
                      bytes={stepBytes}
                      stock={stock}
                      bus={orbitBus}
                      highlightStray
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
                      {t(preset.labelKey)}
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
                          {t(mode.labelKey)}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="flex h-[45vh] w-full flex-col border-t border-border lg:h-[70vh] lg:flex-1 lg:border-l lg:border-t-0">
                <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
                  {[
                    { id: 'drawing' as const, labelKey: 'preflight.viewer.drawing' },
                    { id: 'nc1' as const, labelKey: 'preflight.viewer.nc1' },
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
                      {t(tab.labelKey)}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {rightTab === 'nc1' && ncBytes ? (
                    <Suspense
                      fallback={
                        <div className="grid h-full place-items-center text-sm text-muted-foreground">
                          {t('preflight.viewer.loadingShort')}
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
                      {t('preflight.viewer.noDrawing')}
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
                {stock.mass
                  ? t('preflight.viewer.greenOutlineMass', {
                      label: stock.label,
                      mass: stock.mass.toFixed(1),
                    })
                  : t('preflight.viewer.greenOutline', { label: stock.label })}
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
  const { t } = useTranslation()
  const pdfLength = material?.length ?? part.expected?.length ?? null
  const pdfQty = material?.qty ?? part.expected?.qty ?? null
  const rows: [string, string][] = [
    [t('preflight.meta.file'), part.step?.path.split('/').pop() ?? '—'],
    [t('preflight.meta.profile'), part.nc?.profile ?? part.expected?.profile ?? '—'],
    [t('preflight.meta.ncLength'), part.nc?.length != null ? `${part.nc.length} mm` : '—'],
    [t('preflight.meta.pdfLength'), pdfLength != null ? `${pdfLength} mm` : '—'],
    [t('preflight.meta.ncQty'), part.nc?.quantity != null ? String(part.nc.quantity) : '—'],
    [t('preflight.meta.pdfQty'), pdfQty != null ? String(pdfQty) : '—'],
    [t('preflight.meta.schema'), part.step?.schema ?? '—'],
    [t('preflight.meta.entities'), part.step ? part.step.entityCount.toLocaleString() : '—'],
  ]
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border px-5 py-4 text-sm sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
          <dd className="font-mono text-xs break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

interface ViewerFix {
  override?: StepFixKind
  canClean: boolean
  canRegenerate: boolean
  pending: boolean
  onClean: () => void
  onRegenerate: () => void
  onUndo: () => void
}

/** Findings + file problems for the viewed part, shown above the 3D so debugging is fast. */
function ViewerWarnings({
  findings,
  step,
  fix,
}: {
  findings: Finding[]
  step?: StepFile
  fix?: ViewerFix
}) {
  const { t } = useTranslation()
  const findingText = (finding: Finding) =>
    t(`findings.${finding.code}`, { ...finding.params, defaultValue: finding.message })
  const invalid = step && !step.valid ? step.problems.join('; ') : null
  const hasFixRow = Boolean(fix?.override || fix?.canClean || fix?.canRegenerate)
  if (findings.length === 0 && !invalid && !hasFixRow) return null
  return (
    <div className="flex flex-col gap-2 border-b border-border bg-card px-5 py-3">
      {findings.map((finding) => {
        const resolved = Boolean(
          fix?.override && resolvedFindings(fix.override).includes(finding.code),
        )
        return (
          <div
            key={`${finding.code}-${finding.message}`}
            className={cn('flex items-start gap-2 text-sm', resolved && 'opacity-50')}
          >
            <Badge variant={SEVERITY_VARIANT[finding.severity]}>
              {t(`common.severity.${finding.severity}`)}
            </Badge>
            <div className="flex flex-col">
              <span className="font-mono text-xs text-muted-foreground">{finding.code}</span>
              <span className={cn(resolved && 'line-through')}>{findingText(finding)}</span>
            </div>
            {resolved && (
              <Badge variant="success" className="ml-auto align-middle">
                {fix?.override ? t(`common.fix.${fix.override}`) : ''}
              </Badge>
            )}
          </div>
        )
      })}
      {invalid && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
          {invalid}
        </div>
      )}
      {fix?.override ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          <span>
            {fix.override === 'cleaned'
              ? t('preflight.warnings.stepCleaned')
              : t('preflight.warnings.stepRegenerated')}
          </span>
          <Button variant="ghost" size="sm" onClick={fix.onUndo}>
            <Undo2 />
            {t('common.actions.undo')}
          </Button>
        </div>
      ) : (
        <>
          {fix?.canClean && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <span>{t('preflight.warnings.strayBodies')}</span>
              <Button variant="outline" size="sm" disabled={fix.pending} onClick={fix.onClean}>
                {fix.pending ? t('common.actions.cleaning') : t('common.actions.cleanStep')}
              </Button>
            </div>
          )}
          {fix?.canRegenerate && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <span>{t('preflight.warnings.ncMismatch')}</span>
              <Button variant="outline" size="sm" disabled={fix.pending} onClick={fix.onRegenerate}>
                {fix.pending ? t('common.actions.working') : t('common.actions.regenerateStep')}
              </Button>
            </div>
          )}
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

function Stat({
  label,
  value,
  tone,
  pending,
}: {
  label: string
  value: number | string
  tone?: Severity
  pending?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-card px-3.5 py-3">
      <span className={cn('text-2xl font-bold tracking-tight', tone && STAT_TONE[tone])}>
        {pending ? '…' : value}
      </span>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  )
}

function Status({ value }: { value: boolean | null }) {
  const { t } = useTranslation()
  if (value === null) return <Badge variant="muted">{t('common.status.missing')}</Badge>
  return (
    <Badge variant={value ? 'success' : 'destructive'}>
      {value ? t('common.status.ok') : t('common.status.bad')}
    </Badge>
  )
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
