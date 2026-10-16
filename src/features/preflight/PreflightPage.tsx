import { zipSync } from 'fflate'
import type { TFunction } from 'i18next'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Search,
  Undo2,
  Wrench,
  X,
} from 'lucide-react'
import {
  type CSSProperties,
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
import { assessBevelChange, type BevelChangeIssue } from '@/lib/audit/bevelChange'
import { findingsToCsv, partsToCsv } from '@/lib/audit/csv'
import {
  assessCutReach,
  type CutMarker,
  type CutReachFailure,
  MAX_CUT_THICKNESS_MM,
} from '@/lib/audit/cutReach'
import { assessManufacturability } from '@/lib/audit/manufacturability'
import { listedProfile } from '@/lib/audit/partProfile'
import { type PartSortKey, sortParts } from '@/lib/audit/partSort'
import type { AuditResult, Finding, PartRecord, Severity, StepFile } from '@/lib/audit/types'
import { assessUnclosedCuts, type UnclosedCutIssue } from '@/lib/audit/unclosedCuts'
import { downloadBlob, downloadText } from '@/lib/download'
import { MACHINE } from '@/lib/machine/profile'
import { removeCutFromNc, setBevelInNc } from '@/lib/parsers/ncEdit'
import { resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { cutThicknesses } from '@/lib/parsers/ncProject'
import { type DrawingMaterial, resolveDrawingMaterial } from '@/lib/parsers/pdfText'
import type { InputBundle } from '@/lib/readInput'
import type { SectionGuess } from '@/lib/sections/detect'
import {
  partSectionForCode,
  resolveStockOutline,
  type StockOutline,
  sectionMassPerMetre,
} from '@/lib/sections/stock'
import { cleanStep } from '@/lib/step/clean'
import {
  compareGeometry,
  compareModels,
  compareSize,
  type GeometryCheck,
  type ModelComparison,
  type SizeCheck,
  type StepMeasure,
  stepOnlySizeCheck,
} from '@/lib/step/measure'
import {
  getStepWorkerPool,
  PRIORITY_FOREGROUND,
  PRIORITY_NEIGHBOR,
  prebootStepWorkers,
} from '@/lib/step/stepPool'
import {
  clearViewerModels,
  diffForViewer,
  meshForViewer,
  reconstructForViewer,
} from '@/lib/step/viewerModel'
import { cn } from '@/lib/utils'
import { flattenZipEntries } from '@/lib/zip'
import { DrawingViewer } from './DrawingViewer'
import { NcLegend } from './NcLegend'
import { createOrbitBus, requestLocation, requestView, type ViewPreset } from './orbitSync'
import type { DiffStats } from './PartViewer'

const PartViewer = lazy(() => import('./PartViewer'))

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** Location along the member (mm) a finding sits at, or null when it has none. */
function findingLocationOf(finding: Finding): number | null {
  const raw = finding.params?.x
  return typeof raw === 'number' ? raw : null
}

/** Finding codes the viewer draws a 3D cut marker for (and hence the eye can toggle). */
const VISUALISABLE_CODES = new Set([
  'CUT_DEPTH',
  'CUT_CORNER',
  'CUT_BEVEL_CHANGE',
  'CUT_UNCLOSED',
  'CUT_CUTOUT',
])

/**
 * Whether the viewer can point at this finding in 3D. Only the profile cut checks carry a marker
 * `index`; audit/drawing findings (length mismatch, stray bodies, …) have no geometry to show, so
 * they get no eye toggle.
 */
function isVisualisable(finding: Finding): boolean {
  return VISUALISABLE_CODES.has(finding.code) && typeof finding.params?.index === 'number'
}

/** The viewer marker index a finding points at, or null when it has none. */
function markerIndexOf(finding: Finding): number | null {
  const raw = finding.params?.index
  return typeof raw === 'number' ? raw : null
}

/** How many drawings to parse at once. Matches the pdf.js worker pool size. */
const CONCURRENCY = 6

/** Per-piece mass bands: red above `MASS_RED_KG`, yellow at/above `MASS_YELLOW_KG`, else green. */
const MASS_RED_KG = 30
const MASS_YELLOW_KG = 20

/** The head's bevel range (deg); a unify-bevel angle outside it is rejected. */
const MAX_BEVEL_DEG = Math.max(Math.abs(MACHINE.bevel.minDeg), Math.abs(MACHINE.bevel.maxDeg))

/**
 * Confidence a STEP-inferred section must reach before its **real** outline is trusted as the
 * stock ghost. Below this it is treated as an approximate match and the catalogue outline is used.
 */
const SECTION_TRUST_SCORE = 0.9

const PART_COLUMNS: { labelKey: string; key: PartSortKey }[] = [
  { labelKey: 'preflight.columns.mark', key: 'mark' },
  { labelKey: 'preflight.columns.status', key: 'severity' },
  { labelKey: 'preflight.columns.qty', key: 'qty' },
  { labelKey: 'preflight.columns.mass', key: 'mass' },
  { labelKey: 'preflight.columns.profile', key: 'profile' },
  { labelKey: 'preflight.columns.model', key: 'model' },
]

/** How the 2–3 viewer panes are arranged: `auto` picks rows/cols to maximise zoom. */
type PaneLayout = 'auto' | 'rows' | 'cols'

const PANE_LAYOUTS: { id: PaneLayout; labelKey: string }[] = [
  { id: 'auto', labelKey: 'preflight.viewer.layoutAuto' },
  { id: 'rows', labelKey: 'preflight.viewer.layoutRows' },
  { id: 'cols', labelKey: 'preflight.viewer.sideBySide' },
]

/** Camera snaps onto the member's four DSTV faces, for fast drawing comparison. */
const VIEW_PRESETS: { id: ViewPreset; labelKey: string }[] = [
  { id: 'left', labelKey: 'preflight.viewer.left' },
  { id: 'right', labelKey: 'preflight.viewer.right' },
  { id: 'top', labelKey: 'preflight.viewer.top' },
  { id: 'bottom', labelKey: 'preflight.viewer.bottom' },
]

const SEVERITY_VARIANT = {
  error: 'destructive',
  warning: 'warning',
  info: 'info',
} as const

const PREF_PREFIX = '8sme.preflight.'
/**
 * How long to keep the bulk analysis queue paused after a part is opened, so the workers serve the
 * viewer (its meshes, reconstruction and overlay diff) plus the neighbour prefetch before background
 * analysis resumes. Priority only reorders the queue — it cannot preempt an in-flight task — so on a
 * 1–2 worker machine a warm viewer request otherwise still waits behind a multi-second rebuild.
 */
const VIEWER_SETTLE_MS = 600
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
/** Reads a persisted string pref, falling back when unset or unavailable. */
function readPrefString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(PREF_PREFIX + key) ?? fallback
  } catch {
    return fallback
  }
}
/** Persists a string pref, ignoring storage failures (private mode, quota). */
function writePrefString(key: string, value: string): void {
  try {
    localStorage.setItem(PREF_PREFIX + key, value)
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

/**
 * A per-part NC (`.nc1`) edit: a stray cut removed, or a cut line's changing bevel unified to one
 * angle (`0` = no bevel). These override the bundled NC for the manufactured model and the export.
 */
type NcEditKind = 'removeCut' | 'setBevel'
interface NcOverride {
  bytes: Uint8Array
  kind: NcEditKind
  /** For a bevel edit, the unified angle (deg; `0` = no bevel). */
  angle?: number
}

/** A finding an override resolves — greyed out in the list, with an undo. */
function resolvedFindings(kind: StepFixKind): string[] {
  if (kind === 'regenerated')
    return ['STRAY_BODY', 'MANUFACTURE_MISMATCH', 'MANUFACTURE_BORDERLINE']
  if (kind === 'simplified') return ['CUT_END_PIECE']
  return ['STRAY_BODY']
}

/**
 * The one-click fix a finding code maps to, when the warning is fixable at all. `clean` /
 * `regenerate` / `simplify` swap the part's STEP; `removeCut` edits the NC (stripping the flagged
 * cut) and rebuilds the model from it; `setBevel` edits the NC (unifying the cut line's bevel) via
 * a mini menu that offers an angle (prefilled with the recommended one) or no bevel.
 */
type FindingFix = 'clean' | 'regenerate' | 'simplify' | 'removeCut' | 'setBevel'
function fixForFinding(code: string): FindingFix | null {
  if (code === 'STRAY_BODY') return 'clean'
  if (code === 'MANUFACTURE_MISMATCH' || code === 'MANUFACTURE_BORDERLINE') return 'regenerate'
  if (code === 'CUT_END_PIECE') return 'simplify'
  if (code === 'CUT_UNCLOSED' || code === 'CUT_CUTOUT') return 'removeCut'
  if (code === 'CUT_BEVEL_CHANGE') return 'setBevel'
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
  if (!check.measured) return '—'
  const [l, a, b] = check.measured.map((value) => value.toFixed(0))
  const measured = `L${l} × ${a} × ${b}`
  // No expected size to compare against (a STEP-only part) or the check passed: the size stands
  // alone. A body/stray issue is already a Status warning, so it is not repeated here.
  if (!check.expected || check.ok) return measured
  const [el, ea, eb] = check.expected.map((value) => value.toFixed(0))
  return t('preflight.model.sizeMismatch', { measured, expected: `L${el} × ${ea} × ${eb}` })
}

/** Colour for the model-size cell: a STEP-only size is neutral, a real check is pass/fail. */
function sizeCheckTone(check?: SizeCheck): string {
  if (check?.error === 'stepOnly') return 'text-muted-foreground'
  return check?.ok ? 'text-emerald-400' : 'text-amber-400'
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
  /** Marks ticked in the parts table for the selective PDF/STEP/NC export. */
  const [selectedMarks, setSelectedMarks] = useState<Set<string>>(new Set())
  const selectAnchor = useRef<string | null>(null)
  const [modelChecks, setModelChecks] = useState<Map<string, SizeCheck>>(new Map())
  const [manufactureChecks, setManufactureChecks] = useState<Map<string, ModelComparison>>(
    new Map(),
  )
  /** Per-part STEP geometry cross-checked against the drawing's title-block AREA/WEIGHT. */
  const [geometryChecks, setGeometryChecks] = useState<Map<string, GeometryCheck>>(new Map())
  /** Section read from the STEP geometry for parts the job ships without an NC / drawing profile. */
  const [sectionGuesses, setSectionGuesses] = useState<Map<string, SectionGuess>>(new Map())
  /** Member length (mm) read from the STEP bounding box, for parts with no drawing / NC length. */
  const [stepLengths, setStepLengths] = useState<Map<string, number>>(new Map())
  /** Per-part laser-cut manufacturability issues (sudden thickness steps). */
  const [cutIssues, setCutIssues] = useState<Map<string, Finding[]>>(new Map())
  /** Per-part cut-reach failures (a bevel whose bore exceeds the head's pierce cap). */
  const [reachChecks, setReachChecks] = useState<Map<string, CutReachFailure[]>>(new Map())
  /** Per-part bevel-change lines (one cut line whose bevel is not a single angle). */
  const [bevelChanges, setBevelChanges] = useState<Map<string, BevelChangeIssue[]>>(new Map())
  /** Per-part unclosed / stray cuts (a cut that doesn't run edge to edge). */
  const [unclosedCuts, setUnclosedCuts] = useState<Map<string, UnclosedCutIssue[]>>(new Map())
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
    setNcOverrides(new Map())
    setSelectedMarks(new Set())
    selectAnchor.current = null
    setMarkQuery('')
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
    const guess = sectionGuesses.get(viewing.mark)
    // Use the **real** measured outline as the ghost only when the geometry confidently matched a
    // known section (score gate) — otherwise fall back to the catalogue outline.
    const trustedOutline =
      guess && guess.outline && guess.score >= SECTION_TRUST_SCORE
        ? { points: guess.outline.outer, holes: guess.outline.holes }
        : undefined
    void resolveStockOutline(
      viewing,
      pdfBytes,
      guess && { code: guess.code, dims: guess.dims, mass: guess.mass, outline: trustedOutline },
    ).then(
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
  }, [viewing, bytesByPath, sectionGuesses])

  const viewingPdfBytes = viewing?.pdf ? bytesByPath.get(viewing.pdf.path) : undefined

  const [stepOverrides, setStepOverrides] = useState<Map<string, StepOverride>>(new Map())
  /**
   * Per-part NC edits (a stray cut removed). These are the source of truth for the manufactured
   * model and the export: they override the bundled `.nc1` bytes and mark the part export-ready.
   */
  const [ncOverrides, setNcOverrides] = useState<Map<string, NcOverride>>(new Map())
  const [fixingMark, setFixingMark] = useState<string | null>(null)
  /** The `CUT_BEVEL_CHANGE` finding whose "unify bevel" mini menu is open, if any. */
  const [bevelEdit, setBevelEdit] = useState<{ part: PartRecord; finding: Finding } | null>(null)
  /** The menu's angle field (deg); prefilled with the recommended angle. */
  const [bevelAngle, setBevelAngle] = useState('')
  const ncBytes = viewing?.nc
    ? (ncOverrides.get(viewing.mark)?.bytes ?? bytesByPath.get(viewing.nc.path))
    : undefined
  const stepBytes = viewing
    ? (stepOverrides.get(viewing.mark)?.bytes ??
      (viewing.step ? bytesByPath.get(viewing.step.path) : undefined))
    : undefined
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
    return resolveNcFaceFrame(section, viewingNcGeom, viewing?.nc?.profile)
  }, [viewingNcGeom, viewingNcSection, stock, viewing])
  // Cut thicknesses present in this part, for the profile legend (same colours the viewer uses).
  const viewingNcProfiles = useMemo(() => {
    if (!viewingNcGeom) return []
    const section = viewingNcSection ?? stock?.points ?? null
    if (!section) return []
    const frame = resolveNcFaceFrame(section, viewingNcGeom, viewing?.nc?.profile)
    return cutThicknesses(frame, section, viewingNcGeom)
  }, [viewingNcGeom, viewingNcSection, stock, viewing])
  // STEP cut-edge colouring: the ideal model's cut edges on the side/top faces, keyed to the same
  // thickness legend. `profile` lets the viewer resolve the target faces for the right family.
  const viewingProfileCode = viewing?.nc?.profile ?? null
  const viewingCutEdgeOptions = useMemo(
    () => ({
      thicknesses: viewingNcProfiles,
      profile: viewingProfileCode,
      radius: viewing?.nc?.dimensions?.[4] ?? 0,
    }),
    [viewingNcProfiles, viewingProfileCode, viewing],
  )
  // The NC only carries etch (`SI`) / marking (`PU`/`KO`) data when those blocks are present.
  const viewingHasMarkings = useMemo(() => {
    if (!ncBytes) return false
    return /(?:^|\n)\s*(?:SI|PU|KO)\s*(?:\n|$)/.test(new TextDecoder().decode(ncBytes))
  }, [ncBytes])
  // The viewed member's total length (mm), reported by the 3D viewer, so the direction arrow can
  // carry a marker showing where along the body the orbit pivot currently sits.
  const [viewingLength, setViewingLength] = useState<number | null>(null)

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
    void reconstructForViewer(new TextDecoder().decode(ncBytes)).then(
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
  }, [ncBytes])

  // Kick off the overlay diff as soon as the manufactured model lands, so it is already computed
  // (in the OCC worker) by the time the overlay pane mounts — the viewer then reads it from cache
  // instead of showing an empty pane for the seconds the boolean takes. The stock profile is the
  // same seating the viewer applies; the diff must not reorient on its own.
  useEffect(() => {
    if (!manufactured || !stepBytes) return
    void diffForViewer(manufactured, stepBytes, {
      profile: stock?.points,
      priority: PRIORITY_FOREGROUND,
    }).catch(() => {})
  }, [manufactured, stepBytes, stock])

  // While a part is open (or being opened), hold the background analysis queue so the workers serve
  // the viewer and its neighbour prefetch instead of a multi-second rebuild. Resumes once the
  // manufactured model has settled (or at once when there is nothing to build), after a short settle
  // so rapid right/left navigation never lets analysis back in mid-burst.
  useEffect(() => {
    const pool = getStepWorkerPool()
    if (!viewing) {
      // No part open — let the background analysis run.
      pool.resumeBackground()
      return
    }
    pool.pauseBackground()
    const building = ncBytes != null && manufactured == null && mfgStatus === 'pending'
    if (building) return
    const id = window.setTimeout(() => pool.resumeBackground(), VIEWER_SETTLE_MS)
    return () => window.clearTimeout(id)
  }, [viewing, ncBytes, manufactured, mfgStatus])

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

  // How the viewer panes are stacked. Persisted, so the operator's choice sticks across marks.
  const [paneLayout, setPaneLayout] = useState<PaneLayout>(() => {
    const stored = readPrefString('paneLayout', 'auto')
    return stored === 'rows' || stored === 'cols' ? stored : 'auto'
  })
  useEffect(() => {
    writePrefString('paneLayout', paneLayout)
  }, [paneLayout])
  // The last camera view snapped to (for the button highlight). Cleared on a manual orbit via the
  // bus — see the effect below — and on opening a part.
  const [activeView, setActiveView] = useState<ViewPreset | null>(null)

  // The overlay pane's diff result, lifted so the shared legend strip can show the overcut/undercut
  // key. Null while the boolean is still building.
  const [mfgDiff, setMfgDiff] = useState<DiffStats | null>(null)

  // Draggable 3D ↔ drawing/issues split (fraction of the row given to the right panel).
  const [rightPct, setRightPct] = useState(50)
  const [splitting, setSplitting] = useState(false)
  const splitRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!splitting) return
    const move = (event: PointerEvent): void => {
      const el = splitRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width === 0) return
      const pct = ((rect.right - event.clientX) / rect.width) * 100
      setRightPct(Math.min(80, Math.max(20, pct)))
    }
    const stop = (): void => setSplitting(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
  }, [splitting])

  // The part's length-to-cross-section ratio: a long beam reads as one wide side view (which fills
  // full-width stacked rows at the largest zoom), a stubby part as a boxy shape (which fills
  // side-by-side columns). Only the two stacked layouts are considered, so the choice is stable
  // while orbiting.
  const crossExtent = useMemo(() => {
    const points = stock?.points
    if (!points?.length) return null
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const [x, y] of points) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    return Math.max(maxX - minX, maxY - minY) || null
  }, [stock])
  const modelAspect = viewingLength && crossExtent ? viewingLength / crossExtent : null

  // The available pane area's aspect (width/height), measured on the grid itself. `auto` picks the
  // layout whose per-pane shape best matches the part — the one that fits the model largest.
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null)
  const [gridAspect, setGridAspect] = useState<number | null>(null)
  useEffect(() => {
    if (!gridEl) return
    const measure = () => {
      const width = gridEl.clientWidth
      const height = gridEl.clientHeight
      setGridAspect(width > 0 && height > 0 ? width / height : null)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(gridEl)
    return () => observer.disconnect()
  }, [gridEl])
  // `rows` puts each pane full-width (wide, short — good for a long beam side view); `cols` stacks
  // them side by side (tall, narrow — good for a compact part). Ties fall to columns.
  const resolvedLayout: 'rows' | 'cols' =
    paneLayout === 'rows' || paneLayout === 'cols'
      ? paneLayout
      : modelAspect != null && gridAspect != null && modelAspect >= gridAspect
        ? 'rows'
        : 'cols'

  // One orbit bus per part, shared by the STEP and NC viewports so they rotate together.
  const [orbitBus, setOrbitBus] = useState(() => createOrbitBus())
  // Drop the view-button highlight once the operator free-orbits: a preset broadcast keeps
  // `bus.preset` set, while a manual drag clears it before notifying, so the flag tells them apart.
  useEffect(() => {
    const sync = (): void => {
      if (!orbitBus.preset) setActiveView(null)
    }
    orbitBus.listeners.add(sync)
    return () => {
      orbitBus.listeners.delete(sync)
    }
  }, [orbitBus])
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
  const [showGrid, setShowGrid] = useState(() => readPref('showGrid', true))
  useEffect(() => {
    writePref('showGrid', showGrid)
  }, [showGrid])
  const openPart = useCallback((part: PartRecord) => {
    setOrbitBus(createOrbitBus())
    setFindingFocus(null)
    setHoverIssueIndex(null)
    setShownIssues(new Set())
    setLocationMm(null)
    setLocationInput('')
    setLocationEditing(false)
    setLocationAxis(0)
    setViewingLength(null)
    setActiveView(null)
    setMfgDiff(null)
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

  // The viewer reports the orbit pivot's mm along the member and the member's total length, so the
  // direction arrow can show where along the body we are looking.
  const handleLocation = useCallback((mm: number, lengthMm: number) => {
    setLocationMm(mm)
    setViewingLength(lengthMm)
  }, [])

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
    setSectionGuesses(new Map())
    setStepLengths(new Map())
    setCutIssues(new Map())
    setReachChecks(new Map())
    setBevelChanges(new Map())
    setUnclosedCuts(new Map())
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
      const bevel = new Map<string, BevelChangeIssue[]>()
      const unclosed = new Map<string, UnclosedCutIssue[]>()
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
        const bevelIssues = assessBevelChange(ncText)
        if (bevelIssues.length > 0) bevel.set(part.mark, bevelIssues)
        const section = part.nc?.profile
          ? partSectionForCode(part.nc.profile, part.nc.dimensions ?? [])
          : null
        const unclosedIssues = assessUnclosedCuts(ncText, {
          section: section?.points,
          profile: part.nc?.profile,
        })
        if (unclosedIssues.length > 0) unclosed.set(part.mark, unclosedIssues)
        if (!section) {
          const profile = part.nc?.profile ?? '?'
          markUnchecked(part.mark, `unrecognised section ${profile}`, { profile })
          continue
        }
        const failures = assessCutReach(ncText, section.points, section.holes ?? [], {
          toleranceMm: MACHINE.placementToleranceMm,
          profile: part.nc?.profile,
        })
        if (failures.length > 0) reach.set(part.mark, failures)
      }
      if (cancelled) return
      if (issues.size > 0) setCutIssues(new Map(issues))
      if (reach.size > 0) setReachChecks(new Map(reach))
      if (bevel.size > 0) setBevelChanges(new Map(bevel))
      if (unclosed.size > 0) setUnclosedCuts(new Map(unclosed))

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
      // STEP geometry vs the drawing's title-block WEIGHT (derived from the real solid) — a
      // projection-free way to catch geometry that drifted from the drawing.
      const geometries = new Map<string, GeometryCheck>()
      // Sections read from the STEP cross-section, for parts with neither an NC nor a part-list
      // profile (the STEP-only job).
      const sections = new Map<string, SectionGuess>()
      // Member length from the STEP bounding box (its longest extent), for the same STEP-only case.
      const lengths = new Map<string, number>()

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
          // No NC and no part list? The section can only come from the geometry.
          const needSection = !listedProfile(part)
          try {
            const inspected = await pool.inspect(bytes, { detectSection: needSection })
            if (cancelled) return
            if (inspected.section) {
              sections.set(part.mark, inspected.section)
              setSectionGuesses(new Map(sections))
            }
            // Record the measured mass whenever the STEP measured, even without NC dims: a
            // STEP-only part has no `length`/`cross`, yet its volume × steel density is exactly
            // the display mass (see `pieceMass`). The size check needs dims, so it stays gated.
            if (inspected.measure) {
              measures.set(part.mark, inspected.measure)
              lengths.set(part.mark, Math.max(...inspected.measure.size))
              setStepLengths(new Map(lengths))
              geometries.set(
                part.mark,
                compareGeometry(inspected.measure, materials.get(part.mark) ?? {}),
              )
              setGeometryChecks(new Map(geometries))
            }
            if (length == null || cross.length < 2) {
              publishInspect(
                part.mark,
                inspected.measure
                  ? stepOnlySizeCheck(inspected.measure)
                  : { ok: false, error: 'noDims' },
              )
            } else if (!inspected.measure) {
              publishInspect(part.mark, { ok: false, error: 'measureFailed' })
            } else {
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
              // Only the measure is read below — skip the STEP export (it doubles rebuild cost
              // for nothing here).
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
  // part's warnings, red faces and cut lines appear without waiting for the whole job. The same
  // routine prewarms a viewed part's neighbours at a lower priority (see the neighbour effect).
  const fastTrackPart = useCallback(
    (part: PartRecord, priority: number) => {
      const mark = part.mark
      const stepBytes = part.step ? bytesByPath.get(part.step.path) : undefined
      const ncPath = part.nc?.path
      const ncBytes = ncPath ? bytesByPath.get(ncPath) : undefined
      const needsInspect = stepBytes != null && !modelChecks.has(mark)
      const needsRebuild = ncBytes != null && stepBytes != null && !manufactureChecks.has(mark)
      if ((!needsInspect && !needsRebuild) || fastTrackInFlight.current.has(mark)) return
      fastTrackInFlight.current.add(mark)
      void (async () => {
        try {
          const pool = getStepWorkerPool()
          let measure: StepMeasure | null = null
          if (stepBytes && (needsInspect || needsRebuild)) {
            const needSection = !listedProfile(part)
            const inspected = await pool.inspect(stepBytes, {
              priority,
              detectSection: needSection,
            })
            measure = inspected.measure
            if (inspected.section) {
              setSectionGuesses((prev) =>
                new Map(prev).set(mark, inspected.section as SectionGuess),
              )
            }
            if (measure) {
              const checked = compareGeometry(measure, drawingMaterials.get(mark) ?? {})
              setGeometryChecks((prev) => new Map(prev).set(mark, checked))
              const stepLength = Math.max(...measure.size)
              setStepLengths((prev) => new Map(prev).set(mark, stepLength))
            }
            if (needsInspect) {
              const length =
                drawingMaterials.get(mark)?.length ?? part.expected?.length ?? part.nc?.length
              const cross = part.nc?.dimensions?.slice(0, 2) ?? []
              const check: SizeCheck =
                length == null || cross.length < 2
                  ? measure
                    ? stepOnlySizeCheck(measure)
                    : { ok: false, error: 'noDims' }
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
              priority,
            })
            if (!made.measure) return
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
    },
    [bytesByPath, drawingMaterials, modelChecks, manufactureChecks],
  )
  useEffect(() => {
    if (!result || !viewing) return
    fastTrackPart(
      result.parts.find((candidate) => candidate.mark === viewing.mark) ?? viewing,
      PRIORITY_FOREGROUND,
    )
  }, [result, viewing, fastTrackPart])

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
      const bevel = bevelChanges.get(part.mark)
      if (bevel) {
        // One finding per changing cut line. Their 3D marker indices continue after the reach
        // failures, matching the combined marker list the viewer draws (`viewerSabreFailures`).
        const base = reach?.length ?? 0
        bevel.forEach((issue, index) => {
          extra.push({
            severity: issue.severity,
            code: issue.code,
            mark: part.mark,
            message: issue.message,
            params: { ...issue.params, index: base + index },
          })
        })
      }
      const unclosed = unclosedCuts.get(part.mark)
      if (unclosed) {
        // One warning per stray cut. Their marker indices continue after reach + bevel, matching
        // the combined list `viewerSabreFailures` builds.
        const base = (reach?.length ?? 0) + (bevel?.length ?? 0)
        unclosed.forEach((issue, index) => {
          extra.push({
            severity: issue.severity,
            code: issue.code,
            mark: part.mark,
            message: issue.message,
            params: { ...issue.params, index: base + index },
          })
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
    bevelChanges,
    unclosedCuts,
    t,
  ])

  const counts = useMemo(() => {
    const result = { error: 0, warning: 0, info: 0 }
    for (const finding of allFindings) result[finding.severity]++
    return result
  }, [allFindings])

  /**
   * Pieces for a mark: drawing qty is ground truth, then the part list, then the NC batch qty.
   * A part with none of those (a bare STEP-only article) is a single piece.
   */
  const partQty = useCallback(
    (part: PartRecord): number =>
      drawingMaterials.get(part.mark)?.qty ?? part.expected?.qty ?? part.nc?.quantity ?? 1,
    [drawingMaterials],
  )

  /**
   * The part's length (mm): drawing is ground truth, then the part list, then the NC, and finally
   * the STEP bounding box's longest extent — so a STEP-only job still reports a length.
   */
  const partLength = useCallback(
    (part: PartRecord): number | null =>
      drawingMaterials.get(part.mark)?.length ??
      part.expected?.length ??
      part.nc?.length ??
      stepLengths.get(part.mark) ??
      null,
    [drawingMaterials, stepLengths],
  )

  /** Total pieces across the job (drawing qty is ground truth, then part list, then NC). */
  const totalQty = useMemo(() => {
    if (!result) return 0
    let total = 0
    for (const part of result.parts) total += partQty(part)
    return total
  }, [result, partQty])

  /** Cumulative cut length in mm (qty × length per mark, drawing length is ground truth). */
  const totalLengthMm = useMemo(() => {
    if (!result) return 0
    let total = 0
    for (const part of result.parts) {
      const length = partLength(part)
      if (length != null) total += partQty(part) * length
    }
    return total
  }, [result, partLength, partQty])

  /**
   * Per-piece mass (kg) for display. The drawing / part-list WEIGHT is ground truth. When neither
   * carries one, estimate from the section: nominal mass per metre (from the NC profile, or the
   * section read off the STEP geometry) × length. This shows mass the moment parsing finishes,
   * without waiting on the exact STEP volume integration — which is still run per part for the
   * `GEOMETRY_WEIGHT_MISMATCH` safety check (see `compareGeometry`). The measured mass is only a
   * last resort when no section is known.
   */
  const pieceMass = useCallback(
    (part: PartRecord): number | null => {
      const material = drawingMaterials.get(part.mark)
      const groundTruth = material?.weight ?? part.expected?.weight
      if (groundTruth != null) return groundTruth

      const profile = listedProfile(part)
      const perMetre =
        profile != null
          ? sectionMassPerMetre(profile, part.nc?.dimensions ?? [])
          : (sectionGuesses.get(part.mark)?.mass ?? null)
      const length = material?.length ?? part.expected?.length ?? part.nc?.length ?? null
      if (perMetre != null && length != null) return (perMetre * length) / 1000

      return geometryChecks.get(part.mark)?.mass ?? null
    },
    [drawingMaterials, sectionGuesses, geometryChecks],
  )

  /**
   * The part's section label: the NC / part-list profile when present, else the section read from
   * the STEP geometry (the STEP-only fallback).
   */
  const sectionLabel = useCallback(
    (part: PartRecord): string =>
      // NC / part-list code → section read from STEP geometry.
      listedProfile(part) ?? sectionGuesses.get(part.mark)?.label ?? '—',
    [sectionGuesses],
  )

  /** Total mass (kg) across the job — the pickup load (qty × per-piece mass). */
  const totalMassKg = useMemo(() => {
    if (!result) return 0
    let total = 0
    for (const part of result.parts) {
      const mass = pieceMass(part)
      if (mass != null) total += partQty(part) * mass
    }
    return total
  }, [result, pieceMass, partQty])

  /** Per-profile rollup: pieces, cumulative length and mass, so stock/pickup can be planned. */
  const profileGroups = useMemo(() => {
    if (!result) return []
    const map = new Map<
      string,
      { marks: Set<string>; pieces: number; lengthMm: number; massKg: number }
    >()
    for (const part of result.parts) {
      const profile = sectionLabel(part)
      const entry = map.get(profile) ?? {
        marks: new Set<string>(),
        pieces: 0,
        lengthMm: 0,
        massKg: 0,
      }
      entry.marks.add(part.mark)
      const qty = partQty(part)
      const length = partLength(part)
      const mass = pieceMass(part)
      entry.pieces += qty
      if (length != null) entry.lengthMm += qty * length
      if (mass != null) entry.massKg += qty * mass
      map.set(profile, entry)
    }
    return [...map.entries()]
      .map(([profile, entry]) => ({ profile, ...entry, markCount: entry.marks.size }))
      .sort((a, b) => b.lengthMm - a.lengthMm || b.pieces - a.pieces)
  }, [result, pieceMass, sectionLabel, partQty, partLength])

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
  /** Marker indices whose sub-cuts are shown in the 3D (row toggled on). */
  const visibleSpans = useMemo(
    () =>
      viewerFindings
        .map((finding, index) => ({ finding, index }))
        .filter(({ index }) => shownIssues.has(index))
        .map(({ finding }) => markerIndexOf(finding))
        .filter((value): value is number => value != null),
    [viewerFindings, shownIssues],
  )
  /** Sub-cut index to glow in the 3D while its issue row is hovered (only cut checks map to one). */
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
      prev.size > 0
        ? new Set()
        : new Set(
            viewerFindings
              .map((finding, index) => ({ finding, index }))
              .filter(({ finding }) => isVisualisable(finding))
              .map(({ index }) => index),
          ),
    )
  }, [viewerFindings])
  /** Row click: toggle the issue's marker, and when turning it on, pan/zoom/rotate onto it. */
  const activateIssue = useCallback(
    (index: number) => {
      const finding = viewerFindings[index]
      // Only findings with a 3D marker are interactive; the rest have no eye.
      if (!finding || !isVisualisable(finding)) return
      const turningOn = !shownIssues.has(index)
      toggleIssue(index)
      if (turningOn && findingLocationOf(finding) != null) focusFinding(finding)
    },
    [viewerFindings, shownIssues, toggleIssue, focusFinding],
  )

  /**
   * Cut markers of the viewed part — the manufactured view draws the guilty cuts. Cut-reach
   * failures come first, then the bevel-change lines, so a finding's `params.index` (assigned in
   * the same order in `allFindings`) picks the right marker.
   */
  const viewerSabreFailures = useMemo<CutMarker[] | null>(() => {
    if (!viewing) return null
    const markers: CutMarker[] = [...(reachChecks.get(viewing.mark) ?? [])]
    for (const issue of bevelChanges.get(viewing.mark) ?? []) {
      // A changing bevel is an NC-specific error: it only reads on the manufactured model, so the
      // viewer draws it there alone (see `CutMarker.ncOnly`).
      markers.push({
        face: issue.face,
        from: issue.from,
        to: issue.to,
        lines: issue.lines,
        ncOnly: true,
      })
    }
    for (const issue of unclosedCuts.get(viewing.mark) ?? []) {
      markers.push({
        face: issue.face,
        from: issue.from,
        to: issue.to,
        lines: issue.lines,
        color: issue.color,
      })
    }
    return markers.length > 0 ? markers : null
  }, [viewing, reachChecks, bevelChanges, unclosedCuts])

  // Collapsible sections — long jobs push the tables far down, so profiles
  // and parts collapse like an accordion.
  const [profilesOpen, setProfilesOpen] = useState(true)
  const [partsOpen, setPartsOpen] = useState(true)

  // Parts table sorting — defaults to worst-problem-first so triage is quick.
  const [sort, setSort] = useState<{ key: PartSortKey; dir: 1 | -1 }>({ key: 'severity', dir: 1 })
  const toggleSort = useCallback((key: PartSortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  }, [])
  /** Free-text filter on the part mark, so a long job can be narrowed to the piece at hand. */
  const [markQuery, setMarkQuery] = useState('')
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
  /** The sorted parts narrowed by the mark search (case-insensitive substring). */
  const visibleParts = useMemo(() => {
    const query = markQuery.trim().toLowerCase()
    if (!query) return sortedParts
    return sortedParts.filter((part) => part.mark.toLowerCase().includes(query))
  }, [sortedParts, markQuery])

  /** Toggle one mark; shift extends the selection from the last anchor over the visible order. */
  const toggleMark = useCallback(
    (mark: string, shift: boolean) => {
      const order = visibleParts.map((part) => part.mark)
      setSelectedMarks((prev) => {
        const next = new Set(prev)
        if (shift && selectAnchor.current != null) {
          const from = order.indexOf(selectAnchor.current)
          const to = order.indexOf(mark)
          if (from >= 0 && to >= 0) {
            const [lo, hi] = from <= to ? [from, to] : [to, from]
            for (let i = lo; i <= hi; i++) next.add(order[i])
            return next
          }
        }
        if (next.has(mark)) next.delete(mark)
        else next.add(mark)
        return next
      })
      if (!shift) selectAnchor.current = mark
    },
    [visibleParts],
  )

  const allVisibleSelected =
    visibleParts.length > 0 && visibleParts.every((part) => selectedMarks.has(part.mark))

  const toggleAllVisible = useCallback(() => {
    setSelectedMarks((prev) => {
      const next = new Set(prev)
      const everySelected = visibleParts.every((part) => prev.has(part.mark))
      for (const part of visibleParts) {
        if (everySelected) next.delete(part.mark)
        else next.add(part.mark)
      }
      return next
    })
  }, [visibleParts])

  /** The parts in table order that have something to show in the viewer — the next/prev ring. */
  const viewableParts = useMemo(
    () => visibleParts.filter((part) => part.step || part.nc),
    [visibleParts],
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

  // Prewarm the marks either side of the one being viewed: navigation is ±1 (arrow keys /
  // prev-next), so a neighbour is the next likely open. Each neighbour gets its crafted STEP, its
  // mesh, its overlay diff and its analysis (measure / light-sabre / NC-rebuild comparison) built
  // ahead of time, all queued at PRIORITY_NEIGHBOR — below the on-demand build but above background
  // analysis, so a prefetch never delays the part the user is actually waiting on. Best-effort: a
  // miss rebuilds on open.
  useEffect(() => {
    if (!viewing || viewingIndex < 0) return
    for (const delta of [1, -1]) {
      const neighbour = viewableParts[viewingIndex + delta]
      if (!neighbour) continue
      fastTrackPart(neighbour, PRIORITY_NEIGHBOR)
      const stepBytes = neighbour.step ? bytesByPath.get(neighbour.step.path) : undefined
      if (stepBytes) {
        void meshForViewer(neighbour.step?.path ?? neighbour.mark, stepBytes, {
          priority: PRIORITY_NEIGHBOR,
        }).catch(() => {})
      }
      const ncPath = neighbour.nc?.path
      const ncBytes = ncPath ? bytesByPath.get(ncPath) : undefined
      if (ncBytes) {
        void reconstructForViewer(new TextDecoder().decode(ncBytes), {
          priority: PRIORITY_NEIGHBOR,
        })
          .then((bytes) => {
            // Warm the manufactured tessellation and the overlay diff too, so opening is instant.
            if (bytes) {
              void meshForViewer(`${neighbour.mark} · manufactured`, bytes, {
                priority: PRIORITY_NEIGHBOR,
              }).catch(() => {})
              if (stepBytes) {
                // The diff needs the same seating the viewer applies, so resolve the neighbour's
                // section here (from its NC/part-list code — no PDF pass needed for a prefetch).
                const profile = partSectionForCode(
                  neighbour.expected?.profile ?? neighbour.nc?.profile ?? '',
                  neighbour.nc?.dimensions ?? [],
                )?.points
                void diffForViewer(bytes, stepBytes, {
                  profile,
                  priority: PRIORITY_NEIGHBOR,
                }).catch(() => {})
              }
            }
          })
          .catch(() => {})
      }
    }
  }, [viewing, viewingIndex, viewableParts, bytesByPath, fastTrackPart])

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

  /** Drops a part's NC edit, so it reverts to the bundled `.nc1`, and re-runs the NC checks. */
  const undoNcEdit = useCallback(
    (part: PartRecord) => {
      setNcOverrides((prev) => {
        if (!prev.has(part.mark)) return prev
        const next = new Map(prev)
        next.delete(part.mark)
        return next
      })
      const original = part.nc ? bytesByPath.get(part.nc.path) : undefined
      if (!original) return
      const text = new TextDecoder().decode(original)
      const section = part.nc?.profile
        ? partSectionForCode(part.nc.profile, part.nc.dimensions ?? [])
        : null
      const options = { section: section?.points, profile: part.nc?.profile }
      const unclosed = assessUnclosedCuts(text, options)
      setUnclosedCuts((prev) => {
        const next = new Map(prev)
        if (unclosed.length > 0) next.set(part.mark, unclosed)
        else next.delete(part.mark)
        return next
      })
      const bevel = assessBevelChange(text)
      setBevelChanges((prev) => {
        const next = new Map(prev)
        if (bevel.length > 0) next.set(part.mark, bevel)
        else next.delete(part.mark)
        return next
      })
    },
    [bytesByPath],
  )

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
        const step = await reconstructForViewer(new TextDecoder().decode(ncBytes))
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
        const step = await reconstructForViewer(new TextDecoder().decode(ncBytes), {
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

  /**
   * Removes the stray cut behind one `CUT_UNCLOSED` finding from the part's NC and records the
   * edited NC as an override. The manufactured model rebuilds from it (see the `ncBytes` memo) and
   * the export ships the edited NC. Recomputing the check drops the resolved warning.
   */
  const removeCut = useCallback(
    async (part: PartRecord, finding: Finding) => {
      const ncPath = part.nc?.path
      const original = ncPath ? bytesByPath.get(ncPath) : undefined
      if (!original) return
      const current = ncOverrides.get(part.mark)?.bytes ?? original
      const currentText = new TextDecoder().decode(current)
      const section = part.nc?.profile
        ? partSectionForCode(part.nc.profile, part.nc.dimensions ?? [])
        : null
      const options = { section: section?.points, profile: part.nc?.profile }
      const issueIndex =
        typeof finding.params?.index === 'number'
          ? finding.params.index -
            ((reachChecks.get(part.mark)?.length ?? 0) + (bevelChanges.get(part.mark)?.length ?? 0))
          : -1
      const issue = assessUnclosedCuts(currentText, options)[issueIndex]
      if (!issue) return
      setFixingMark(part.mark)
      try {
        const edited = removeCutFromNc(currentText, {
          contourIndex: issue.contourIndex,
          removeVertices: issue.removal,
        })
        if (edited === currentText) return
        setNcOverrides((prev) => {
          const next = new Map(prev)
          next.set(part.mark, { bytes: new TextEncoder().encode(edited), kind: 'removeCut' })
          return next
        })
        const remaining = assessUnclosedCuts(edited, options)
        setUnclosedCuts((prev) => {
          const next = new Map(prev)
          if (remaining.length > 0) next.set(part.mark, remaining)
          else next.delete(part.mark)
          return next
        })
      } catch {
        // leave the original NC in place if editing fails
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, ncOverrides, reachChecks, bevelChanges],
  )

  /**
   * Unifies the changing bevel on one cut line to a single angle (`0` removes it) by editing the
   * part's NC and recording it as an override — the same path as `removeCut`, so the manufactured
   * model rebuilds from the edited NC and the export ships it. Recomputing the check drops the
   * resolved finding.
   */
  const changeBevel = useCallback(
    async (part: PartRecord, finding: Finding, angle: number) => {
      const ncPath = part.nc?.path
      const original = ncPath ? bytesByPath.get(ncPath) : undefined
      if (!original) return
      const current = ncOverrides.get(part.mark)?.bytes ?? original
      const currentText = new TextDecoder().decode(current)
      // Bevel findings come after the cut-reach failures in the combined marker order, so the
      // finding's `index` (assigned in `allFindings`) maps back to a bevel issue by that base.
      const issueIndex =
        typeof finding.params?.index === 'number'
          ? finding.params.index - (reachChecks.get(part.mark)?.length ?? 0)
          : -1
      const issue = assessBevelChange(currentText)[issueIndex]
      if (!issue) return
      setFixingMark(part.mark)
      try {
        const edited = setBevelInNc(currentText, {
          contourIndex: issue.contourIndex,
          vertices: issue.vertices,
          angle,
        })
        if (edited === currentText) return
        setNcOverrides((prev) => {
          const next = new Map(prev)
          next.set(part.mark, {
            bytes: new TextEncoder().encode(edited),
            kind: 'setBevel',
            angle,
          })
          return next
        })
        const remaining = assessBevelChange(edited)
        setBevelChanges((prev) => {
          const next = new Map(prev)
          if (remaining.length > 0) next.set(part.mark, remaining)
          else next.delete(part.mark)
          return next
        })
      } catch {
        // leave the original NC in place if editing fails
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, ncOverrides, reachChecks],
  )

  /** Opens the "unify bevel" mini menu, prefilling the recommended angle for the cut line. */
  const openBevelEdit = useCallback((part: PartRecord, finding: Finding) => {
    const suggested = finding.params?.suggested
    setBevelAngle(typeof suggested === 'string' ? suggested : '')
    setBevelEdit({ part, finding })
  }, [])
  const closeBevelEdit = useCallback(() => setBevelEdit(null), [])
  /** Applies the chosen bevel angle (`0` = no bevel) to the open finding's cut line. */
  const applyBevel = useCallback(
    (angle: number) => {
      const target = bevelEdit
      setBevelEdit(null)
      if (target) void changeBevel(target.part, target.finding, angle)
    },
    [bevelEdit, changeBevel],
  )

  /**
   * Exports the job with every STEP the user fixed (cleaned/regenerated) substituted in.
   * The archive is flattened to basenames so the operator gets a folderless drop into WiseCAM.
   */
  const exportFixed = useCallback(() => {
    if (!result || !bundle || (stepOverrides.size === 0 && ncOverrides.size === 0)) return
    const files = new Map<string, Uint8Array>()
    for (const entry of bundle.entries) files.set(entry.path, entry.bytes)
    for (const [mark, override] of stepOverrides) {
      const path = result.parts.find((part) => part.mark === mark)?.step?.path
      if (path) files.set(path, override.bytes)
    }
    for (const [mark, override] of ncOverrides) {
      const path = result.parts.find((part) => part.mark === mark)?.nc?.path
      if (path) files.set(path, override.bytes)
    }
    const safeName = result.sourceName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
    downloadBlob(
      `fixed-${safeName || 'job'}.zip`,
      new Blob([zipSync(flattenZipEntries(files))], { type: 'application/zip' }),
    )
  }, [result, bundle, stepOverrides, ncOverrides])

  /**
   * Exports the ticked parts' PDF drawing + STEP + NC together in one flattened zip
   * (STEP overrides applied).
   */
  const exportSelected = useCallback(() => {
    if (!result || !bundle || selectedMarks.size === 0) return
    const files = new Map<string, Uint8Array>()
    for (const part of result.parts) {
      if (!selectedMarks.has(part.mark)) continue
      for (const path of [part.pdf?.path, part.nc?.path, part.step?.path]) {
        if (!path) continue
        const override =
          part.step?.path === path
            ? stepOverrides.get(part.mark)?.bytes
            : part.nc?.path === path
              ? ncOverrides.get(part.mark)?.bytes
              : undefined
        const bytes = override ?? bytesByPath.get(path)
        if (bytes) files.set(path, bytes)
      }
    }
    if (files.size === 0) {
      setError(t('preflight.findings.nothingSelected'))
      return
    }
    const safeName = result.sourceName.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
    downloadBlob(
      `selected-${safeName || 'job'}.zip`,
      new Blob([zipSync(flattenZipEntries(files))], { type: 'application/zip' }),
    )
  }, [result, bundle, selectedMarks, bytesByPath, stepOverrides, ncOverrides, t])

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
                    ({visibleParts.length}
                    {markQuery.trim() && sortedParts.length !== visibleParts.length
                      ? `/${sortedParts.length}`
                      : ''}
                    )
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
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <input
                    type="text"
                    value={markQuery}
                    onChange={(event) => setMarkQuery(event.target.value)}
                    placeholder={t('preflight.parts.searchPlaceholder')}
                    aria-label={t('preflight.parts.searchPlaceholder')}
                    className="h-8 w-44 rounded-md border border-border bg-background pl-7 pr-7 text-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {markQuery && (
                    <button
                      type="button"
                      onClick={() => setMarkQuery('')}
                      aria-label={t('preflight.parts.searchClear')}
                      title={t('preflight.parts.searchClear')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
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
                <Button size="sm" onClick={exportSelected} disabled={selectedMarks.size === 0}>
                  {t('preflight.findings.exportSelected', { count: selectedMarks.size })}
                </Button>
                {stepOverrides.size + ncOverrides.size > 0 && (
                  <Button variant="outline" size="sm" onClick={exportFixed}>
                    {t('preflight.findings.exportFixed', {
                      count: stepOverrides.size + ncOverrides.size,
                    })}
                  </Button>
                )}
              </div>
            </CardHeader>
            {partsOpen && (
              <CardContent>
                <Table containerClassName="max-h-[70vh] overflow-auto">
                  <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:border-b [&_th]:border-border [&_th]:bg-card [&_th:first-child]:left-0 [&_th:first-child]:z-30 [&_th:nth-child(2)]:left-8 [&_th:nth-child(2)]:z-30">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-8">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleAllVisible}
                          aria-label={t('preflight.parts.selectAll')}
                        />
                      </TableHead>
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
                  <TableBody className="[&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:z-10 [&_td:first-child]:bg-card [&_td:nth-child(2)]:sticky [&_td:nth-child(2)]:left-8 [&_td:nth-child(2)]:z-10 [&_td:nth-child(2)]:bg-card">
                    {visibleParts.length === 0 && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={PART_COLUMNS.length + 1}
                          className="text-center text-sm text-muted-foreground"
                        >
                          {t('preflight.parts.searchEmpty', { query: markQuery.trim() })}
                        </TableCell>
                      </TableRow>
                    )}
                    {visibleParts.map((part) => {
                      const material = drawingMaterials.get(part.mark)
                      const pdfQty = material?.qty ?? part.expected?.qty ?? null
                      const ncQty = part.nc?.quantity ?? null
                      const qtyMismatch = pdfQty != null && ncQty != null && pdfQty !== ncQty
                      const qtyFallback = pdfQty == null && ncQty != null
                      const mass = pieceMass(part)
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
                          <TableCell className="w-8 p-0">
                            <label
                              className="flex cursor-pointer items-center justify-center py-2"
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={selectedMarks.has(part.mark)}
                                readOnly
                                onClick={(event) => {
                                  event.stopPropagation()
                                  toggleMark(part.mark, event.shiftKey)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === ' ' || event.key === 'Enter') {
                                    event.stopPropagation()
                                  }
                                }}
                                aria-label={part.mark}
                              />
                            </label>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            <span className="flex items-center gap-1.5">
                              {part.mark}
                              {ncOverrides.get(part.mark) && (
                                <Badge variant="success" className="font-sans font-normal">
                                  {ncOverrides.get(part.mark)?.kind === 'setBevel'
                                    ? t('preflight.warnings.bevelSetBadge')
                                    : t('preflight.warnings.cutRemovedBadge')}
                                </Badge>
                              )}
                            </span>
                          </TableCell>
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
                            {pdfQty ?? ncQty ?? partQty(part)}
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
                          <TableCell className="font-mono text-xs">{sectionLabel(part)}</TableCell>
                          <TableCell className="text-xs">
                            {overrideFor(part) ? (
                              <Badge variant="success">
                                {overrideFor(part)?.kind
                                  ? t(`common.fix.${overrideFor(part)?.kind}`)
                                  : ''}
                              </Badge>
                            ) : modelChecks.has(part.mark) ? (
                              <span className={sizeCheckTone(modelChecks.get(part.mark))}>
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
              <PartSummary
                part={viewing}
                material={drawingMaterials.get(viewing.mark)}
                profile={sectionLabel(viewing)}
                massKg={pieceMass(viewing)}
                qty={partQty(viewing)}
                lengthMm={partLength(viewing)}
              />
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
            <div
              ref={splitRef}
              className="flex min-h-0 flex-1 flex-col xl:flex-row"
              style={{ '--split-right': `${rightPct}%` } as CSSProperties}
            >
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex items-stretch border-b border-border bg-card">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 text-xs font-medium text-muted-foreground">
                      {stock && (
                        <div className="flex items-center gap-1.5">
                          <Toggle size="xs" pressed={showStock} onPressedChange={setShowStock}>
                            {t('viewer.stock')}
                          </Toggle>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5">
                        <Toggle
                          size="xs"
                          pressed={showGrid}
                          onPressedChange={setShowGrid}
                          title={t('viewer.gridHint')}
                        >
                          {t('viewer.grid')}
                        </Toggle>
                      </div>
                      {paneCount > 1 && (
                        <TabBar
                          options={PANE_LAYOUTS.map((o) => ({ id: o.id, label: t(o.labelKey) }))}
                          value={paneLayout}
                          onChange={setPaneLayout}
                          title={t('preflight.viewer.layoutHint')}
                        />
                      )}
                      <TabBar
                        options={VIEW_PRESETS.map((o) => ({ id: o.id, label: t(o.labelKey) }))}
                        value={activeView}
                        onChange={(id) => {
                          requestView(orbitBus, id)
                          setActiveView(id)
                        }}
                        title={t('preflight.viewer.viewHint')}
                      />
                      {/* Live location of the orbit pivot along the member (the reticle's position);
                          type an mm and press Enter to jump the view there. The member-direction
                          arrow spans both strips in the right column. */}
                      <div
                        className="ml-auto flex items-center gap-1.5 tabular-nums"
                        title={t('preflight.viewer.locationHint')}
                      >
                        <span className="text-[10px] uppercase tracking-wide">
                          {t('preflight.viewer.location')}
                        </span>
                        <div className="flex items-stretch overflow-hidden rounded-sm border border-border bg-background focus-within:border-primary">
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
                              setLocationInput(
                                locationMm == null ? '' : String(Math.round(locationMm)),
                              )
                              setLocationEditing(true)
                              requestAnimationFrame(() => field.select())
                            }}
                            onBlur={commitLocation}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur()
                            }}
                            placeholder="—"
                            aria-label={t('preflight.viewer.location')}
                            className="w-14 bg-transparent px-1 py-0.5 text-right text-[11px] text-foreground outline-none"
                          />
                          <span className="border-l border-border px-1 py-0.5 text-[10px] text-muted-foreground">
                            mm
                          </span>
                        </div>
                      </div>
                    </div>
                    {(viewingNcGeom || (overlayShown && mfgDiff)) && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-card/50 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                        {viewingNcGeom && (
                          <NcLegend
                            thicknesses={viewingNcProfiles}
                            showMarkings={viewingHasMarkings}
                          />
                        )}
                        {overlayShown && mfgDiff && <DiffLegend info={mfgDiff} />}
                      </div>
                    )}
                  </div>
                  <div
                    className="flex size-14 shrink-0 grow-0 basis-auto items-center justify-center self-center border-l border-border"
                    title={t('preflight.viewer.locationDirection')}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="size-full shrink-0 text-foreground"
                    >
                      <g transform={`rotate(${locationAxis} 12 12)`}>
                        <line
                          x1="3"
                          y1="12"
                          x2="16.5"
                          y2="12"
                          stroke="currentColor"
                          strokeWidth="0.5"
                          strokeLinecap="round"
                        />
                        <path d="M19 12 L16.5 10.9 L16.5 13.1 Z" fill="currentColor" />
                        {locationMm != null && (
                          <circle
                            cx={
                              3 +
                              (viewingLength != null && viewingLength > 0
                                ? Math.min(1, Math.max(0, locationMm / viewingLength))
                                : 0) *
                                16
                            }
                            cy="12"
                            r="1"
                            fill="#ef4444"
                          />
                        )}
                      </g>
                    </svg>
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
                      ref={setGridEl}
                      className={cn(
                        'grid h-full auto-rows-fr gap-px bg-border',
                        resolvedLayout === 'rows' || paneCount <= 1
                          ? 'grid-cols-1'
                          : paneCount >= 3
                            ? 'grid-cols-3'
                            : 'grid-cols-2',
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
                            cutEdges={viewingCutEdgeOptions}
                            visibleSpans={visibleSpans}
                            highlight={highlightSpan}
                            showStock={showStock}
                            onShowStockChange={setShowStock}
                            showGrid={showGrid}
                            onShowGridChange={setShowGrid}
                            onLocationChange={handleLocation}
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
                            showGrid={showGrid}
                            onShowGridChange={setShowGrid}
                            onLocationChange={stepBytes ? undefined : handleLocation}
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
                            showGrid={showGrid}
                            onShowGridChange={setShowGrid}
                            onDiffInfo={setMfgDiff}
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
                <div
                  onPointerDown={(event) => {
                    event.preventDefault()
                    setSplitting(true)
                  }}
                  className="hidden w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/60 xl:block"
                  title={t('preflight.viewer.resizeSplit')}
                />
              </div>
              <div className="flex h-[60vh] w-full shrink-0 flex-col overflow-hidden border-t border-border xl:h-auto xl:min-h-0 xl:w-[var(--split-right)] xl:border-t-0">
                <div className="relative z-10 flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1">
                  <TabBar
                    options={[
                      { id: 'drawing' as const, label: t('preflight.viewer.drawing') },
                      {
                        id: 'issues' as const,
                        label: t('preflight.warnings.issues', { count: viewerFindings.length }),
                      },
                    ]}
                    value={rightTab}
                    onChange={setRightTab}
                  />
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
                        canRemoveCut: Boolean(viewing.nc),
                        canSetBevel: Boolean(viewing.nc),
                        ncEdit: ncOverrides.get(viewing.mark),
                        pending: fixingMark === viewing.mark,
                        onClean: () => void cleanPart(viewing),
                        onRegenerate: () => void regeneratePart(viewing),
                        onSimplify: () => void simplifyPart(viewing),
                        onRemoveCut: (finding) => void removeCut(viewing, finding),
                        onSetBevel: (finding) => openBevelEdit(viewing, finding),
                        onUndo: () => undoOverride(viewing.mark),
                        onUndoNc: () => undoNcEdit(viewing),
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

      <BevelMenu
        open={bevelEdit !== null}
        recommended={
          typeof bevelEdit?.finding.params?.suggested === 'string'
            ? bevelEdit.finding.params.suggested
            : undefined
        }
        angle={bevelAngle}
        onAngle={setBevelAngle}
        onApply={applyBevel}
        onClose={closeBevelEdit}
      />
    </div>
  )
}

function PartSummary({
  part,
  material,
  profile,
  massKg,
  qty: qtyProp,
  lengthMm,
}: {
  part: PartRecord
  material?: DrawingMaterial
  profile?: string
  massKg?: number | null
  qty?: number | null
  lengthMm?: number | null
}) {
  const { t } = useTranslation()
  const section = profile ?? listedProfile(part) ?? '—'
  const qty = qtyProp ?? material?.qty ?? part.expected?.qty ?? part.nc?.quantity ?? null
  const length = lengthMm ?? material?.length ?? part.expected?.length ?? part.nc?.length ?? null
  const mass = massKg ?? material?.weight ?? part.expected?.weight ?? null
  const stats: [string, string][] = [
    [t('preflight.columns.profile'), section],
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
  /** A `CUT_UNCLOSED` finding can be resolved by editing the NC. */
  canRemoveCut: boolean
  /** A `CUT_BEVEL_CHANGE` finding can be resolved by unifying the cut line's bevel via the NC. */
  canSetBevel: boolean
  /** The NC edit already applied to the part, if any. */
  ncEdit?: NcOverride
  pending: boolean
  onClean: () => void
  onRegenerate: () => void
  onSimplify: () => void
  onRemoveCut: (finding: Finding) => void
  onSetBevel: (finding: Finding) => void
  onUndo: () => void
  onUndoNc: () => void
}

/** Which fix action a viewer Fix button runs, with its labels. */
function viewerFixAction(
  t: TFunction,
  fix: ViewerFix,
  kind: FindingFix,
  finding: Finding,
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
  if (kind === 'removeCut')
    return {
      label: t('common.actions.removeCut'),
      pendingLabel: t('common.actions.removing'),
      run: () => fix.onRemoveCut(finding),
    }
  if (kind === 'setBevel')
    return {
      label: t('common.actions.setBevel'),
      pendingLabel: t('common.actions.working'),
      run: () => fix.onSetBevel(finding),
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
  if (kind === 'removeCut') return fix.canRemoveCut
  if (kind === 'setBevel') return fix.canSetBevel
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
    fix?.override || fix?.canClean || fix?.canRegenerate || fix?.canSimplify || fix?.ncEdit,
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
              const action = fixKind && fix ? viewerFixAction(t, fix, fixKind, finding) : null
              // Only findings the viewer can point at in 3D get an eye toggle / are clickable.
              const showable = isVisualisable(finding)
              return (
                <TableRow
                  key={`${finding.code}-${finding.params?.index ?? finding.message}`}
                  tabIndex={showable ? 0 : undefined}
                  onClick={showable && onToggleCheck ? () => onToggleCheck(index) : undefined}
                  onKeyDown={
                    showable
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onToggleCheck?.(index)
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    'outline-none focus-visible:bg-accent/60',
                    showable && 'cursor-pointer',
                  )}
                  onMouseEnter={showable && onHover ? () => onHover(index) : undefined}
                  onMouseLeave={showable && onHover ? () => onHover(null) : undefined}
                >
                  <TableCell className="py-1">
                    {showable ? (
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
                    ) : null}
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
      {fix?.ncEdit && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          <span>
            {fix.ncEdit.kind === 'setBevel'
              ? fix.ncEdit.angle
                ? t('preflight.warnings.bevelSet', { angle: fix.ncEdit.angle })
                : t('preflight.warnings.bevelRemoved')
              : t('preflight.warnings.cutRemoved')}
          </span>
          <Button variant="ghost" size="sm" onClick={fix.onUndoNc}>
            <Undo2 />
            {t('common.actions.undo')}
          </Button>
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

/** Compact segmented tabs — tight rectangles with no pill padding/margin, to save viewer chrome. */
function TabBar<T extends string>({
  options,
  value,
  onChange,
  title,
}: {
  options: { id: T; label: string }[]
  value: T | null
  onChange: (id: T) => void
  title?: string
}) {
  return (
    <div
      className="inline-flex items-center overflow-hidden rounded-sm border border-border"
      title={title}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={cn(
            'px-1.5 py-0.5 text-[11px] font-medium leading-none transition-colors',
            value === option.id
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** The overlay-diff key (overcut/undercut vs the STEP ideal), for the shared legend strip. */
function DiffLegend({ info }: { info: DiffStats }) {
  const { t } = useTranslation()
  const chip = 'inline-block size-3 rounded-sm border'
  const pct = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.01 ? 1 : 0)}%`
  const title =
    t('viewer.diffTitle', { over: pct(info.over), under: pct(info.under) }) +
    (info.approximate ? '' : ` · ${t('viewer.facesHiddenNote')}`)
  if (info.over < 0.001 && info.under < 0.001) {
    return (
      <span className="flex items-center gap-1.5" title={title}>
        <span className={cn(chip, 'border-emerald-400 bg-emerald-400/50')} />
        <span className="text-emerald-300">{t('viewer.noDifferences')}</span>
      </span>
    )
  }
  if (info.approximate) {
    return (
      <span className="flex items-center gap-1.5" title={title}>
        <span className={cn(chip, 'border-red-400 bg-red-500/65')} />
        <span className="text-red-300">{t('viewer.differences')}</span>
      </span>
    )
  }
  return (
    <span className="flex items-center gap-3" title={title}>
      <span className="flex items-center gap-1.5">
        <span className={cn(chip, 'border-red-400 bg-red-500/65')} />
        <span className="text-red-300">{t('viewer.overcut')}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn(chip, 'border-blue-400 bg-blue-500/65')} />
        <span className="text-blue-300">{t('viewer.undercut')}</span>
      </span>
    </span>
  )
}

function PaneTag({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-0 top-0 z-10 whitespace-nowrap rounded-br-sm bg-card/85 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground backdrop-blur">
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

/**
 * The "unify bevel" mini menu for a `CUT_BEVEL_CHANGE` cut line. The best bevel is one the head
 * never has to change: pick one angle for the whole line (prefilled with the recommended angle it
 * mostly already uses) or drop the bevel entirely. Applying rewrites the NC.
 */
function BevelMenu({
  open,
  recommended,
  angle,
  onAngle,
  onApply,
  onClose,
}: {
  open: boolean
  recommended?: string
  angle: string
  onAngle: (value: string) => void
  onApply: (angle: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const parsed = Number.parseFloat(angle)
  const valid = Number.isFinite(parsed) && parsed !== 0 && Math.abs(parsed) <= MAX_BEVEL_DEG
  return (
    <Dialog open={open} onClose={onClose} title={t('preflight.bevel.title')}>
      <div className="flex flex-col gap-4 p-5">
        <p className="text-sm text-muted-foreground">{t('preflight.bevel.hint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="bevel-angle" className="text-sm font-medium">
            {t('preflight.bevel.angle')}
          </label>
          <input
            id="bevel-angle"
            type="number"
            inputMode="decimal"
            step="0.1"
            min={MACHINE.bevel.minDeg}
            max={MACHINE.bevel.maxDeg}
            value={angle}
            onChange={(event) => onAngle(event.target.value)}
            className="h-8 w-24 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span className="text-sm text-muted-foreground">°</span>
          {recommended && (
            <span className="text-xs text-muted-foreground">
              {t('preflight.bevel.recommended', { angle: recommended })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => onApply(0)}>
            {t('preflight.bevel.noBevel')}
          </Button>
          <Button size="sm" disabled={!valid} onClick={() => onApply(parsed)}>
            {t('preflight.bevel.apply')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
