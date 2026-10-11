import { zipSync } from 'fflate'
import type { TFunction } from 'i18next'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Undo2,
  Wrench,
} from 'lucide-react'
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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
import { Toggle } from '@/components/ui/toggle'
import { auditEntries } from '@/lib/audit/auditJob'
import { findingsToCsv, partsToCsv } from '@/lib/audit/csv'
import { assessCutReach, type CutReachFailure, MAX_CUT_THICKNESS_MM } from '@/lib/audit/cutReach'
import { assessManufacturability } from '@/lib/audit/manufacturability'
import { type PartSortKey, sortParts } from '@/lib/audit/partSort'
import type { AuditResult, Finding, PartRecord, Severity, StepFile } from '@/lib/audit/types'
import { downloadBlob, downloadText } from '@/lib/download'
import { MACHINE } from '@/lib/machine/profile'
import { resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { cutThicknesses } from '@/lib/parsers/ncProject'
import { type DrawingMaterial, resolveDrawingMaterial } from '@/lib/parsers/pdfText'
import type { InputBundle } from '@/lib/readInput'
import { partSectionForCode, resolveStockOutline, type StockOutline } from '@/lib/sections/stock'
import { cleanStep } from '@/lib/step/clean'
import {
  compareGeometry,
  compareModels,
  compareSize,
  type GeometryCheck,
  type ModelComparison,
  type SizeCheck,
  type StepMeasure,
} from '@/lib/step/measure'
import { getStepWorkerPool, PRIORITY_FOREGROUND, prebootStepWorkers } from '@/lib/step/stepPool'
import { clearViewerModels, reconstructForViewer } from '@/lib/step/viewerModel'
import { cn } from '@/lib/utils'
import { DrawingViewer } from './DrawingViewer'
import { NcLegend } from './NcLegend'
import { createOrbitBus, requestLocation } from './orbitSync'

const PartViewer = lazy(() => import('./PartViewer'))

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** Location along the member (mm) a finding sits at, or null when it has none. */
function findingLocationOf(finding: Finding): number | null {
  const raw = finding.params?.x
  return typeof raw === 'number' ? raw : null
}

/** How many drawings to parse at once. Matches the pdf.js worker pool size. */
const CONCURRENCY = 6

/** Per-piece mass bands: red above `MASS_RED_KG`, yellow at/above `MASS_YELLOW_KG`, else green. */
const MASS_RED_KG = 30
const MASS_YELLOW_KG = 20

const PART_COLUMNS: { labelKey: string; key: PartSortKey }[] = [
  { labelKey: 'preflight.columns.mark', key: 'mark' },
  { labelKey: 'preflight.columns.status', key: 'severity' },
  { labelKey: 'preflight.columns.qty', key: 'qty' },
  { labelKey: 'preflight.columns.mass', key: 'mass' },
  { labelKey: 'preflight.columns.profile', key: 'profile' },
  { labelKey: 'preflight.columns.model', key: 'model' },
]

const SEVERITY_VARIANT = {
  error: 'destructive',
  warning: 'warning',
  info: 'info',
} as const

const PREF_PREFIX = '8sme.preflight.'
/** Reads a persisted viewer toggle, falling back to `fallback` when unset or unavailable. */
function readPref(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(PREF_PREFIX + key)
    return stored === null ? fallback : stored === '1'
  } catch {
    return fallback
  }
}
/** Persists a viewer toggle, ignoring storage failures (private mode, quota). */
function writePref(key: string, value: boolean): void {
  try {
    localStorage.setItem(PREF_PREFIX + key, value ? '1' : '0')
  } catch {
    // ignored
  }
}

/**
 * A per-part STEP fix the user applied: cleaned (stray bodies dropped), regenerated from the
 * NC, or simplified (a bevel-cut surface left flat/uncut so a sloped end stays attached).
 * There is deliberately no auto "simplify" fix for CUT_STEP — a sudden uncuttable step is a
 * judgement call (cut at an angle on the radius), so it is flagged as an error and left alone.
 */
type StepFixKind = 'cleaned' | 'regenerated' | 'simplified'
interface StepOverride {
  bytes: Uint8Array
  kind: StepFixKind
}

/** A finding an override resolves — greyed out in the list, with an undo. */
function resolvedFindings(kind: StepFixKind): string[] {
  if (kind === 'regenerated')
    return ['STRAY_BODY', 'MANUFACTURE_MISMATCH', 'MANUFACTURE_BORDERLINE']
  if (kind === 'simplified') return ['CUT_END_PIECE']
  return ['STRAY_BODY']
}

/** The one-click STEP fix a finding code maps to, when the warning is fixable at all. */
type FindingFix = 'clean' | 'regenerate' | 'simplify'
function fixForFinding(code: string): FindingFix | null {
  if (code === 'STRAY_BODY') return 'clean'
  if (code === 'MANUFACTURE_MISMATCH' || code === 'MANUFACTURE_BORDERLINE') return 'regenerate'
  if (code === 'CUT_END_PIECE') return 'simplify'
  return null
}

/** One status pill in the parts table: a distinct finding code, grouped with a count. */
interface StatusPill {
  code: string
  severity: Severity
  count: number
  /** A one-click STEP fix exists for this code (shown with a wrench). */
  fixable: boolean
  /** An applied override already resolves this code. */
  resolved: boolean
  finding: Finding
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
  const { t, i18n } = useTranslation()
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
  /** Per-part STEP geometry cross-checked against the drawing's title-block AREA/WEIGHT. */
  const [geometryChecks, setGeometryChecks] = useState<Map<string, GeometryCheck>>(new Map())
  /** Per-part laser-cut manufacturability issues (sudden thickness steps). */
  const [cutIssues, setCutIssues] = useState<Map<string, Finding[]>>(new Map())
  /** Per-part cut-reach failures (a bevel whose bore exceeds the head's pierce cap). */
  const [reachChecks, setReachChecks] = useState<Map<string, CutReachFailure[]>>(new Map())
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

  // Boot the OCC worker kernels the moment the page mounts, so the first model (measure / rebuild /
  // viewer mesh) does not wait on the ~23 MB WASM load.
  useEffect(() => {
    prebootStepWorkers()
  }, [])

  const handleBundle = useCallback((input: InputBundle) => {
    setError(null)
    setBundle(input)
    setViewing(null)
    setStepOverrides(new Map())
    setAnalyzing(true)
    clearViewerModels()
    setResult(auditEntries(input.sourceName, input.entries))
  }, [])

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

  const viewingPdfBytes = viewing?.pdf ? bytesByPath.get(viewing.pdf.path) : undefined

