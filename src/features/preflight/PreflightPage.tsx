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
import { assessManufacturability } from '@/lib/audit/manufacturability'
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
  type SizeCheck,
  type StepMeasure,
} from '@/lib/step/measure'
import type { SabreResult } from '@/lib/step/sabre'
import { getStepWorkerPool, prebootStepWorkers } from '@/lib/step/stepPool'
import { clearViewerModels, reconstructForViewer } from '@/lib/step/viewerModel'
import { cn } from '@/lib/utils'
import { createOrbitBus, requestView, type ViewPreset } from './orbitSync'

const PartViewer = lazy(() => import('./PartViewer'))
const Nc3dViewer = lazy(() => import('./Nc3dViewer'))

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** How many drawings to parse at once. Matches the pdf.js worker pool size. */
const CONCURRENCY = 6

const PART_COLUMNS: { labelKey: string; key: PartSortKey }[] = [
  { labelKey: 'preflight.columns.mark', key: 'mark' },
  { labelKey: 'preflight.columns.status', key: 'severity' },
  { labelKey: 'preflight.columns.qty', key: 'qty' },
  { labelKey: 'preflight.columns.profile', key: 'profile' },
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

/**
 * A per-part STEP fix the user applied: cleaned (stray bodies dropped) or rebuilt from the NC.
 * There is deliberately no auto "simplify" fix — a sudden uncuttable step is a judgement call
 * (cut at an angle on the radius), so it is flagged as an error and left alone.
 */
type StepFixKind = 'cleaned' | 'regenerated'
interface StepOverride {
  bytes: Uint8Array
  kind: StepFixKind
}

/** A finding an override resolves — greyed out in the list, with an undo. */
function resolvedFindings(kind: StepFixKind): string[] {
  if (kind === 'regenerated')
    return ['STRAY_BODY', 'MANUFACTURE_MISMATCH', 'MANUFACTURE_BORDERLINE']
  return ['STRAY_BODY']
}

/** Grades an NC-vs-STEP mismatch: massive = error, borderline = warning, close = ok. */
function mismatchGrade(comparison: ModelComparison): 'ok' | 'warning' | 'error' {
  if (!comparison.sizeOk) return 'error'
  const delta = Math.abs(comparison.volumeDelta)
  if (delta > 0.1) return 'error'
  if (delta > 0.01) return 'warning'
  return 'ok'
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
  /** Per-part laser-cut manufacturability issues (sudden thickness steps). */
  const [cutIssues, setCutIssues] = useState<Map<string, Finding[]>>(new Map())
  /** Per-part light-sabre test results (can a ~35 mm beam cut each surface in one clean pass?). */
  const [sabreChecks, setSabreChecks] = useState<Map<string, SabreResult>>(new Map())
  const [checking, setChecking] = useState(false)
  /** True from when a job is dropped until the whole analysis (drawings + models) finishes. */
  const [analyzing, setAnalyzing] = useState(false)
  const [drawingMaterials, setDrawingMaterials] = useState<Map<string, DrawingMaterial>>(new Map())
  const [drawingChecking, setDrawingChecking] = useState(false)
  const [drawingDone, setDrawingDone] = useState(0)
  const [drawingTotal, setDrawingTotal] = useState(0)
  /** Progress of the model (OCC) phases: measure + light-sabre, then NC rebuild. */
  const [modelDone, setModelDone] = useState(0)
  const [modelTotal, setModelTotal] = useState(0)
  /** Which model phase the progress counters belong to, so each shows its own label. */
  const [modelPhase, setModelPhase] = useState<'measure' | 'rebuild'>('measure')
  const search = useSearch({ from: '/preflight' })
  const navigate = useNavigate({ from: '/preflight' })
  const filter: Filter = search.severity ?? 'all'

  const setFilter = useCallback(
    (next: Filter) => {
      void navigate({ search: { severity: next }, replace: true })
    },
    [navigate],
  )

  // Boot the OCC worker kernels the moment the page mounts, so the first model (measure / rebuild /
  // viewer mesh) does not wait on the ~23 MB WASM load.
  useEffect(() => {
    prebootStepWorkers()
  }, [])

  const handleBundle = useCallback(
    (input: InputBundle) => {
      setError(null)
      setBundle(input)
      setViewing(null)
      setStepOverrides(new Map())
      setFilter('all')
      setAnalyzing(true)
      clearViewerModels()
      setResult(auditEntries(input.sourceName, input.entries))
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
  // The part's own STEP file, used to give the manufactured model the file's orientation.
  const referenceStepBytes = viewing?.step ? bytesByPath.get(viewing.step.path) : undefined

  // Manufactured model = the stock with the NC applied, rebuilt from the NC (T profiles only).
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  const [manufactured, setManufactured] = useState<Uint8Array | null>(null)
  const [mfgStatus, setMfgStatus] = useState<'idle' | 'pending' | 'failed'>('idle')
  useEffect(() => {
    setManufactured(null)
    if (!ncBytes) {
      setMfgStatus('idle')
      return
    }
    setMfgStatus('pending')
    let cancelled = false
    void reconstructForViewer(new TextDecoder().decode(ncBytes), {
      reference: referenceStepBytes,
    }).then(
      (step) => {
        if (cancelled) return
        if (step) setManufactured(step)
        // reconstruction is best-effort; a null/failed build falls back to the STEP view
        else setMfgStatus('failed')
      },
      () => {
        if (!cancelled) setMfgStatus('failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [ncBytes, referenceStepBytes])

  const hasManufactured = Boolean(manufactured)
  const hasStep = Boolean(stepBytes)
  // The split layout renders straight away — the manufactured pane shows a placeholder
  // until the NC rebuild lands — instead of collapsing to a single STEP view and
  // remounting both viewers when it arrives.
  const mfgFailed = mfgStatus === 'failed'
  const effectiveMode: ViewMode =
    !ncBytes || mfgFailed
      ? 'step'
      : viewMode === 'split' && hasManufactured && !hasStep
        ? 'manufactured'
        : viewMode
  // Both panes stay mounted across mode switches (hidden with CSS, never unmounted),
  // so toggling views reuses the live three.js scenes instead of rebuilding them.
  const mfgPaneActive =
    effectiveMode === 'split' ||
    effectiveMode === 'manufactured' ||
    effectiveMode === 'overlay'
  const stepPaneActive = effectiveMode === 'step' || effectiveMode === 'split'
  const showMfgPane =
    mfgPaneActive && (hasManufactured || (ncBytes != null && mfgStatus === 'pending'))
  const showStepPane = stepPaneActive && hasStep
  const twoPane = showMfgPane && showStepPane

  // One orbit bus per part, shared by the STEP and NC viewports so they rotate together.
  const [orbitBus, setOrbitBus] = useState(() => createOrbitBus())
  const openPart = useCallback((part: PartRecord) => {
    setRightTab('drawing')
    setViewMode('split')
    setOrbitBus(createOrbitBus())
    setViewing(part)
  }, [])

  // Warm the viewer code-split chunks while the analysis runs, so the first
  // "view" click doesn't pay the download on top of the model build.
  useEffect(() => {
    if (!result) return
    void import('./PartViewer')
    void import('./Nc3dViewer')
  }, [result])

  // Read the drawings (ground-truth qty/length) first — parsed concurrently, since pdf.js does the
  // work off-thread. Then the CPU-bound STEP work (measure, light-sabre, NC rebuild) runs across a
  // small pool of OCC workers, off the main thread and in parallel across parts.
  useEffect(() => {
    if (!result) {
      setAnalyzing(false)
      return
    }
    setDrawingMaterials(new Map())
    setDrawingDone(0)
    setDrawingTotal(0)
    setModelDone(0)
    setModelTotal(0)
    setModelChecks(new Map())
    setManufactureChecks(new Map())
    setCutIssues(new Map())
    setSabreChecks(new Map())
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

      // Phase 2: laser-cut manufacturability — sudden thickness changes a single-face sweep
      // can't reach. Cheap (text only), so do it before the heavy model work.
      const issues = new Map<string, Finding[]>()
      for (const part of result.parts) {
        const ncPath = part.nc?.path
        const ncBytes = ncPath ? bytesByPath.get(ncPath) : undefined
        if (!ncBytes) continue
        for (const issue of assessManufacturability(new TextDecoder().decode(ncBytes))) {
          const list = issues.get(part.mark) ?? []
          list.push({
            severity: issue.severity,
            code: issue.code,
            mark: part.mark,
            message: issue.message,
            params: issue.params,
          })
          issues.set(part.mark, list)
        }
      }
      if (cancelled) return
      setCutIssues(issues)

      // Phases 3 & 5: measure each STEP and run the light-sabre test on it. Both need the same
      // imported model, so one worker task does both. Phase 4 rebuilds each part from its NC and
      // measures the result. All of it runs off the main thread across a small worker pool, so the
      // UI stays responsive and independent parts are processed in parallel (~pool-size faster).
      setChecking(true)
      setModelPhase('measure')
      const pool = getStepWorkerPool()
      const checks = new Map<string, SizeCheck>()
      const measures = new Map<string, StepMeasure>()
      const sabre = new Map<string, SabreResult>()

      const stepParts = result.parts.filter(
        (part) => (part.step ? bytesByPath.get(part.step.path) : undefined) != null,
      )
      setModelDone(0)
      setModelTotal(stepParts.length)
      let inspectedCount = 0
      const bumpInspected = () => setModelDone(++inspectedCount)

      await Promise.all(
        result.parts.map(async (part) => {
          const bytes = part.step ? bytesByPath.get(part.step.path) : undefined
          if (!bytes) {
            checks.set(part.mark, { ok: false, error: 'noDims' })
            return
          }
          // Length is compared against the drawing (ground truth) when available.
          const length =
            materials.get(part.mark)?.length ?? part.expected?.length ?? part.nc?.length
          const cross = part.nc?.dimensions?.slice(0, 2) ?? []
          try {
            const inspected = await pool.inspect(bytes)
            if (cancelled) return
            if (inspected.sabre) sabre.set(part.mark, inspected.sabre)
            if (length == null || cross.length < 2) {
              checks.set(part.mark, { ok: false, error: 'noDims' })
            } else if (!inspected.measure) {
              checks.set(part.mark, { ok: false, error: 'measureFailed' })
            } else {
              measures.set(part.mark, inspected.measure)
              checks.set(
                part.mark,
                compareSize(
                  inspected.measure.size,
                  length,
                  cross,
                  inspected.measure.bodies,
                  inspected.measure.extra,
                ),
              )
            }
          } catch {
            checks.set(part.mark, { ok: false, error: 'measureFailed' })
          }
          bumpInspected()
        }),
      )
      if (cancelled) return
      setModelChecks(new Map(checks))

      // Phase 4: does the NC-built geometry match the STEP? Rebuild each part from its NC and
      // compare sizes/volume. Mismatches get an offer to regenerate the STEP (viewer / findings).
      const manufacture = new Map<string, ModelComparison>()
      const rebuildParts = result.parts.filter((part) => {
        const ncBytes = part.nc ? bytesByPath.get(part.nc.path) : undefined
        return ncBytes != null && measures.get(part.mark) != null
      })
      setModelPhase('rebuild')
      setModelDone(0)
      setModelTotal(rebuildParts.length)
      let rebuiltCount = 0
      const bumpRebuilt = () => setModelDone(++rebuiltCount)

      await Promise.all(
        result.parts.map(async (part) => {
          const ncPath = part.nc?.path
          const ncBytes = ncPath ? bytesByPath.get(ncPath) : undefined
          const stepMeasure = measures.get(part.mark)
          if (!ncBytes || !stepMeasure) return
          try {
            const made = await pool.reconstruct(new TextDecoder().decode(ncBytes), {
              measure: true,
            })
            if (cancelled) return
            if (made.measure) {
              manufacture.set(part.mark, compareModels(stepMeasure, made.measure))
              // Cutting straight through (no bevel) detaches piece(s) the STEP keeps attached —
              // the "tiny end piece" that a bevel/angled cut exists to avoid.
              const extra = made.measure.bodies - stepMeasure.bodies
              if (extra > 0) {
                const list = issues.get(part.mark) ?? []
                list.push({
                  severity: 'warning',
                  code: 'CUT_END_PIECE',
                  mark: part.mark,
                  message: `Cutting straight through would detach ${extra} piece(s) the drawing keeps attached — a bevel/angled cut is needed (or leave that surface uncut)`,
                  params: { extra },
                })
                issues.set(part.mark, list)
              }
            }
          } catch {
            // best-effort: skip parts the rebuild can't handle
          }
          bumpRebuilt()
        }),
      )
      if (!cancelled) {
        setManufactureChecks(new Map(manufacture))
        setCutIssues(new Map(issues))
        setSabreChecks(new Map(sabre))
        setChecking(false)
        setAnalyzing(false)
      }
    })()

    return () => {
      cancelled = true
      getStepWorkerPool().abort()
    }
  }, [result, bytesByPath])

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
      const grade = manufacture ? mismatchGrade(manufacture) : 'ok'
      if (manufacture && grade !== 'ok') {
        const note = formatModelComparison(t, manufacture)
        if (grade === 'error') {
          extra.push({
            severity: 'error',
            code: 'MANUFACTURE_MISMATCH',
            mark: part.mark,
            message: `${note} — the model is badly wrong; regenerate the STEP from the NC`,
            params: { note },
          })
        } else {
          extra.push({
            severity: 'warning',
            code: 'MANUFACTURE_BORDERLINE',
            mark: part.mark,
            message: `${note} — borderline (commonly the section's end radii); check before running`,
            params: { note },
          })
        }
      }
      const cut = cutIssues.get(part.mark)
      if (cut) extra.push(...cut)
      const sabre = sabreChecks.get(part.mark)
      if (sabre && !sabre.ok) {
        const area = Math.round(sabre.failures.reduce((sum, f) => sum + f.area, 0))
        extra.push({
          severity: 'error',
          code: 'CUT_SABRE',
          mark: part.mark,
          message: `Light-sabre test failed: a straight ~35 mm beam ends inside the body on ${sabre.failures.length} surface(s) (~${area} mm²) — not manufacturable`,
          params: { count: sabre.failures.length, area },
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
  }, [result, drawingMaterials, modelChecks, manufactureChecks, cutIssues, sabreChecks, t])

  const counts = useMemo(() => {
    const result = { error: 0, warning: 0, info: 0 }
    for (const finding of allFindings) result[finding.severity]++
    return result
  }, [allFindings])

  /** Per-part worst severity, so the table shows clean vs warning/error at a glance. */
  const partSeverity = useMemo(() => {
    const map = new Map<string, { error: number; warning: number }>()
    for (const finding of allFindings) {
      if (!finding.mark) continue
      const current = map.get(finding.mark) ?? { error: 0, warning: 0 }
      if (finding.severity === 'error') current.error++
      else if (finding.severity === 'warning') current.warning++
      map.set(finding.mark, current)
    }
    return map
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

  /** Faces of the viewed part flagged not-manufacturable, so the NC view can draw them red. */
  const viewerBadFaces = useMemo(() => {
    if (!viewing) return []
    const faces = new Set<string>()
    for (const issue of cutIssues.get(viewing.mark) ?? []) {
      for (const face of String(issue.params?.faces ?? '').split(',')) {
        const trimmed = face.trim()
        if (trimmed) faces.add(trimmed)
      }
    }
    return [...faces]
  }, [viewing, cutIssues])

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
        const reference = part.step ? bytesByPath.get(part.step.path) : undefined
        const step = await reconstructForViewer(new TextDecoder().decode(ncBytes), { reference })
        if (step) setOverride(part.mark, step, 'regenerated')
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
        {result && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('preflight.source')}:{' '}
            <span className="font-mono text-foreground">{result.sourceName}</span>
          </p>
        )}
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
                                    : t('common.actions.cleanStep')}
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
                    {t(
                      modelPhase === 'rebuild'
                        ? 'preflight.parts.rebuildingModels'
                        : 'preflight.parts.measuringModels',
                      {
                        done: modelDone,
                        total: modelTotal,
                      },
                    )}
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
                  {sortedParts.map((part) => {
                    const severity = partSeverity.get(part.mark)
                    const errorCount = severity?.error ?? 0
                    const warningCount = severity?.warning ?? 0
                    const material = drawingMaterials.get(part.mark)
                    const pdfQty = material?.qty ?? part.expected?.qty ?? null
                    const ncQty = part.nc?.quantity ?? null
                    const qtyMismatch = pdfQty != null && ncQty != null && pdfQty !== ncQty
                    const qtyFallback = pdfQty == null && ncQty != null
                    return (
                      <TableRow key={part.mark}>
                        <TableCell className="font-mono text-xs">{part.mark}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              errorCount > 0
                                ? 'destructive'
                                : warningCount > 0
                                  ? 'warning'
                                  : 'success'
                            }
                          >
                            {errorCount > 0
                              ? `${t('preflight.status.error')}${errorCount > 1 ? ` ×${errorCount}` : ''}`
                              : warningCount > 0
                                ? `${t('preflight.status.warning')}${warningCount > 1 ? ` ×${warningCount}` : ''}`
                                : t('preflight.status.ok')}
                          </Badge>
                        </TableCell>
                        <TableCell
                          className={cn(qtyMismatch && 'font-semibold text-destructive-foreground')}
                          title={
                            qtyMismatch
                              ? t('preflight.qty.mismatchTitle', { nc: ncQty, pdf: pdfQty })
                              : qtyFallback
                                ? t('preflight.qty.fallbackTitle')
                                : undefined
                          }
                        >
                          {pdfQty ?? ncQty ?? '—'}
                          {qtyMismatch && <span className="ml-1 text-xs">≠ {ncQty}</span>}
                          {qtyFallback && (
                            <span className="ml-1 text-xs text-muted-foreground">(NC)</span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {part.nc?.profile ?? part.expected?.profile ?? '—'}
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
                                modelChecks.get(part.mark)?.ok
                                  ? 'text-emerald-400'
                                  : 'text-amber-400'
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
                                        : t('common.actions.regenerateStep')}
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
                                        : t('common.actions.cleanStep')}
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
                    )
                  })}
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
                  <div className={cn('grid h-full', twoPane ? 'grid-cols-2' : 'grid-cols-1')}>
                    <div className={cn('relative h-full', showMfgPane ? '' : 'hidden')}>
                      {manufactured ? (
                        <PartViewer
                          name={`${viewing.mark} · manufactured`}
                          bytes={manufactured}
                          compareBytes={effectiveMode === 'overlay' ? (stepBytes ?? null) : null}
                          compareLabel={t('preflight.viewer.step')}
                          stock={stock}
                          bus={orbitBus}
                        />
                      ) : (
                        <div className="grid h-full place-items-center px-6 text-center">
                          <p className="max-w-sm text-sm text-muted-foreground">
                            {t('preflight.viewer.buildingManufactured')}
                          </p>
                        </div>
                      )}
                      {twoPane && (
                        <PaneTag tone="manufactured">
                          {t('preflight.viewer.manufacturedNc')}
                        </PaneTag>
                      )}
                    </div>
                    <div
                      className={cn(
                        'relative h-full',
                        showStepPane ? '' : 'hidden',
                        twoPane ? 'border-l border-border' : '',
                      )}
                    >
                      {stepBytes ? (
                        <PartViewer
                          name={viewing.step?.path ?? t('preflight.viewer.stepPath')}
                          bytes={stepBytes}
                          stock={stock}
                          bus={orbitBus}
                          highlightStray
                        />
                      ) : null}
                      {twoPane && <PaneTag tone="step">{t('preflight.viewer.step')}</PaneTag>}
                    </div>
                    {!showMfgPane && !showStepPane && (
                      <div className="grid h-full place-items-center px-6 text-center">
                        <p className="max-w-sm text-sm text-muted-foreground">
                          {t('viewer.noModel')}
                        </p>
                      </div>
                    )}
                  </div>
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
                      <Nc3dViewer bytes={ncBytes} bus={orbitBus} badFaces={viewerBadFaces} />
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