  const [stepOverrides, setStepOverrides] = useState<Map<string, StepOverride>>(new Map())
  const [fixingMark, setFixingMark] = useState<string | null>(null)
  const ncBytes = viewing?.nc ? bytesByPath.get(viewing.nc.path) : undefined
  const stepBytes = viewing
    ? (stepOverrides.get(viewing.mark)?.bytes ??
      (viewing.step ? bytesByPath.get(viewing.step.path) : undefined))
    : undefined
  // The part's own STEP file, used to give the manufactured model the file's orientation.
  const referenceStepBytes = viewing?.step ? bytesByPath.get(viewing.step.path) : undefined
  // Parsed NC toolpath geometry, projected onto the manufactured model so the cut lines,
  // holes and bevels read on the part the laser actually produces.
  const viewingNcGeom = useMemo(
    () => (ncBytes ? parseNcGeometry(new TextDecoder().decode(ncBytes)) : null),
    [ncBytes],
  )
  // The exact (un-inflated) section the NC was matched against, so the projected toolpath lands
  // on the real manufactured surface rather than the inflated ghost outline.
  const viewingNcSection = useMemo(() => {
    if (!viewing?.nc) return null
    return partSectionForCode(viewing.nc.profile, viewing.nc.dimensions ?? [])?.points ?? null
  }, [viewing])
  // The section face frame, resolved once here so cut markers project on every pane even without
  // the NC toolpath (only the manufactured pane projects the toolpath itself).
  const viewingNcFrame = useMemo(() => {
    if (!viewingNcGeom) return null
    const section = viewingNcSection ?? (Array.isArray(stock?.points) ? stock.points : null)
    if (!section) return null
    return resolveNcFaceFrame(section, viewingNcGeom)
  }, [viewingNcGeom, viewingNcSection, stock])
  // Cut thicknesses present in this part, for the profile legend (same colours the viewer uses).
  const viewingNcProfiles = useMemo(() => {
    if (!viewingNcGeom) return []
    const section = viewingNcSection ?? stock?.points ?? null
    if (!section) return []
    const frame = resolveNcFaceFrame(section, viewingNcGeom)
    return cutThicknesses(frame, section, viewingNcGeom)
  }, [viewingNcGeom, viewingNcSection, stock])
  // The NC only carries etch (`SI`) / marking (`PU`/`KO`) data when those blocks are present.
  const viewingHasMarkings = useMemo(() => {
    if (!ncBytes) return false
    return /(?:^|\n)\s*(?:SI|PU|KO)\s*(?:\n|$)/.test(new TextDecoder().decode(ncBytes))
  }, [ncBytes])

  // Manufactured model = the stock with the NC applied, rebuilt from the NC (T profiles only).
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

  const hasStep = Boolean(stepBytes)
  // The manufactured model counts as ready while it is rebuilding too (a placeholder shows), so
  // the panes don't remount when the NC rebuild lands.
  const mfgReady = Boolean(manufactured) || (ncBytes != null && mfgStatus === 'pending')
  // Every pane that has data is shown. Panes stay mounted (hidden with CSS, never unmounted) so
  // the live three.js scenes are reused rather than rebuilt.
  const stepShown = hasStep
  const manufacturedShown = mfgReady
  const overlayShown = mfgReady && hasStep
  const paneCount = Number(stepShown) + Number(manufacturedShown) + Number(overlayShown)

  // One orbit bus per part, shared by the STEP and NC viewports so they rotate together.
  const [orbitBus, setOrbitBus] = useState(() => createOrbitBus())
  // Bumped when an issue is opened, so the viewers pan/zoom/rotate onto its geometry (`index`
  // picks the specific failing sub-cut of a `CUT_*` finding).
  const [findingFocus, setFindingFocus] = useState<{
    code: string
    token: number
    index?: number
  } | null>(null)
  /** Issue row currently hovered in the list, so its 3D marker can glow (null = none). */
  const [hoverIssueIndex, setHoverIssueIndex] = useState<number | null>(null)
  /** Issue indices the user has shown — their sub-cuts render in the 3D. Default: none. */
  const [shownIssues, setShownIssues] = useState<Set<number>>(new Set())
  /** Live location (mm) of the orbit pivot along the viewed member, shown in the legend bar. */
  const [locationMm, setLocationMm] = useState<number | null>(null)
  /** Editable copy of the location readout: the user can type an mm to jump the view there. */
  const [locationInput, setLocationInput] = useState('')
  const [locationEditing, setLocationEditing] = useState(false)
  /** On-screen angle (deg) of the member's positive axis, for the direction arrow by the field. */
  const [locationAxis, setLocationAxis] = useState(0)
  // Shared overlay toggles, applied to every pane from the one toolbar above the 3D.
  const [showStock, setShowStock] = useState(() => readPref('showStock', false))
  useEffect(() => {
    writePref('showStock', showStock)
  }, [showStock])
  const openPart = useCallback((part: PartRecord) => {
    setOrbitBus(createOrbitBus())
    setFindingFocus(null)
    setHoverIssueIndex(null)
    setShownIssues(new Set())
    setLocationMm(null)
    setLocationInput('')
    setLocationEditing(false)
    setLocationAxis(0)
    setViewing(part)
  }, [])
  const focusFinding = useCallback((finding: Finding) => {
    const raw = finding.params?.index
    const index = typeof raw === 'number' ? raw : undefined
    setFindingFocus((prev) => ({ code: finding.code, token: (prev?.token ?? 0) + 1, index }))
  }, [])
  // Format the live pivot location for display (rounded to whole mm, grouped per locale).
  const formatLocation = useCallback(
    (mm: number) =>
      new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 }).format(Math.round(mm)),
    [i18n.language],
  )

  // Commit a typed location: slide every synced pane to that mm along the member.
  const commitLocation = useCallback(() => {
    setLocationEditing(false)
    const value = Number.parseFloat(locationInput)
    if (Number.isFinite(value)) requestLocation(orbitBus, value)
  }, [locationInput, orbitBus])

  // Warm the viewer code-split chunks while the analysis runs, so the first
  // "view" click doesn't pay the download on top of the model build.
  useEffect(() => {
    if (!result) return
    void import('./PartViewer')
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
    setGeometryChecks(new Map())
    setCutIssues(new Map())
    setReachChecks(new Map())
    let cancelled = false

    const pdfParts = result.parts.filter((part) => {
      const path = part.pdf?.path
      return path != null && bytesByPath.has(path)
    })
    setDrawingTotal(pdfParts.length)
    setDrawingChecking(pdfParts.length > 0)

    void (async () => {
      // Phase 0: laser-cut manufacturability — sudden thickness changes a single-face sweep
      // can't reach, and profile cut-reach (a bevel whose bore is past the head's pierce cap).
      // Both are cheap (NC text + the pure section outline, no OCC), so publish first: bad faces
      // draw red in the NC view even while drawings + models still run.
      const issues = new Map<string, Finding[]>()
      const reach = new Map<string, CutReachFailure[]>()
      /** Records that cut-depth couldn't be assessed for a model, so it never passes silently. */
      const markUnchecked = (mark: string, reason: string, params?: Record<string, string>) => {
        const list = issues.get(mark) ?? []
        list.push({
          severity: 'warning',
          code: 'CUT_REACH_UNCHECKED',
          mark,
          message: `Cut-depth (bevel reach) not assessed: ${reason}`,
          params: { reason, ...params },
        })
        issues.set(mark, list)
      }
      for (const part of result.parts) {
        const ncPath = part.nc?.path
        const ncBytes = ncPath ? bytesByPath.get(ncPath) : undefined
        if (!ncBytes) {
          // Cut-depth is an NC-only test; without an NC there are no cuts to assess.
          if (part.step) markUnchecked(part.mark, 'no NC file')
          continue
        }
        const ncText = new TextDecoder().decode(ncBytes)
        for (const issue of assessManufacturability(ncText)) {
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
        const section = part.nc?.profile
          ? partSectionForCode(part.nc.profile, part.nc.dimensions ?? [])
          : null
        if (!section) {
          const profile = part.nc?.profile ?? '?'
          markUnchecked(part.mark, `unrecognised section ${profile}`, { profile })
          continue
        }
        const failures = assessCutReach(ncText, section.points, section.holes ?? [], {
          toleranceMm: MACHINE.placementToleranceMm,
        })
        if (failures.length > 0) reach.set(part.mark, failures)
      }
      if (cancelled) return
      if (issues.size > 0) setCutIssues(new Map(issues))
      if (reach.size > 0) setReachChecks(new Map(reach))

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

      // Phases 2 & 4: measure each STEP and run the light-sabre test on it. Both need the
      // same imported model, so one worker task does both. Phase 3 rebuilds each part from its
      // NC and measures the result. All of it runs off the main thread across a small worker
      // pool, so the UI stays responsive and independent parts are processed in parallel
      // (~pool-size faster). Results stream per part as they land, so findings/badges show up
      // long before the whole job finishes; viewer (foreground) tasks jump ahead of this queue.
      setChecking(true)
      setModelPhase('measure')
      const pool = getStepWorkerPool()
      const checks = new Map<string, SizeCheck>()
      const measures = new Map<string, StepMeasure>()
      // STEP geometry vs the drawing's title-block AREA/WEIGHT (both derived from the real
      // solid) — a projection-free way to catch geometry that drifted from the drawing.
      const geometries = new Map<string, GeometryCheck>()

      const stepParts = result.parts.filter(
        (part) => (part.step ? bytesByPath.get(part.step.path) : undefined) != null,
      )
      setModelDone(0)
      setModelTotal(stepParts.length)
      let inspectedCount = 0
      const bumpInspected = () => setModelDone(++inspectedCount)
      /** Publish one part's inspect result immediately so its issues visualise upfront. */
      const publishInspect = (mark: string, check: SizeCheck) => {
        checks.set(mark, check)
        setModelChecks(new Map(checks))
        bumpInspected()
      }

      await Promise.all(
        result.parts.map(async (part) => {
          const bytes = part.step ? bytesByPath.get(part.step.path) : undefined
          if (!bytes) {
            if (cancelled) return
            publishInspect(part.mark, { ok: false, error: 'noDims' })
            return
          }
          // Length is compared against the drawing (ground truth) when available.
          const length =
            materials.get(part.mark)?.length ?? part.expected?.length ?? part.nc?.length
          const cross = part.nc?.dimensions?.slice(0, 2) ?? []
          try {
            const inspected = await pool.inspect(bytes)
            if (cancelled) return
            if (length == null || cross.length < 2) {
              publishInspect(part.mark, { ok: false, error: 'noDims' })
            } else if (!inspected.measure) {
              publishInspect(part.mark, { ok: false, error: 'measureFailed' })
            } else {
              measures.set(part.mark, inspected.measure)
              const drawing = materials.get(part.mark)
              if (drawing) {
                geometries.set(part.mark, compareGeometry(inspected.measure, drawing))
                setGeometryChecks(new Map(geometries))
              }
              publishInspect(
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
            if (cancelled) return
            publishInspect(part.mark, { ok: false, error: 'measureFailed' })
          }
        }),
      )
      if (cancelled) return

      // Phase 3: does the NC-built geometry match the STEP? Rebuild each part from its NC and
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
      /** Publish one part's rebuild result immediately (mismatch + end-piece findings). */
      const publishRebuild = (
        mark: string,
        comparison: ModelComparison,
        stepMeasure: StepMeasure,
        madeBodies: number,
      ) => {
        manufacture.set(mark, comparison)
        setManufactureChecks(new Map(manufacture))
        // Cutting straight through (no bevel) detaches piece(s) the STEP keeps attached —
        // the "tiny end piece" that a bevel/angled cut exists to avoid.
        const extra = madeBodies - stepMeasure.bodies
        if (extra > 0) {
          const list = issues.get(mark) ?? []
          list.push({
            severity: 'warning',
            code: 'CUT_END_PIECE',
            mark,
            message: `Cutting straight through would detach ${extra} piece(s) the drawing keeps attached — a bevel/angled cut is needed (or leave that surface uncut)`,
            params: { extra },
          })
          issues.set(mark, list)
          setCutIssues(new Map(issues))
        }
        bumpRebuilt()
      }

      await Promise.all(
        result.parts.map(async (part) => {
          const ncPath = part.nc?.path
          const ncBytes = ncPath ? bytesByPath.get(ncPath) : undefined
          const stepMeasure = measures.get(part.mark)
          if (!ncBytes || !stepMeasure) return
          try {
            const made = await pool.reconstruct(new TextDecoder().decode(ncBytes), {
              measure: true,
              // Only the measure is read below — skip reference orientation and
              // the STEP export (they double rebuild cost for nothing here).
              measureOnly: true,
            })
            if (cancelled) return
            if (made.measure) {
              publishRebuild(
                part.mark,
                compareModels(stepMeasure, made.measure),
                stepMeasure,
                made.measure.bodies,
              )
            } else {
              bumpRebuilt()
            }
          } catch {
            // best-effort: skip parts the rebuild can't handle
            if (cancelled) return
            bumpRebuilt()
          }
        }),
      )
      if (!cancelled) {
        setManufactureChecks(new Map(manufacture))
        setCutIssues(new Map(issues))
        setChecking(false)
        setAnalyzing(false)
      }
    })()

    return () => {
      cancelled = true
      getStepWorkerPool().abort()
    }
  }, [result, bytesByPath])

  /** Marks already fast-tracked for the viewer, so map updates don't re-fire the same work. */
  const fastTrackInFlight = useRef(new Set<string>())
  // On-demand fast-track: the part the user is viewing jumps ahead of the background queue.
  // Meshing/reconstruction for the 3D panes already run at foreground priority via viewerModel;
  // this covers the *analysis* (measure / light-sabre / NC-rebuild comparison) so the viewed
  // part's warnings, red faces and cut lines appear without waiting for the whole job.
  useEffect(() => {
    if (!result || !viewing) return
    const part = result.parts.find((candidate) => candidate.mark === viewing.mark) ?? viewing
    const mark = part.mark
    const stepBytes = part.step ? bytesByPath.get(part.step.path) : undefined
    const ncPath = part.nc?.path
    const ncBytes = ncPath ? bytesByPath.get(ncPath) : undefined
    const needsInspect = stepBytes != null && !modelChecks.has(mark)
    const needsRebuild = ncBytes != null && stepBytes != null && !manufactureChecks.has(mark)
    if ((!needsInspect && !needsRebuild) || fastTrackInFlight.current.has(mark)) return
    fastTrackInFlight.current.add(mark)
    let cancelled = false
    void (async () => {
      try {
        const pool = getStepWorkerPool()
        let measure: StepMeasure | null = null
        if (stepBytes && (needsInspect || needsRebuild)) {
          const inspected = await pool.inspect(stepBytes, { priority: PRIORITY_FOREGROUND })
          if (cancelled) return
          measure = inspected.measure
          const drawing = drawingMaterials.get(mark)
          if (measure && drawing) {
            const checked = compareGeometry(measure, drawing)
            setGeometryChecks((prev) => new Map(prev).set(mark, checked))
          }
          if (needsInspect) {
            const length =
              drawingMaterials.get(mark)?.length ?? part.expected?.length ?? part.nc?.length
            const cross = part.nc?.dimensions?.slice(0, 2) ?? []
            const check: SizeCheck =
              length == null || cross.length < 2
                ? { ok: false, error: 'noDims' }
                : !measure
                  ? { ok: false, error: 'measureFailed' }
                  : compareSize(measure.size, length, cross, measure.bodies, measure.extra)
            setModelChecks((prev) => new Map(prev).set(mark, check))
          }
        }
        if (needsRebuild && ncBytes && measure) {
          const made = await pool.reconstruct(new TextDecoder().decode(ncBytes), {
            measure: true,
            measureOnly: true,
            priority: PRIORITY_FOREGROUND,
          })
          if (cancelled || !made.measure) return
          const comparison = compareModels(measure, made.measure)
          setManufactureChecks((prev) => new Map(prev).set(mark, comparison))
          const extra = made.measure.bodies - measure.bodies
          if (extra > 0) {
            setCutIssues((prev) => {
              const next = new Map(prev)
              const list = next.get(mark) ?? []
              if (!list.some((finding) => finding.code === 'CUT_END_PIECE')) {
                next.set(mark, [
                  ...list,
                  {
                    severity: 'warning' as const,
                    code: 'CUT_END_PIECE',
                    mark,
                    message: `Cutting straight through would detach ${extra} piece(s) the drawing keeps attached — a bevel/angled cut is needed (or leave that surface uncut)`,
                    params: { extra },
                  },
                ])
              }
              return next
            })
          }
        }
      } catch {
        // best-effort: aborted or unmeasurable — the background pass will retry at its turn
      } finally {
        fastTrackInFlight.current.delete(mark)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [result, viewing, bytesByPath, drawingMaterials, modelChecks, manufactureChecks])

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
      const geometry = geometryChecks.get(part.mark)
      if (geometry && !geometry.areaOk) {
        extra.push({
          severity: 'warning',
          code: 'GEOMETRY_AREA_MISMATCH',
          mark: part.mark,
          message: `STEP surface area ${geometry.area.toFixed(2)} m² vs drawing ${geometry.expectedArea} m² — geometry may not match the drawing`,
          params: { step: geometry.area.toFixed(2), drawing: geometry.expectedArea ?? '' },
        })
      }
      if (geometry && !geometry.massOk) {
        extra.push({
          severity: 'warning',
          code: 'GEOMETRY_WEIGHT_MISMATCH',
          mark: part.mark,
          message: `STEP mass ${geometry.mass.toFixed(2)} kg vs drawing ${geometry.expectedMass} kg — geometry may not match the drawing`,
          params: { step: geometry.mass.toFixed(2), drawing: geometry.expectedMass ?? '' },
        })
      }
      const cut = cutIssues.get(part.mark)
      if (cut) extra.push(...cut)
      const reach = reachChecks.get(part.mark)
      if (reach) {
        // One finding per failing sub-cut, so each can be zoomed to individually.
        reach.forEach((failure, index) => {
          const location = {
            index,
            face: failure.face,
            // Location along the member (mid of the sub-cut) — used to group issues by location.
            x: Math.round((failure.from[0] + failure.to[0]) / 2),
            span: failure.spanMm.toFixed(0),
          }
          if (failure.reason === 'corner') {
            const tol = MACHINE.placementToleranceMm
            extra.push({
              severity: 'error',
              code: 'CUT_CORNER',
              mark: part.mark,
              message: `Cut lands on a corner: with the head's ±${tol} mm placement error, ${failure.spanMm.toFixed(0)} mm of the cut on face ${failure.face} can fall on the section's corner radius — the beam meets the curve at a bevel with no flat escape for the slag — not manufacturable`,
              params: { ...location, tol: String(tol) },
            })
          } else {
            extra.push({
              severity: 'error',
              code: 'CUT_DEPTH',
              mark: part.mark,
              message: `Cut can't pass through: ${failure.spanMm.toFixed(0)} mm of the cut on face ${failure.face} needs a ${failure.path.toFixed(0)} mm bore (${failure.bevel.toFixed(0)}° bevel), past the head's ${MAX_CUT_THICKNESS_MM} mm pierce — not manufacturable`,
              params: {
                ...location,
                path: failure.path.toFixed(0),
                bevel: failure.bevel.toFixed(0),
              },
            })
          }
        })
      }
    }
    return [...result.findings, ...extra]
      .filter((finding) => finding.severity !== 'info')
      .sort((a, b) => {
        // Location first (walking the member), located findings before ones with no location, then
        // severity then mark — so the viewer's step-through and pill order follow the beam too.
        const xa = findingLocationOf(a)
        const xb = findingLocationOf(b)
        if (xa != null || xb != null) {
          if (xa == null) return 1
          if (xb == null) return -1
          if (xa !== xb) return xa - xb
        }
        return (
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          (a.mark ?? '').localeCompare(b.mark ?? '')
        )
      })
  }, [
    result,
    drawingMaterials,
    modelChecks,
    manufactureChecks,
    geometryChecks,
    cutIssues,
    reachChecks,
    t,
  ])

  const counts = useMemo(() => {
    const result = { error: 0, warning: 0, info: 0 }
    for (const finding of allFindings) result[finding.severity]++
    return result
  }, [allFindings])

  /** Total pieces across the job (drawing qty is ground truth, then part list, then NC). */
  const totalQty = useMemo(() => {
    if (!result) return 0
    let total = 0
    for (const part of result.parts) {
      const qty =
        drawingMaterials.get(part.mark)?.qty ?? part.expected?.qty ?? part.nc?.quantity ?? 0
      total += qty
    }
    return total
  }, [result, drawingMaterials])

  /** Cumulative cut length in mm (qty × length per mark, drawing length is ground truth). */
  const totalLengthMm = useMemo(() => {
    if (!result) return 0
    let total = 0
    for (const part of result.parts) {
      const qty =
        drawingMaterials.get(part.mark)?.qty ?? part.expected?.qty ?? part.nc?.quantity ?? 0
      const length =
        drawingMaterials.get(part.mark)?.length ?? part.expected?.length ?? part.nc?.length
      if (length != null) total += qty * length
    }
    return total
  }, [result, drawingMaterials])

  /** Per-piece mass (kg): drawing weight is ground truth, then part list, then the measured STEP. */
  const pieceMass = useCallback(
    (part: PartRecord): number | null =>
      drawingMaterials.get(part.mark)?.weight ??
      part.expected?.weight ??
      geometryChecks.get(part.mark)?.mass ??
      null,
    [drawingMaterials, geometryChecks],
  )

  /** Total mass (kg) across the job — the pickup load (qty × per-piece mass). */
  const totalMassKg = useMemo(() => {
    if (!result) return 0
    let total = 0
    for (const part of result.parts) {
      const qty =
        drawingMaterials.get(part.mark)?.qty ?? part.expected?.qty ?? part.nc?.quantity ?? 0
      const mass = pieceMass(part)
      if (mass != null) total += qty * mass
    }
    return total
  }, [result, drawingMaterials, pieceMass])

  /** Per-profile rollup: pieces, cumulative length and mass, so stock/pickup can be planned. */
  const profileGroups = useMemo(() => {
    if (!result) return []
    const map = new Map<
      string,
      { marks: Set<string>; pieces: number; lengthMm: number; massKg: number }
    >()
    for (const part of result.parts) {
      const profile = part.nc?.profile ?? part.expected?.profile ?? '—'
      const entry = map.get(profile) ?? {
        marks: new Set<string>(),
        pieces: 0,
        lengthMm: 0,
        massKg: 0,
      }
      entry.marks.add(part.mark)
      const qty =
        drawingMaterials.get(part.mark)?.qty ?? part.expected?.qty ?? part.nc?.quantity ?? 0
      const length =
        drawingMaterials.get(part.mark)?.length ?? part.expected?.length ?? part.nc?.length
      const mass = pieceMass(part)
      entry.pieces += qty
      if (length != null) entry.lengthMm += qty * length
      if (mass != null) entry.massKg += qty * mass
      map.set(profile, entry)
    }
    return [...map.entries()]
      .map(([profile, entry]) => ({ profile, ...entry, markCount: entry.marks.size }))
      .sort((a, b) => b.lengthMm - a.lengthMm || b.pieces - a.pieces)
  }, [result, drawingMaterials, pieceMass])

  /** One status pill per distinct finding code, so the parts table carries its own triage. */
  const issuesByMark = useMemo(() => {
    const map = new Map<string, StatusPill[]>()
    for (const finding of allFindings) {
      if (!finding.mark) continue
      const override = stepOverrides.get(finding.mark)
      const resolved = Boolean(override && resolvedFindings(override.kind).includes(finding.code))
      const fixable = fixForFinding(finding.code) != null
      const list = map.get(finding.mark) ?? []
      const existing = list.find((pill) => pill.code === finding.code)
      if (existing) {
        existing.count++
        existing.resolved = existing.resolved && resolved
      } else {
        list.push({
          code: finding.code,
          severity: finding.severity,
          count: 1,
          fixable,
          resolved,
          finding,
        })
      }
      map.set(finding.mark, list)
    }
    return map
  }, [allFindings, stepOverrides])

  /** Findings for the part currently open in the viewer, shown above the 3D to debug fast. */
  const viewerFindings = useMemo(
    () => (viewing ? allFindings.filter((finding) => finding.mark === viewing.mark) : []),
    [viewing, allFindings],
  )

  // The right pane swaps between the drawing and the issues list; default to issues when there
  // are any, since that's what needs attention.
  const [rightTab, setRightTab] = useState<'drawing' | 'issues'>('drawing')
  useEffect(() => {
    setRightTab(
      viewing && allFindings.some((finding) => finding.mark === viewing.mark)
        ? 'issues'
        : 'drawing',
    )
  }, [viewing, allFindings])
  /** Indices of the issues whose sub-cuts are shown in the 3D (row toggled on). */
  const visibleSpans = useMemo(
    () => viewerFindings.map((_, index) => index).filter((index) => shownIssues.has(index)),
    [viewerFindings, shownIssues],
  )
  /** Sub-cut index to glow in the 3D while its issue row is hovered (only `CUT_DEPTH` maps to one). */
  const highlightSpan = useMemo(() => {
    if (hoverIssueIndex == null) return null
    const index = viewerFindings[hoverIssueIndex]?.params?.index
    return typeof index === 'number' ? index : null
  }, [viewerFindings, hoverIssueIndex])
  const toggleIssue = useCallback((index: number) => {
    setShownIssues((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])
  const toggleAllIssues = useCallback(() => {
    setShownIssues((prev) =>
      prev.size > 0 ? new Set() : new Set(viewerFindings.map((_, index) => index)),
    )
  }, [viewerFindings])
  /** Row click: toggle the issue's marker, and when turning it on, pan/zoom/rotate onto it. */
  const activateIssue = useCallback(
    (index: number) => {
      const finding = viewerFindings[index]
      const turningOn = !shownIssues.has(index)
      toggleIssue(index)
      // Only issues that sit somewhere on the member move the view; others (CUT_STEP, audit
      // findings) just toggle their marker so they never yank the camera.
      if (turningOn && finding && findingLocationOf(finding) != null) focusFinding(finding)
    },
    [viewerFindings, shownIssues, toggleIssue, focusFinding],
  )

  /** Cut-reach failures of the viewed part — the manufactured view draws the guilty cuts. */
  const viewerSabreFailures = useMemo(() => {
    if (!viewing) return null
    const failures = reachChecks.get(viewing.mark)
    return failures && failures.length > 0 ? failures : null
  }, [viewing, reachChecks])

  // Collapsible sections — long jobs push the tables far down, so profiles
  // and parts collapse like an accordion.
  const [profilesOpen, setProfilesOpen] = useState(true)
  const [partsOpen, setPartsOpen] = useState(true)

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

  /** The parts in table order that have something to show in the viewer — the next/prev ring. */
  const viewableParts = useMemo(
    () => sortedParts.filter((part) => part.step || part.nc),
    [sortedParts],
  )
  const viewingIndex = useMemo(
    () => (viewing ? viewableParts.findIndex((part) => part.mark === viewing.mark) : -1),
    [viewing, viewableParts],
  )
  /** Steps to the previous/next product (mark) in the current sort order. */
  const gotoOffset = useCallback(
    (delta: number) => {
      if (viewingIndex < 0) return
      const next = viewableParts[viewingIndex + delta]
      if (next) openPart(next)
    },
    [viewingIndex, viewableParts, openPart],
  )

  // Arrow keys walk the product list while the viewer is open (never while typing in a field).
  useEffect(() => {
    if (!viewing) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      )
        return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        gotoOffset(-1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        gotoOffset(1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewing, gotoOffset])

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

  /** A part can be simplified when a straight-through cut would detach a bevel-cut end piece. */
  const isSimplifiable = useCallback(
    (part: PartRecord | undefined) =>
      Boolean(
        part?.nc &&
          cutIssues.get(part.mark)?.some((issue) => issue.code === 'CUT_END_PIECE') &&
          stepOverrides.get(part.mark)?.kind !== 'simplified',
      ),
    [cutIssues, stepOverrides],
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

  /**
   * Rebuilds a part's STEP from its NC leaving the bevel-cut surface uncut, so a sloped end the
   * straight-through cut would detach stays attached (resolves CUT_END_PIECE).
   */
  const simplifyPart = useCallback(
    async (part: PartRecord) => {
      const ncPath = part.nc?.path
      const ncBytes = ncPath ? bytesByPath.get(ncPath) : undefined
      if (!ncBytes) return
      setFixingMark(part.mark)
      try {
        const reference = part.step ? bytesByPath.get(part.step.path) : undefined
        const step = await reconstructForViewer(new TextDecoder().decode(ncBytes), {
          reference,
          simplify: true,
        })
        if (step) setOverride(part.mark, step, 'simplified')
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
      </section>

      <DropZone onBundle={handleBundle} onError={setError} />

      {result && (
        <Card>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('preflight.source')}
            </span>
            <span className="font-mono text-lg font-semibold tracking-tight">
              {result.sourceName}
            </span>
          </div>
        </Card>
      )}

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 px-3.5 py-3 text-sm text-destructive-foreground">
          {error}
        </div>
      )}

      {result && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
            <Stat label={t('preflight.stats.parts')} value={result.summary.parts} />
            <Stat label={t('preflight.stats.totalQty')} value={totalQty} />
            <Stat
              label={t('preflight.stats.totalLength')}
              value={totalLengthMm > 0 ? `${(totalLengthMm / 1000).toFixed(1)} m` : '—'}
              pending={analyzing && drawingChecking}
            />
            <Stat
              label={t('preflight.stats.totalMass')}
              value={totalMassKg > 0 ? `${totalMassKg.toFixed(1)} kg` : '—'}
              pending={analyzing && drawingChecking}
            />
            <Stat label={t('preflight.stats.profiles')} value={profileGroups.length} />
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
          </section>

          <Card>
            <CardHeader>
              <button
                type="button"
                onClick={() => setProfilesOpen((open) => !open)}
                aria-expanded={profilesOpen}
                className="flex items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown
                  className={cn(
                    'size-4 shrink-0 text-muted-foreground transition-transform',
                    !profilesOpen && '-rotate-90',
                  )}
                />
                <CardTitle>
                  {t('preflight.profiles.title')}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    ({profileGroups.length})
                  </span>
                </CardTitle>
              </button>
            </CardHeader>
            {profilesOpen && (
              <CardContent>
                {profileGroups.length === 0 ? (
                  <p className="text-sm text-muted-foreground">—</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>{t('preflight.profiles.profile')}</TableHead>
                        <TableHead>{t('preflight.profiles.marks')}</TableHead>
                        <TableHead>{t('preflight.profiles.pieces')}</TableHead>
                        <TableHead className="text-right">
                          {t('preflight.profiles.totalLength')}
                        </TableHead>
                        <TableHead className="text-right">
                          {t('preflight.profiles.totalMass')}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {profileGroups.map((group) => (
                        <TableRow key={group.profile}>
                          <TableCell className="font-mono text-xs">{group.profile}</TableCell>
                          <TableCell>{group.markCount}</TableCell>
                          <TableCell>{group.pieces}</TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {group.lengthMm > 0 ? (
                              `${(group.lengthMm / 1000).toFixed(1)} m`
                            ) : (
                              <span className="text-muted-foreground">
                                {t('preflight.profiles.noLengths')}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {group.massKg > 0 ? (
                              `${group.massKg.toFixed(1)} kg`
                            ) : (
                              <span className="text-muted-foreground">
                                {t('preflight.profiles.noMass')}
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('preflight.source')}:{' '}
                  <span className="font-mono">
                    {result.entriesTotal} {t('preflight.stats.files').toLowerCase()} ·{' '}
                    {t('preflight.stats.partList')}:{' '}
                    {result.summary.hasPartList
                      ? t('preflight.stats.yes')
                      : t('preflight.stats.no')}
                  </span>
                </p>
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between">
              <button
                type="button"
                onClick={() => setPartsOpen((open) => !open)}
                aria-expanded={partsOpen}
                className="flex items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown
                  className={cn(
                    'size-4 shrink-0 text-muted-foreground transition-transform',
                    !partsOpen && '-rotate-90',
                  )}
                />
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {t('preflight.parts.title')}
                  <span className="text-sm font-normal text-muted-foreground">
                    ({sortedParts.length})
                  </span>
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
              </button>
              <div className="flex flex-wrap items-center gap-2">
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
            {partsOpen && (
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
                    </TableRow>
                  </TableHeader>
                  <TableBody className="[&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:z-10 [&_td:first-child]:bg-card">
                    {sortedParts.map((part) => {
                      const material = drawingMaterials.get(part.mark)
                      const pdfQty = material?.qty ?? part.expected?.qty ?? null
                      const ncQty = part.nc?.quantity ?? null
                      const qtyMismatch = pdfQty != null && ncQty != null && pdfQty !== ncQty
                      const qtyFallback = pdfQty == null && ncQty != null
                      const mass =
                        material?.weight ??
                        part.expected?.weight ??
                        geometryChecks.get(part.mark)?.mass ??
                        null
                      const massBand: 'red' | 'yellow' | 'green' | null =
                        mass == null
                          ? null
                          : mass > MASS_RED_KG
                            ? 'red'
                            : mass >= MASS_YELLOW_KG
                              ? 'yellow'
                              : 'green'
                      const pills = issuesByMark.get(part.mark) ?? []
                      return (
                        <TableRow
                          key={part.mark}
                          tabIndex={0}
                          onClick={() => openPart(part)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              openPart(part)
                            }
                          }}
                          className="cursor-pointer outline-none focus-visible:bg-accent/60"
                        >
                          <TableCell className="font-mono text-xs">{part.mark}</TableCell>
                          <TableCell>
                            {pills.length === 0 ? (
                              <Badge variant="success">{t('preflight.status.ok')}</Badge>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {pills.map((pill) => (
                                  <Badge
                                    key={pill.code}
                                    variant={SEVERITY_VARIANT[pill.severity]}
                                    className={cn('gap-1 font-mono', pill.resolved && 'opacity-50')}
                                    title={
                                      findingText(pill.finding) +
                                      (pill.fixable ? ` · ${t('preflight.status.autoFix')}` : '')
                                    }
                                  >
                                    {pill.fixable && (
                                      <Wrench className="size-3 shrink-0" aria-hidden />
                                    )}
                                    {pill.code}
                                    {pill.count > 1 && ` ×${pill.count}`}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </TableCell>
                          <TableCell
                            className={cn(
                              qtyMismatch && 'font-semibold text-destructive-foreground',
                            )}
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
                          <TableCell
                            className={cn(
                              'font-mono text-xs',
                              massBand === 'red' && 'font-semibold text-red-400',
                              massBand === 'yellow' && 'font-semibold text-amber-400',
                              massBand === 'green' && 'text-emerald-400',
                            )}
                            title={
                              massBand === 'red'
                                ? t('preflight.mass.heavy', { kg: MASS_RED_KG })
                                : massBand === 'yellow'
                                  ? t('preflight.mass.medium', { kg: MASS_YELLOW_KG })
                                  : undefined
                            }
                          >
                            {mass != null ? `${mass.toFixed(1)} kg` : '—'}
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
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            )}
          </Card>
        </>
      )}

      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={
          viewing ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <PartSummary part={viewing} material={drawingMaterials.get(viewing.mark)} />
              {viewingIndex >= 0 && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={viewingIndex <= 0}
                    onClick={() => gotoOffset(-1)}
                    aria-label={t('preflight.viewer.prevMark')}
                    title={t('preflight.viewer.prevMark')}
                  >
                    <ChevronLeft />
                  </Button>
                  <span className="text-xs font-normal text-muted-foreground">
                    {viewingIndex + 1} / {viewableParts.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={viewingIndex >= viewableParts.length - 1}
                    onClick={() => gotoOffset(1)}
                    aria-label={t('preflight.viewer.nextMark')}
                    title={t('preflight.viewer.nextMark')}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              )}
            </div>
          ) : undefined
        }
        fullscreen
      >
        {viewing && (viewing.step || viewing.nc) && (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-1.5 text-xs font-medium text-muted-foreground">
                  {stock && (
                    <div className="flex items-center gap-1.5">
                      <Toggle pressed={showStock} onPressedChange={setShowStock}>
                        {t('viewer.stock')}
                      </Toggle>
                    </div>
                  )}
                  {viewingNcGeom && (
                    <div className="flex flex-wrap items-center gap-2">
                      <NcLegend thicknesses={viewingNcProfiles} showMarkings={viewingHasMarkings} />
                    </div>
                  )}
                  {/* Live location of the orbit pivot along the member (the reticle's position);
                      type an mm and press Enter to jump the view there. The arrow points along the
                      member's positive (increasing mm) direction as seen in the 3D. */}
                  <div
                    className="ml-auto flex items-center gap-2 tabular-nums"
                    title={t('preflight.viewer.locationHint')}
                  >
                    <span className="uppercase tracking-wide">
                      {t('preflight.viewer.location')}
                    </span>
                    <div className="flex items-stretch overflow-hidden rounded border border-border bg-background focus-within:border-primary">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={
                          locationEditing
                            ? locationInput
                            : locationMm == null
                              ? ''
                              : formatLocation(locationMm)
                        }
                        onChange={(event) =>
                          setLocationInput(event.target.value.replace(/[^\d.-]/g, ''))
                        }
                        onFocus={(event) => {
                          const field = event.currentTarget
                          setLocationInput(locationMm == null ? '' : String(Math.round(locationMm)))
                          setLocationEditing(true)
                          requestAnimationFrame(() => field.select())
                        }}
                        onBlur={commitLocation}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                        }}
                        placeholder="—"
                        aria-label={t('preflight.viewer.location')}
                        className="w-20 bg-transparent px-1.5 py-0.5 text-right text-xs text-foreground outline-none"
                      />
                      <span className="border-l border-border px-1.5 py-0.5 text-muted-foreground">
                        mm
                      </span>
                    </div>
                    <span
                      className="inline-flex items-center"
                      title={t('preflight.viewer.locationDirection')}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="size-4 text-foreground"
                      >
                        <g transform={`rotate(${locationAxis} 12 12)`}>
                          <line
                            x1="3"
                            y1="12"
                            x2="17"
                            y2="12"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                          <path d="M20.5 12 L13.5 8.2 L13.5 15.8 Z" fill="currentColor" />
                        </g>
                      </svg>
                    </span>
                  </div>
                </div>
                <div className="relative min-h-0 w-full flex-1 bg-[#0b0f14]">
                  <Suspense
                    fallback={
                      <div className="grid h-full place-items-center text-sm text-muted-foreground">
                        {t('preflight.viewer.loading')}
                      </div>
                    }
                  >
                    <div
                      className={cn(
                        'grid h-full auto-rows-fr gap-px bg-border xl:grid-cols-1',
                        paneCount >= 3
                          ? 'grid-cols-3'
                          : paneCount === 2
                            ? 'grid-cols-2'
                            : 'grid-cols-1',
                      )}
                    >
                      {/* 1. STEP — the ideal model. */}
                      <div
                        className={cn('relative h-full bg-[#0b0f14]', stepShown ? '' : 'hidden')}
                      >
                        {stepBytes ? (
                          <PartViewer
                            name={viewing.step?.path ?? t('preflight.viewer.stepPath')}
                            bytes={stepBytes}
                            stock={stock}
                            bus={orbitBus}
                            highlightStray
                            smoothLines
                            focus={findingFocus}
                            // Marks project on every pane (via the shared face frame); only
                            // the manufactured pane also projects the NC toolpath.
                            sabreFailures={viewerSabreFailures}
                            ncSection={viewingNcSection}
                            faceFrame={viewingNcFrame}
                            visibleSpans={visibleSpans}
                            highlight={highlightSpan}
                            showStock={showStock}
                            onShowStockChange={setShowStock}
                            onLocationChange={setLocationMm}
                            onAxisAngleChange={setLocationAxis}
                            hideControls
                          />
                        ) : null}
                        {paneCount > 1 && <PaneTag>{t('preflight.viewer.step')}</PaneTag>}
                      </div>
                      {/* 2. Manufactured — the stock with the NC applied, toolpath projected. */}
                      <div
                        className={cn(
                          'relative h-full bg-[#0b0f14]',
                          manufacturedShown ? '' : 'hidden',
                        )}
                      >
                        {manufactured ? (
                          <PartViewer
                            name={`${viewing.mark} · manufactured`}
                            bytes={manufactured}
                            stock={stock}
                            bus={orbitBus}
                            // The rebuild is oriented to the STEP frame, so the guilty-cut
                            // marks land on what the laser will actually cut — not the ideal.
                            sabreFailures={viewerSabreFailures}
                            nc={viewingNcGeom}
                            ncSection={viewingNcSection}
                            faceFrame={viewingNcFrame}
                            visibleSpans={visibleSpans}
                            highlight={highlightSpan}
                            focus={manufactured ? findingFocus : null}
                            showStock={showStock}
                            onShowStockChange={setShowStock}
                            onLocationChange={stepBytes ? undefined : setLocationMm}
                            onAxisAngleChange={stepBytes ? undefined : setLocationAxis}
                            hideControls
                            smoothLines
                          />
                        ) : (
                          <div className="grid h-full place-items-center px-6 text-center">
                            <p className="max-w-sm text-sm text-muted-foreground">
                              {t('preflight.viewer.buildingManufactured')}
                            </p>
                          </div>
                        )}
                        {paneCount > 1 && <PaneTag>{t('preflight.viewer.manufacturedNc')}</PaneTag>}
                      </div>
                      {/* 3. Overlay — manufactured vs the STEP ideal (red overcut / blue undercut). */}
                      <div
                        className={cn('relative h-full bg-[#0b0f14]', overlayShown ? '' : 'hidden')}
                      >
                        {manufactured && stepBytes ? (
                          <PartViewer
                            name={`${viewing.mark} · overlay`}
                            bytes={manufactured}
                            compareBytes={stepBytes}
                            compareLabel={t('preflight.viewer.step')}
                            stock={stock}
                            bus={orbitBus}
                            focus={findingFocus}
                            sabreFailures={viewerSabreFailures}
                            ncSection={viewingNcSection}
                            faceFrame={viewingNcFrame}
                            visibleSpans={visibleSpans}
                            highlight={highlightSpan}
                            showStock={showStock}
                            onShowStockChange={setShowStock}
                            hideControls
                            smoothLines
                          />
                        ) : null}
                        {paneCount > 1 && <PaneTag>{t('viewer.diff')}</PaneTag>}
                      </div>
                      {paneCount === 0 && (
                        <div className="grid h-full place-items-center px-6 text-center">
                          <p className="max-w-sm text-sm text-muted-foreground">
                            {t('viewer.noModel')}
                          </p>
                        </div>
                      )}
                    </div>
                  </Suspense>
                </div>
              </div>
              <div className="flex h-[60vh] w-full shrink-0 flex-col overflow-hidden border-t border-border xl:h-auto xl:min-h-0 xl:w-[70vw] xl:shrink xl:border-l xl:border-t-0">
                <div className="relative z-10 flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1">
                  {(['drawing', 'issues'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setRightTab(tab)}
                      className={cn(
                        'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                        rightTab === tab
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground hover:bg-accent/50',
                      )}
                    >
                      {tab === 'drawing'
                        ? t('preflight.viewer.drawing')
                        : t('preflight.warnings.issues', { count: viewerFindings.length })}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {rightTab === 'issues' ? (
                    <ViewerWarnings
                      findings={viewerFindings}
                      step={viewing.step}
                      onHover={setHoverIssueIndex}
                      isChecked={(index) => shownIssues.has(index)}
                      onToggleCheck={activateIssue}
                      allShown={shownIssues.size > 0}
                      onToggleAll={toggleAllIssues}
                      fix={{
                        override: overrideFor(viewing)?.kind,
                        canClean: isCleanable(viewing),
                        canRegenerate: isRegeneratable(viewing),
                        canSimplify: isSimplifiable(viewing),
                        pending: fixingMark === viewing.mark,
                        onClean: () => void cleanPart(viewing),
                        onRegenerate: () => void regeneratePart(viewing),
                        onSimplify: () => void simplifyPart(viewing),
                        onUndo: () => undoOverride(viewing.mark),
                      }}
                    />
                  ) : viewingPdfBytes ? (
                    <DrawingViewer bytes={viewingPdfBytes} />
                  ) : (
                    <div className="grid h-full place-items-center px-4 text-center text-sm text-muted-foreground">
                      {t('preflight.viewer.noDrawing')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}

function PartSummary({ part, material }: { part: PartRecord; material?: DrawingMaterial }) {
  const { t } = useTranslation()
  const profile = part.nc?.profile ?? part.expected?.profile ?? '—'
  const qty = material?.qty ?? part.expected?.qty ?? part.nc?.quantity ?? null
  const length = material?.length ?? part.expected?.length ?? part.nc?.length ?? null
  const mass = material?.weight ?? part.expected?.weight ?? null
  const stats: [string, string][] = [
    [t('preflight.columns.profile'), profile],
    [t('preflight.columns.qty'), qty != null ? String(qty) : '—'],
    [t('preflight.meta.length'), length != null ? `${length} mm` : '—'],
    [t('preflight.columns.mass'), mass != null ? `${mass.toFixed(1)} kg` : '—'],
  ]
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span className="text-sm font-semibold">{part.mark}</span>
      {stats.map(([label, value]) => (
        <span key={label} className="flex items-baseline gap-1.5 text-xs">
          <span className="uppercase tracking-wide text-muted-foreground">{label}</span>
          <span className="font-mono text-sm">{value}</span>
        </span>
      ))}
    </div>
  )
}

interface ViewerFix {
  override?: StepFixKind
  canClean: boolean
  canRegenerate: boolean
  canSimplify: boolean
  pending: boolean
  onClean: () => void
  onRegenerate: () => void
  onSimplify: () => void
  onUndo: () => void
}

/** Which fix action a viewer Fix button runs, with its labels. */
function viewerFixAction(
  t: TFunction,
  fix: ViewerFix,
  kind: FindingFix,
): { label: string; pendingLabel: string; run: () => void } {
  if (kind === 'clean')
    return {
      label: t('common.actions.cleanStep'),
      pendingLabel: t('common.actions.cleaning'),
      run: fix.onClean,
    }
  if (kind === 'regenerate')
    return {
      label: t('common.actions.regenerateStep'),
      pendingLabel: t('common.actions.working'),
      run: fix.onRegenerate,
    }
  return {
    label: t('common.actions.simplify'),
    pendingLabel: t('common.actions.working'),
    run: fix.onSimplify,
  }
}

/** Whether the part-level fix behind a finding kind is currently available. */
function viewerFixAvailable(fix: ViewerFix, kind: FindingFix): boolean {
  if (kind === 'clean') return fix.canClean
  if (kind === 'regenerate') return fix.canRegenerate
  return fix.canSimplify
}

/** Findings + file problems for the viewed part, shown above the 3D so debugging is fast. */
function ViewerWarnings({
  findings,
  step,
  fix,
  onHover,
  isChecked,
  onToggleCheck,
  allShown = true,
  onToggleAll,
}: {
  findings: Finding[]
  step?: StepFile
  fix?: ViewerFix
  onHover?: (index: number | null) => void
  isChecked?: (index: number) => boolean
  onToggleCheck?: (index: number) => void
  allShown?: boolean
  onToggleAll?: () => void
}) {
  const { t } = useTranslation()
  // Sortable issues table: defaults to location along the member (grouped by where you'd walk
  // the beam), and can be re-sorted by severity (worst first) or by type (code).
  const [sort, setSort] = useState<{ key: 'severity' | 'code' | 'location'; dir: 1 | -1 }>({
    key: 'location',
    dir: 1,
  })
  const toggleSort = (key: 'severity' | 'code' | 'location') =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  /** Location along the member (mm) a finding sits at, or null when it has none. */
  const locationOf = findingLocationOf
  const rows = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      if (sort.key === 'location') {
        const xa = locationOf(a.finding) ?? Number.POSITIVE_INFINITY
        const xb = locationOf(b.finding) ?? Number.POSITIVE_INFINITY
        const byLocation = xa - xb
        if (byLocation !== 0) return byLocation * sort.dir
        return SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]
      }
      if (sort.key === 'code') {
        const byCode = a.finding.code.localeCompare(b.finding.code)
        if (byCode !== 0) return byCode * sort.dir
        return SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]
      }
      const bySeverity = SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]
      if (bySeverity !== 0) return bySeverity * sort.dir
      return a.finding.code.localeCompare(b.finding.code)
    })
  const findingText = (finding: Finding) =>
    t(`findings.${finding.code}`, { ...finding.params, defaultValue: finding.message })
  /** A sortable column header, with an up/down arrow when it's the active sort. */
  const SortHead = ({ k, label }: { k: 'severity' | 'code' | 'location'; label: string }) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 uppercase transition-colors hover:text-foreground"
      onClick={() => toggleSort(k)}
    >
      {label}
      {sort.key === k &&
        (sort.dir === 1 ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />)}
    </button>
  )
  const invalid = step && !step.valid ? step.problems.join('; ') : null
  const hasFixRow = Boolean(
    fix?.override || fix?.canClean || fix?.canRegenerate || fix?.canSimplify,
  )
  if (findings.length === 0 && !invalid && !hasFixRow) return null
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 bg-card px-4 py-2">
      {findings.length > 0 && (
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          {onToggleAll && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs normal-case tracking-normal"
              onClick={onToggleAll}
            >
              {allShown ? t('preflight.warnings.hideAll') : t('preflight.warnings.showAll')}
            </Button>
          )}
          <span className="font-semibold">
            {t('preflight.warnings.issues', { count: findings.length })}
          </span>
          <span className="font-normal normal-case tracking-normal">
            {errors > 0 && (
              <span className="text-destructive-foreground">
                {t('preflight.warnings.errorCount', { count: errors })}
              </span>
            )}
            {errors > 0 && warnings > 0 && ' · '}
            {warnings > 0 && t('preflight.warnings.warningCount', { count: warnings })}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8" />
              <TableHead className="w-24">
                <SortHead k="severity" label={t('preflight.warnings.colSeverity')} />
              </TableHead>
              <TableHead className="w-28">
                <SortHead k="code" label={t('preflight.warnings.colType')} />
              </TableHead>
              <TableHead className="w-24">
                <SortHead k="location" label={t('preflight.warnings.colLocation')} />
              </TableHead>
              <TableHead>{t('preflight.warnings.colIssue')}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ finding, index }) => {
              const resolved = Boolean(
                fix?.override && resolvedFindings(fix.override).includes(finding.code),
              )
              const fixKind = fix && !resolved ? fixForFinding(finding.code) : null
              const fixable = Boolean(fixKind && fix && viewerFixAvailable(fix, fixKind))
              const action = fixKind && fix ? viewerFixAction(t, fix, fixKind) : null
              return (
                <TableRow
                  key={`${finding.code}-${finding.params?.index ?? finding.message}`}
                  tabIndex={0}
                  onClick={onToggleCheck ? () => onToggleCheck(index) : undefined}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onToggleCheck?.(index)
                    }
                  }}
                  className="cursor-pointer outline-none focus-visible:bg-accent/60"
                  onMouseEnter={onHover ? () => onHover(index) : undefined}
                  onMouseLeave={onHover ? () => onHover(null) : undefined}
                >
                  <TableCell className="py-1">
                    <span
                      title={t('preflight.warnings.toggleIssue')}
                      className={cn(
                        'inline-flex rounded p-0.5',
                        isChecked?.(index) ? 'text-primary' : 'text-muted-foreground',
                      )}
                    >
                      {isChecked?.(index) ? (
                        <Eye className="size-4" />
                      ) : (
                        <EyeOff className="size-4" />
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="py-1">
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                        finding.severity === 'error'
                          ? 'border-destructive/50 bg-destructive/15 text-destructive-foreground'
                          : finding.severity === 'warning'
                            ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                            : 'border-sky-500/50 bg-sky-500/15 text-sky-300',
                      )}
                    >
                      {finding.severity === 'error'
                        ? t('preflight.warnings.sevError')
                        : finding.severity === 'warning'
                          ? t('preflight.warnings.sevWarning')
                          : t('preflight.warnings.sevInfo')}
                    </span>
                  </TableCell>
                  <TableCell className="py-1 font-mono text-[11px]">{finding.code}</TableCell>
                  <TableCell className="py-1 font-mono text-[11px] text-muted-foreground">
                    {locationOf(finding) != null ? `${locationOf(finding)} mm` : '—'}
                  </TableCell>
                  <TableCell
                    className={cn('py-1', resolved && 'line-through', resolved && 'opacity-50')}
                  >
                    {findingText(finding)}
                  </TableCell>
                  <TableCell className="py-1 text-right">
                    {resolved ? (
                      <Badge variant="success">
                        {fix?.override ? t(`common.fix.${fix.override}`) : ''}
                      </Badge>
                    ) : fixable && action ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        disabled={fix?.pending}
                        onClick={(event) => {
                          event.stopPropagation()
                          action.run()
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        {fix?.pending ? action.pendingLabel : action.label}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
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
              : fix.override === 'simplified'
                ? t('preflight.warnings.stepSimplified')
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
          {fix?.canSimplify && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <span>{t('preflight.warnings.cutEndPiece')}</span>
              <Button variant="outline" size="sm" disabled={fix.pending} onClick={fix.onSimplify}>
                {fix.pending ? t('common.actions.working') : t('common.actions.simplify')}
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

function PaneTag({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-2 top-2 z-10 whitespace-nowrap rounded border border-border bg-card/80 px-2 py-0.5 text-[11px] font-medium text-muted-foreground backdrop-blur">
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
