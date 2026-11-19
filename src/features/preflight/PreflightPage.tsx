import { useNavigate } from '@tanstack/react-router'
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
  Wand,
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
import { auditEntries, markFromFilename } from '@/lib/audit/auditJob'
import { assessBevelChangeGeometry, type BevelChangeIssue } from '@/lib/audit/bevelChange'
import { assessCutReachGeometry, type CutMarker, type CutReachFailure } from '@/lib/audit/cutReach'
import { findingOpKey, ncOpForFinding } from '@/lib/audit/fixOps'
import { AUTO_FIX_CODES, type FixTier, fixTierForCode } from '@/lib/audit/fixTier'
import { assessManufacturability } from '@/lib/audit/manufacturability'
import { MASS_BAND_CLASS, MASS_RED_KG, MASS_YELLOW_KG, massBand } from '@/lib/audit/mass'
import {
  filterParts,
  type PartFilterContext,
  type PartStatus,
  parsePartQuery,
  statusForPart,
  toggleQueryToken,
  withStatusFilter,
} from '@/lib/audit/partFilter'
import { listedProfile } from '@/lib/audit/partProfile'
import { type PartSortKey, sortParts } from '@/lib/audit/partSort'
import { assessRootFilletGeometry, type RootFilletIssue } from '@/lib/audit/rootFillet'
import type { AuditResult, Finding, PartRecord, Severity, StepFile } from '@/lib/audit/types'
import { assessUnclosedCutsGeometry, type UnclosedCutIssue } from '@/lib/audit/unclosedCuts'
import { findWeldingEtchings, type WeldingEtchings } from '@/lib/audit/weldingEtchings'
import { downloadBlob, fileStem } from '@/lib/download'
import { onGlobalDrop } from '@/lib/dropTarget'
import { createFileStamp } from '@/lib/fileStamp'
import { formatMass, formatNumber } from '@/lib/format'
import { MACHINE } from '@/lib/machine/profile'
import {
  moveCutInNc,
  removeCutFromNc,
  setBevelInNc,
  setOutOfRangeBevelInNc,
} from '@/lib/parsers/ncEdit'
import { frameForProfile, resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import {
  channelVToHShift,
  cutThicknesses,
  faceThickness,
  ncAlongMid,
  THICKNESS_COLORS,
} from '@/lib/parsers/ncProject'
import { reemitPartNc } from '@/lib/parsers/ncReemit'
import { type DrawingMaterial, resolveDrawingMaterial } from '@/lib/parsers/pdfText'
import { partIrFromNc } from '@/lib/part/fromNc'
import { partIrFromStepMesh } from '@/lib/part/fromStep'
import type { PartIr } from '@/lib/part/ir'
import { partIrSvgParts } from '@/lib/part/svg'
import { buildNcepFromIr } from '@/lib/part/toNcep'
import { partIrToNcGeometry } from '@/lib/part/toNcGeometry'
import {
  loadProjectEdits,
  type NcOp,
  type NcOverride,
  type ProjectEdit,
  type StepFixKind,
  type StepOverride,
  saveProjectEdit,
} from '@/lib/projects/edits'
import {
  deleteProject,
  getProjectMeta,
  loadProject,
  normalizeBatches,
  putProjectFiles,
  removeProjectFiles,
  saveProjectBatches,
  takeHandOffProject,
} from '@/lib/projects/store'
import type { PurchaseGroupInput } from '@/lib/purchasing/purchase'
import type { InputBundle } from '@/lib/readInput'
import { readDroppedInput } from '@/lib/readInput'
import { yieldToMain } from '@/lib/scheduler'
import { CUT_FACES, FACE_DIRECTIONS, profileFamily } from '@/lib/sections/canonical'
import type { SectionGuess } from '@/lib/sections/detect'
import { inferTee } from '@/lib/sections/infer'
import {
  layoutDimensions,
  partSectionForCode,
  resolveStockOutline,
  type StockOutline,
  sectionMassPerMetre,
} from '@/lib/sections/stock'
import { stockFaceThicknesses } from '@/lib/step/cutEdges'
import {
  CROSS_TOLERANCE_MM,
  compareGeometry,
  compareModels,
  compareSize,
  type GeometryCheck,
  lengthToleranceMm,
  type ModelComparison,
  ncOnlySizeCheck,
  type SizeCheck,
  type StepMeasure,
  stepOnlySizeCheck,
} from '@/lib/step/measure'
import { detectStepSection } from '@/lib/step/readSection'
import type { SabreFailure } from '@/lib/step/sabre'
import {
  getStepWorkerPool,
  PRIORITY_BACKGROUND,
  PRIORITY_FOREGROUND,
  PRIORITY_NEIGHBOR,
  prebootStepWorkers,
  STEP_WORKER_COUNT,
} from '@/lib/step/stepPool'
import type { InspectResult, ReconstructResult } from '@/lib/step/stepWorkerProtocol'
import {
  TAB_DENSITY_DEFAULT,
  TAB_DENSITY_MAX,
  TAB_DENSITY_MIN,
  TAB_ENGAGEMENT_DEFAULT,
  TAB_ENGAGEMENT_MAX,
  TAB_ENGAGEMENT_MIN,
  TAB_LENGTH_DEFAULT,
  TAB_LENGTH_MAX,
  TAB_LENGTH_MIN,
  TAB_WIDTH_DEFAULT,
  TAB_WIDTH_MAX,
  TAB_WIDTH_MIN,
  type TabDefaults,
} from '@/lib/step/tabs'
import {
  clearViewerModels,
  diffForViewer,
  meshForViewer,
  peekMeshForViewer,
  peekReconstructForViewer,
  primeReconstructForViewer,
  reconstructForViewer,
  reconstructViewerWithSabre,
} from '@/lib/step/viewerModel'
import { cn } from '@/lib/utils'
import { buildNcepFromNc } from '@/lib/wisecam/fromNc'
import { flattenZipEntries } from '@/lib/zip'
import { DrawingViewer } from './DrawingViewer'
import { JobPanel } from './JobPanel'
import { NcLegend } from './NcLegend'
import { createOrbitBus, requestLocation, requestView, type ViewPreset } from './orbitSync'
import type { DiffStats } from './PartViewer'
import {
  CutSettings,
  type ProfileMarkRow,
  ProfileSettingsDialog,
  SectionLookupDialog,
  SectionPreview,
} from './ProfileSettingsDialog'
import { PurchaseDialog } from './PurchaseDialog'

const PartViewer = lazy(() => import('./PartViewer'))

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** One DSTV face on the tiny face map: its unit direction in the section's own `x`/`y` frame. */
interface FaceMapEntry {
  face: NcFace
  dx: number
  dy: number
}

/** Location along the member (mm) a finding sits at, or null when it has none. */
function findingLocationOf(finding: Finding): number | null {
  const raw = finding.params?.x
  return typeof raw === 'number' ? raw : null
}

/** Finding codes the viewer draws a 3D cut marker for (and hence the eye can toggle). */
const VISUALISABLE_CODES = new Set([
  'CUT_DEPTH',
  'CUT_CORNER',
  'CUT_ROOT_FILLET',
  'CUT_BEVEL_CHANGE',
  'CUT_UNCLOSED',
  'CUT_CUTOUT',
  'BEVEL_OUT_OF_RANGE',
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
/** A CUT_DEPTH finding from the NC probe: drawn as its own run, not as a sub-cut marker. */
function isNcRun(finding: Finding): boolean {
  return finding.code === 'CUT_DEPTH' && finding.params?.nc === 1
}

function markerIndexOf(finding: Finding): number | null {
  // Out-of-range bevel findings index their own warning lines, and NC probe runs index their own
  // run objects, not the sub-cut markers.
  if (finding.code === 'BEVEL_OUT_OF_RANGE') return null
  if (isNcRun(finding)) return null
  const raw = finding.params?.index
  return typeof raw === 'number' ? raw : null
}

/** How many drawings to parse at once. Matches the pdf.js worker pool size. */
const CONCURRENCY = 6

/** The head's bevel range (deg); a unify-bevel angle outside it is rejected. */
const MAX_BEVEL_DEG = Math.max(Math.abs(MACHINE.bevel.minDeg), Math.abs(MACHINE.bevel.maxDeg))

/**
 * Confidence a STEP-inferred section must reach before its **real** outline is trusted as the
 * stock ghost. Below this it is treated as an approximate match and the catalogue outline is used.
 */
const SECTION_TRUST_SCORE = 0.9

/**
 * The parts table's columns. Status is the only flexible one (`w-full`): it absorbs the table's
 * spare width and its pills wrap inside it, so fixes changing the badges never move the columns
 * beside it. Everything else hugs its content — those values are short and stable (marks and
 * assemblies are fixed the moment the job is read; qty/mass/size only fill in once), so a column
 * grows by a character or two at most and never reflows on every render.
 */
const PART_COLUMNS: {
  labelKey: string
  key: PartSortKey
  align?: 'right'
  /** Width class: `w-full` for the flexible column, `w-px` to hug content. */
  width: string
}[] = [
  { labelKey: 'preflight.columns.mark', key: 'mark', width: 'w-px' },
  { labelKey: 'preflight.columns.status', key: 'severity', width: 'w-full' },
  {
    labelKey: 'preflight.columns.assembly',
    key: 'assembly',
    align: 'right',
    width: 'w-px',
  },
  { labelKey: 'preflight.columns.qty', key: 'qty', align: 'right', width: 'w-px' },
  { labelKey: 'preflight.columns.mass', key: 'mass', align: 'right', width: 'w-px' },
  { labelKey: 'preflight.columns.profile', key: 'profile', align: 'right', width: 'w-px' },
  { labelKey: 'preflight.columns.model', key: 'model', align: 'right', width: 'w-px' },
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

/** A parts-table pill that toggles its search token when clicked, so the table filters itself. */
function FilterPill({
  token,
  active,
  title,
  onToggle,
  children,
}: {
  token: string
  active: boolean
  title: string
  onToggle: (token: string) => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      aria-pressed={active}
      title={`${title} · ${t(
        active ? 'preflight.parts.filterRemove' : 'preflight.parts.filterAdd',
        { token },
      )}`}
      onClick={(event) => {
        event.stopPropagation()
        onToggle(token)
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={cn(
        'cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active && 'ring-2 ring-ring ring-offset-1 ring-offset-card',
      )}
    >
      {children}
    </button>
  )
}

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

/** The NC checks re-run on an edited NC, so fixes resolve only the issues they actually clear. */
interface NcRecheck {
  reach: CutReachFailure[]
  rootFillet: RootFilletIssue[]
  bevel: BevelChangeIssue[]
  unclosed: UnclosedCutIssue[]
}

function applyNcOp(text: string, op: NcOp): string {
  if (op.kind === 'unifyBevel')
    return setBevelInNc(text, {
      contourIndex: op.contourIndex,
      vertices: op.vertices,
      angle: op.angle,
    })
  if (op.kind === 'outOfRangeBevel')
    return setOutOfRangeBevelInNc(text, {
      contourIndex: op.contourIndex,
      vertex: op.vertex,
      angle: op.angle,
    })
  if (op.kind === 'moveCut')
    return moveCutInNc(text, {
      contourIndex: op.contourIndex,
      vertices: op.vertices,
      deltaY: op.deltaY,
    })
  return removeCutFromNc(text, { contourIndex: op.contourIndex, removeVertices: op.removeVertices })
}

/** The NC with `ops` applied in order to the original bytes. */
function replayNcOps(original: Uint8Array, ops: NcOp[]): Uint8Array {
  let text = new TextDecoder().decode(original)
  for (const op of ops) text = applyNcOp(text, op)
  return new TextEncoder().encode(text)
}

/** Adds `op`; re-applying a finding replaces its own op in place, so the others keep their order. */
function upsertOp(ops: NcOp[], op: NcOp): NcOp[] {
  return ops.some((existing) => existing.key === op.key)
    ? ops.map((existing) => (existing.key === op.key ? op : existing))
    : [...ops, op]
}

/** The override after `ops`; with none left the NC is back to the original, so the override goes. */
function withNcOps(
  prev: Map<string, NcOverride>,
  mark: string,
  ops: NcOp[],
  original: Uint8Array,
): Map<string, NcOverride> {
  const next = new Map(prev)
  if (ops.length === 0) next.delete(mark)
  else next.set(mark, { bytes: replayNcOps(original, ops), ops })
  return next
}

/**
 * Where a part's exported STEP ships. Normally its own path. A part with no STEP but a generated
 * (NC-derived) STEP takes the NC's filename with a `.step` extension, so it drops into WiseCAM
 * beside the NC it replaces.
 */
function exportStepPath(part: PartRecord): string {
  if (part.step?.path) return part.step.path
  if (part.nc?.path) {
    return /\.[^./\\]+$/.test(part.nc.path)
      ? part.nc.path.replace(/\.[^./\\]+$/, '.step')
      : `${part.nc.path}.step`
  }
  return `${part.mark.replace(/[^\w.-]+/g, '-')}.step`
}

/** A finding an override resolves — greyed out in the list, with an undo. */
function resolvedFindings(kind: StepFixKind): string[] {
  if (kind === 'regenerated' || kind === 'repaired')
    return ['STRAY_BODY', 'MANUFACTURE_MISMATCH', 'MANUFACTURE_BORDERLINE']
  if (kind === 'simplified') return ['CUT_END_PIECE']
  return ['STRAY_BODY']
}

/**
 * A copy of `map` without `keys` — the same map when nothing is dropped, so React can skip the
 * re-render when a removed file belonged to no part.
 */
function withoutKeys<T>(map: Map<string, T>, keys: ReadonlySet<string>): Map<string, T> {
  let next = map
  for (const key of keys) {
    if (!next.has(key)) continue
    if (next === map) next = new Map(map)
    next.delete(key)
  }
  return next
}

/**
 * The one-click fix a finding code maps to, when the warning is fixable at all. `clean` /
 * `regenerate` / `simplify` swap the part's STEP; `removeCut` edits the NC (stripping the flagged
 * cut) and rebuilds the model from it; `setBevel` edits the NC (unifying the cut line's bevel) via
 * a mini menu that offers an angle (prefilled with the recommended one) or no bevel.
 */
type FindingFix = 'clean' | 'regenerate' | 'simplify' | 'removeCut' | 'setBevel' | 'moveCut'
function fixForFinding(finding: Finding): FindingFix | null {
  const code = finding.code
  if (code === 'STRAY_BODY') return 'clean'
  if (code === 'MANUFACTURE_MISMATCH' || code === 'MANUFACTURE_BORDERLINE') return 'regenerate'
  if (code === 'CUT_END_PIECE') return 'simplify'
  if (code === 'CUT_UNCLOSED' || code === 'CUT_CUTOUT') return 'removeCut'
  if (code === 'CUT_BEVEL_CHANGE') return 'setBevel'
  if (code === 'BEVEL_OUT_OF_RANGE') return 'setBevel'
  if (code === 'CUT_ROOT_FILLET') return 'moveCut'
  return null
}

/** One status pill in the parts table: a distinct finding code, grouped with a count. */
interface StatusPill {
  code: string
  severity: Severity
  count: number
  finding: Finding
}

/** The tooltip for a part's weld-location etchings (localised). */
function weldEtchingsTitle(t: TFunction, etchings: WeldingEtchings): string {
  const parts = [t('preflight.status.weldTitle')]
  if (etchings.labels.length > 0) {
    parts.push(t('preflight.status.weldLabels', { labels: etchings.labels.join(', ') }))
  }
  if (etchings.scribeLines > 0) {
    parts.push(t('preflight.status.weldScribes', { count: etchings.scribeLines }))
  }
  return parts.join(' · ')
}

/** Grades an NC-vs-STEP mismatch: massive = error, borderline = warning, close = ok. */
function mismatchGrade(comparison: ModelComparison): 'ok' | 'warning' | 'error' {
  if (!comparison.sizeOk) return 'error'
  const delta = Math.abs(comparison.volumeDelta)
  if (delta > 0.1) return 'error'
  if (delta > 0.01) return 'warning'
  return 'ok'
}

/** One run of text in the model-size cell; `bad` marks the dimension outside tolerance. */
interface SizeSegment {
  /** Which extent this is, so the cell can key on it and the failure stays stable across renders. */
  dim: 'length' | 'crossA' | 'crossB' | 'note'
  text: string
  bad?: boolean
}

/**
 * The model-size cell, split so the dimension that failed can be highlighted. A pass (or a part
 * with no expected size) shows the length alone — the cross-section is fixed by the profile — while
 * a failure prints the measured triple and, next to the failing dimension, what it should have
 * been, so the row reads without the tooltip.
 */
function sizeSegments(t: TFunction, check?: SizeCheck): SizeSegment[] {
  if (!check) return [{ dim: 'note', text: '—' }]
  if (check.error === 'noDims') return [{ dim: 'note', text: t('preflight.model.noDims') }]
  if (check.error === 'measureFailed')
    return [{ dim: 'note', text: t('preflight.model.measureFailed') }]
  if (!check.measured) return [{ dim: 'note', text: '—' }]
  const [l, a, b] = check.measured
  if (!check.expected || check.ok) return [{ dim: 'length', text: `L${l.toFixed(0)}` }]

  const [el, ea, eb] = check.expected
  const lengthBad = Math.abs(l - el) > lengthToleranceMm(el)
  const crossBad = [Math.abs(a - ea) > CROSS_TOLERANCE_MM, Math.abs(b - eb) > CROSS_TOLERANCE_MM]
  // A failure with every extent in tolerance is a matching quirk (the cross dims matched in the
  // reverse order some other way): show both cross dims as the difference rather than none.
  if (!lengthBad && !crossBad.some(Boolean)) crossBad.fill(true)

  const shown = [l, a, b].map((value) => value.toFixed(0))
  const expected = [el, ea, eb].map((value) => value.toFixed(0))
  const differs = (bad: boolean, index: number) => (bad ? ` ≠ ${expected[index]}` : '')
  return [
    { dim: 'length', text: `L${shown[0]}${differs(lengthBad, 0)}`, bad: lengthBad },
    { dim: 'crossA', text: ` × ${shown[1]}${differs(crossBad[0], 1)}`, bad: crossBad[0] },
    { dim: 'crossB', text: ` × ${shown[2]}${differs(crossBad[1], 2)}`, bad: crossBad[1] },
  ]
}

/** The full measured (and expected) extents, for the size cell's tooltip. */
function sizeCheckTitle(t: TFunction, check?: SizeCheck): string | undefined {
  if (!check?.measured) return undefined
  const text = (size: [number, number, number]) =>
    `${size.map((value) => value.toFixed(0)).join(' × ')} mm`
  const measured = text(check.measured)
  if (!check.expected) return measured
  return t('preflight.model.sizeBoth', { measured, expected: text(check.expected) })
}

/** A real mismatch: there is an expected size and the check failed (not a STEP-only reading). */
function failsSize(check?: SizeCheck): boolean {
  return Boolean(check?.expected && !check.ok)
}

/** Colour for the model-size cell: a STEP-only or NC-only size is neutral, a real check is pass/fail. */
function sizeCheckTone(check?: SizeCheck): string {
  if (check?.error === 'stepOnly' || check?.error === 'ncOnly') return 'text-muted-foreground'
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

/** Face thicknesses for a profile's section, shared by the NC and STEP panes. */
function stockThicknessesFor(
  profile: string | null,
  section: [number, number][] | null,
  holes: [number, number][][] | undefined,
): number[] {
  if (!section || section.length < 3) return []
  const family = profile ? profileFamily(profile) : null
  if (family && profile && family !== 'tee') {
    const frame = frameForProfile(profile, section)
    const faces = CUT_FACES[family] ?? ['o', 'u', 'h']
    const values = faces
      .map((face) => Math.round(faceThickness(frame, section, face) * 10) / 10)
      .filter((value) => value > 0)
    return [...new Set(values)].sort((a, b) => a - b)
  }
  // Unknown family (or `tee`, whose face letters are not reconciled yet): measure the stock
  // directly. A tee's cut faces are both sides and the flange underside, not the web tip.
  const normals: [number, number][] =
    family === 'tee'
      ? [
          [1, 0],
          [-1, 0],
          [0, -1],
        ]
      : [
          [1, 0],
          [-1, 0],
          [0, 1],
        ]
  return stockFaceThicknesses(section, holes ?? [], normals)
}

export function PreflightPage({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const findingText = useCallback(
    (finding: Finding) =>
      t(`findings.${finding.code}`, { ...finding.params, defaultValue: finding.message }),
    [t],
  )
  const [result, setResult] = useState<AuditResult | null>(null)
  const [bundle, setBundle] = useState<InputBundle | null>(null)
  const [viewing, setViewing] = useState<PartRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** True while the route's project is being read out of IndexedDB. */
  const [loadingProject, setLoadingProject] = useState(true)
  /** The route points at a project this browser no longer has. */
  const [missingProject, setMissingProject] = useState(false)
  /**
   * How many copies (batches) of this job are being made. Planning quantities — stats, profiles,
   * purchase lengths and the tracking sheet — multiply by it. Saved with the project.
   */
  const [batches, setBatches] = useState(1)
  /** Marks ticked in the parts table for the selective PDF/STEP/NC export. */
  const [selectedMarks, setSelectedMarks] = useState<Set<string>>(new Set())
  /** True while an export is re-seating STEPs / re-emitting NCs in the OCC workers. */
  const [exporting, setExporting] = useState(false)
  /** Auto-fix progress over the ticked marks, or null when it isn't running. */
  const [autoFixing, setAutoFixing] = useState<{ done: number; total: number } | null>(null)
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
  /** Per-part welding-location etchings (`SI` member labels / `PU`-`KO` scribe bars). */
  const [weldEtchings, setWeldEtchings] = useState<Map<string, WeldingEtchings>>(new Map())
  const [sabreChecks, setSabreChecks] = useState<Map<string, SabreFailure[]>>(new Map())
  /** Sabre re-run on the edited NC for a part with an NC override (the current solid's probe). */
  const [sabreRecheck, setSabreRecheck] = useState<Map<string, SabreFailure[]>>(new Map())
  /** Findings fixed by an NC edit, kept as resolved rows so the existing per-row Undo survives. */
  const [resolvedFixes, setResolvedFixes] = useState<Map<string, Finding[]>>(new Map())
  const [stepOverrides, setStepOverrides] = useState<Map<string, StepOverride>>(new Map())
  /**
   * Per-part NC edits (a stray cut removed). These are the source of truth for the manufactured
   * model and the export: they override the bundled `.nc1` bytes and mark the part export-ready.
   */
  const [ncOverrides, setNcOverrides] = useState<Map<string, NcOverride>>(new Map())
  /** Per-part cut-reach failures (a bevel whose bore exceeds the head's pierce cap). */
  const [reachChecks, setReachChecks] = useState<Map<string, CutReachFailure[]>>(new Map())
  /** Per-part bevel-change lines (one cut line whose bevel is not a single angle). */
  const [bevelChanges, setBevelChanges] = useState<Map<string, BevelChangeIssue[]>>(new Map())
  /** Per-part unclosed / stray cuts (a cut that doesn't run edge to edge). */
  const [unclosedCuts, setUnclosedCuts] = useState<Map<string, UnclosedCutIssue[]>>(new Map())
  /** Per-part longitudinal cuts running on a rolled root fillet (UB/WB/UC/WC/TFB). */
  const [rootFilletChecks, setRootFilletChecks] = useState<Map<string, RootFilletIssue[]>>(
    new Map(),
  )
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
    setAssemblyFilter(null)
    setAnalyzing(true)
    clearViewerModels()
    setResult(auditEntries(input.sourceName, input.entries))
  }, [])

  /** A planning setting, so save it straight away — it is tiny and has no fix to commit. */
  const changeBatches = useCallback(
    (next: number) => {
      const value = normalizeBatches(next)
      setBatches(value)
      void saveProjectBatches(projectId, value).catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
    },
    [projectId],
  )

  /**
   * Adds a drop to the loaded job: a same-path file replaces the old one, everything else is kept
   * and appended. New entries go first so a part that the export renamed (`old/M-1.nc1` →
   * `job/M-1.nc1`) audits the new file — the audit keeps the first file it sees per mark.
   */
  const addToBundle = useCallback(
    (input: InputBundle) => {
      if (!bundle) {
        handleBundle(input)
        return
      }
      const added = new Map(input.entries.map((entry) => [entry.path, entry]))
      if (added.size === 0) return
      const replaced = bundle.entries.filter((entry) => added.has(entry.path))
      const entries = [
        ...added.values(),
        ...bundle.entries.filter((entry) => !added.has(entry.path)),
      ]
      // A replaced file invalidates that part's edits: an NC op is indexed into the old text.
      const marks = new Set(replaced.map((entry) => markFromFilename(entry.path)))
      setError(null)
      setBundle({ ...bundle, entries })
      setViewing(null)
      setNcOverrides((prev) => withoutKeys(prev, marks))
      setStepOverrides((prev) => withoutKeys(prev, marks))
      setResolvedFixes((prev) => withoutKeys(prev, marks))
      setResult(auditEntries(bundle.sourceName, entries))
      // Only the dropped records are written, so adding a part to a big job stays cheap.
      void putProjectFiles(projectId, bundle.sourceName, input.entries).catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
    },
    [bundle, handleBundle, projectId],
  )

  /**
   * One drop listener for the page: a drop anywhere loads a job, or adds to the loaded one. The
   * card can be collapsed, so the visible zone is a target, not the only way in.
   */
  useEffect(
    () =>
      onGlobalDrop((input) => {
        void (async () => {
          try {
            const dropped = await readDroppedInput(input)
            if (dropped.entries.length === 0) {
              setError(t('dropzone.noFiles'))
              return
            }
            if (bundle) addToBundle(dropped)
            else handleBundle(dropped)
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          }
        })()
      }),
    [bundle, addToBundle, handleBundle, t],
  )

  /** Back to the empty page: no job, no derived state (the drop zone is all that is left). */
  const clearBundle = useCallback(() => {
    setError(null)
    setBundle(null)
    setResult(null)
    setViewing(null)
    setStepOverrides(new Map())
    setNcOverrides(new Map())
    setResolvedFixes(new Map())
    setSelectedMarks(new Set())
    selectAnchor.current = null
    setMarkQuery('')
    setAssemblyFilter(null)
    clearViewerModels()
  }, [])

  /**
   * Drops files from the loaded job and re-audits what is left. A part that loses a file also loses
   * its applied fix: an NC edit is indexed into that NC's text and a STEP override into that STEP,
   * so keeping either would aim the fix at a line that no longer exists.
   */
  const deleteEntries = useCallback(
    (paths: string[]) => {
      if (!bundle || paths.length === 0) return
      const drop = new Set(paths)
      const removed = bundle.entries.filter((entry) => drop.has(entry.path))
      if (removed.length === 0) return
      const entries = bundle.entries.filter((entry) => !drop.has(entry.path))
      if (entries.length === 0) {
        // Deleting the last file deletes the project: there is nothing left to reopen.
        clearBundle()
        void deleteProject(projectId)
          .then(() => navigate({ to: '/preflight' }))
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        return
      }
      const marks = new Set(removed.map((entry) => markFromFilename(entry.path)))
      setBundle({ ...bundle, entries })
      setViewing(null)
      setNcOverrides((prev) => withoutKeys(prev, marks))
      setStepOverrides((prev) => withoutKeys(prev, marks))
      setResolvedFixes((prev) => withoutKeys(prev, marks))
      setSelectedMarks((prev) => {
        const next = new Set(prev)
        for (const mark of marks) next.delete(mark)
        return next.size === prev.size ? prev : next
      })
      setResult(auditEntries(bundle.sourceName, entries))
      // Keep the saved copy in step: only the removed records are touched.
      void removeProjectFiles(projectId, [...drop]).catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
    },
    [bundle, clearBundle, navigate, projectId],
  )

  /**
   * Opens the project the route points at. A freshly imported job is handed over in memory (see
   * `handOffProject`), so an import doesn't have to be written and read straight back.
   */
  const openedProject = useRef<string | null>(null)
  /** The edits last written to the project, per mark, so a change saves only what changed. */
  const savedEdits = useRef(new Map<string, ProjectEdit>())
  useEffect(() => {
    if (openedProject.current === projectId) return
    let cancelled = false
    setLoadingProject(true)
    setMissingProject(false)
    void (async () => {
      try {
        const opened = takeHandOffProject(projectId) ?? (await loadProject(projectId))
        if (cancelled) return
        if (!opened) {
          setMissingProject(true)
          setLoadingProject(false)
          return
        }
        const saved = await loadProjectEdits(projectId)
        const meta = await getProjectMeta(projectId)
        if (cancelled) return
        openedProject.current = projectId
        setBatches(normalizeBatches(meta?.batches))
        handleBundle(opened)
        // The fixes travel with the project: NC edits (with their ops), STEP replacements, and the
        // resolved rows that keep their Undo available.
        const nc = new Map<string, NcOverride>()
        const step = new Map<string, StepOverride>()
        const resolved = new Map<string, Finding[]>()
        savedEdits.current = new Map()
        for (const [mark, edit] of saved) {
          if (edit.nc) nc.set(mark, edit.nc)
          if (edit.step) step.set(mark, edit.step)
          if (edit.resolved) resolved.set(mark, edit.resolved)
          savedEdits.current.set(mark, edit)
        }
        setNcOverrides(nc)
        setStepOverrides(step)
        setResolvedFixes(resolved)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setMissingProject(true)
      } finally {
        if (!cancelled) setLoadingProject(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, handleBundle])

  /**
   * Saves the applied fixes as they change. Compares against what was last written per mark, so a
   * fix writes one record (its NC is kilobytes; a STEP override is megabytes) instead of the job.
   */
  useEffect(() => {
    if (!bundle || loadingProject || missingProject) return
    const marks = new Set([
      ...ncOverrides.keys(),
      ...stepOverrides.keys(),
      ...resolvedFixes.keys(),
      ...savedEdits.current.keys(),
    ])
    for (const mark of marks) {
      const nc = ncOverrides.get(mark)
      const step = stepOverrides.get(mark)
      const resolved = resolvedFixes.get(mark)
      const next: ProjectEdit = {}
      if (nc) next.nc = nc
      if (step) next.step = step
      if (resolved) next.resolved = resolved
      const previous = savedEdits.current.get(mark)
      if (
        previous &&
        previous.nc === next.nc &&
        previous.step === next.step &&
        previous.resolved === next.resolved
      ) {
        continue
      }
      if (!next.nc && !next.step && !next.resolved) {
        savedEdits.current.delete(mark)
        void saveProjectEdit(projectId, mark, null).catch((err) =>
          setError(err instanceof Error ? err.message : String(err)),
        )
      } else {
        savedEdits.current.set(mark, next)
        void saveProjectEdit(projectId, mark, next).catch((err) =>
          setError(err instanceof Error ? err.message : String(err)),
        )
      }
    }
  }, [bundle, loadingProject, missingProject, projectId, ncOverrides, stepOverrides, resolvedFixes])

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
  /** NC header dims (or the detector's) for the viewed part's profile, for the Info tab section. */
  const viewingDims = useMemo(
    () => (viewing ? (viewing.nc?.dimensions ?? sectionGuesses.get(viewing.mark)?.dims ?? []) : []),
    [viewing, sectionGuesses],
  )

  const [fixingMark, setFixingMark] = useState<string | null>(null)
  /** The `CUT_BEVEL_CHANGE` finding whose "unify bevel" mini menu is open, if any. */
  const [bevelEdit, setBevelEdit] = useState<{ part: PartRecord; finding: Finding } | null>(null)
  /** The menu's angle field (deg); prefilled with the recommended angle. */
  const [bevelAngle, setBevelAngle] = useState('')
  /** The `CUT_ROOT_FILLET` finding whose "move cut" menu is open, if any. */
  const [moveEdit, setMoveEdit] = useState<{ part: PartRecord; finding: Finding } | null>(null)
  /** The menu's offset field (signed NC-Y mm); prefilled with the suggested offset. */
  const [moveOffset, setMoveOffset] = useState('')
  /** The part whose "add tabs" dialog is open, if any. */
  const [tabEdit, setTabEdit] = useState<PartRecord | null>(null)
  /** Tab settings, persisted across jobs (the nested-STEP handling aid, not a cut setting). */
  const [tabDensity, setTabDensity] = useState(() =>
    readPrefString('tabDensity', String(TAB_DENSITY_DEFAULT)),
  )
  const [tabLength, setTabLength] = useState(() =>
    readPrefString('tabLength', String(TAB_LENGTH_DEFAULT)),
  )
  const [tabWidth, setTabWidth] = useState(() =>
    readPrefString('tabWidth', String(TAB_WIDTH_DEFAULT)),
  )
  const [tabEngagement, setTabEngagement] = useState(() =>
    readPrefString('tabEngagement', String(TAB_ENGAGEMENT_DEFAULT)),
  )
  const [tabDetected, setTabDetected] = useState<TabDefaults | null>(null)
  const [tabDetecting, setTabDetecting] = useState(false)
  useEffect(() => writePrefString('tabDensity', tabDensity), [tabDensity])
  useEffect(() => writePrefString('tabLength', tabLength), [tabLength])
  useEffect(() => writePrefString('tabWidth', tabWidth), [tabWidth])
  useEffect(() => writePrefString('tabEngagement', tabEngagement), [tabEngagement])
  /** The viewed part's own NC edit, if any — not the whole map, so other parts' fixes don't re-run it. */
  const viewingNcOverride = viewing ? ncOverrides.get(viewing.mark) : undefined
  const ncBytes = viewing?.nc
    ? (viewingNcOverride?.bytes ?? bytesByPath.get(viewing.nc.path))
    : undefined
  const stepBytes = viewing
    ? (stepOverrides.get(viewing.mark)?.bytes ??
      (viewing.step ? bytesByPath.get(viewing.step.path) : undefined))
    : undefined
  /** Canonical PartIR from the effective NC — the source of truth for visualisation. */
  const viewingNcIr = useMemo(() => {
    if (!ncBytes) return null
    try {
      return partIrFromNc(new TextDecoder().decode(ncBytes))
    } catch {
      return null
    }
  }, [ncBytes])
  // Face-space geometry for the existing 3D projector, transformed from the IR. Fall back to the
  // raw NC only when the IR cannot be built (unsupported/malformed input).
  const viewingNcGeom = useMemo(() => {
    if (!ncBytes) return null
    if (viewingNcIr) return partIrToNcGeometry(viewingNcIr)
    return parseNcGeometry(new TextDecoder().decode(ncBytes))
  }, [ncBytes, viewingNcIr])
  // The exact (un-inflated) section the NC was matched against, so the projected toolpath lands
  // on the real manufactured surface rather than the inflated ghost outline.
  const viewingNcSection = useMemo(() => {
    if (!viewing?.nc) return null
    return partSectionForCode(viewing.nc.profile, viewing.nc.dimensions ?? [])?.points ?? null
  }, [viewing])
  // STEP-only: the section **detector's** catalogue section is the canonical stance. The stock ghost
  // must always be canonical — it is the manufacturing benchmark — so a STEP-only part uses the
  // catalogue section (from the detected code), never the measured outline (the STEP's own stance).
  const viewingStepSection = useMemo(() => {
    if (viewing?.nc) return null
    const guess = viewing ? sectionGuesses.get(viewing.mark) : undefined
    if (!guess) return null
    return partSectionForCode(guess.code, guess.dims ?? [])
  }, [viewing, sectionGuesses])
  // STEP → IR must never read the NC. Use the STEP/drawing detector's profile, dims and catalogue
  // section, plus the STEP-read length. NC-only fallbacks are deliberately excluded here.
  const stepIrGuess = viewing ? sectionGuesses.get(viewing.mark) : undefined
  const stepIrSection = useMemo(
    () => (stepIrGuess ? partSectionForCode(stepIrGuess.code, stepIrGuess.dims ?? []) : null),
    [stepIrGuess],
  )
  const stepIrProfile = stepIrGuess?.code ?? viewing?.expected?.profile ?? null
  const stepIrDims = useMemo(
    () =>
      stepIrProfile
        ? layoutDimensions(
            stepIrProfile,
            stepIrGuess?.dims ?? [],
            stepIrSection?.points ?? undefined,
            stepIrSection?.holes,
          )
        : [],
    [stepIrProfile, stepIrGuess, stepIrSection],
  )
  const stepIrRadius = useMemo(() => {
    const fromGuess = stepIrGuess?.dims?.[4]
    if (fromGuess != null && fromGuess > 0) return fromGuess
    const section = stepIrSection
    const hole = section?.holes?.[0]
    if (!section || !hole) return 0
    const span = (points: [number, number][], axis: 0 | 1): number => {
      let min = Number.POSITIVE_INFINITY
      let max = Number.NEGATIVE_INFINITY
      for (const point of points) {
        min = Math.min(min, point[axis])
        max = Math.max(max, point[axis])
      }
      return max - min
    }
    const wall = Math.min(
      (span(section.points, 0) - span(hole, 0)) / 2,
      (span(section.points, 1) - span(hole, 1)) / 2,
    )
    return wall > 0 ? 2.5 * wall : 0
  }, [stepIrGuess, stepIrSection])

  const stepFaceFrame = useMemo(
    () =>
      stepIrProfile && stepIrSection ? frameForProfile(stepIrProfile, stepIrSection.points) : null,
    [stepIrProfile, stepIrSection],
  )
  const stepCutThicknesses = useMemo(
    () => stockThicknessesFor(stepIrProfile, stepIrSection?.points ?? null, stepIrSection?.holes),
    [stepIrProfile, stepIrSection],
  )
  const stepCutEdgeOptions = useMemo(
    () => ({
      thicknesses: stepCutThicknesses,
      profile: stepIrProfile,
      radius: stepIrRadius,
    }),
    [stepCutThicknesses, stepIrProfile, stepIrRadius],
  )

  const viewerStock = useMemo(() => {
    if (!viewingStepSection || viewingStepSection.points.length < 3) return stock
    return {
      points: viewingStepSection.points,
      holes: viewingStepSection.holes,
      label: stock?.label ?? 'section',
      mass: stock?.mass,
    }
  }, [viewingStepSection, stock])
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
  // STEP cut-edge colouring: the ideal model's cut edges on its accessible faces, keyed to the
  // stock's face→thickness map. `profile` lets the viewer resolve the target faces for the right
  // family — including a STEP-only part, where the section detector still knows the code.
  const viewingProfileCode =
    viewing?.nc?.profile ??
    (viewing ? sectionGuesses.get(viewing.mark)?.code : undefined) ??
    viewing?.expected?.profile ??
    null
  // The four DSTV faces in the canonical cross-section, for the static face map by the location
  // arrow. Use the documented letter→edge table, not the runtime cut projection: on a one-sided
  // section (channel, T) two letters can resolve onto the same material side even though they are
  // opposite faces of the section.
  const viewingFaceMap = useMemo<FaceMapEntry[] | null>(() => {
    const family = viewingProfileCode ? profileFamily(viewingProfileCode) : null
    if (!family) return null
    return (['o', 'u', 'v', 'h'] as NcFace[]).map((face) => {
      const { dx, dy } = FACE_DIRECTIONS[family][face]
      return { face, dx, dy }
    })
  }, [viewingProfileCode])
  // No NC means no face frame, but the stock outline still tells us each cut face's wall. Key the
  // thickness off the section spec where the family is known (a UB's tf/tw), so the STEP colours
  // and legend read the real plate, not a measurement across the whole section.
  const viewingStockThicknesses = useMemo(
    () =>
      stockThicknessesFor(
        viewingProfileCode,
        viewingNcSection ?? viewingStepSection?.points ?? stock?.points ?? null,
        viewingStepSection?.holes ?? stock?.holes,
      ),
    [viewingProfileCode, viewingNcSection, viewingStepSection, stock],
  )
  const viewingCutThicknesses =
    viewingNcProfiles.length > 0 ? viewingNcProfiles : viewingStockThicknesses
  /** Face-thickness colours for the IR view, using the same palette as the 3D cut legend. */
  const viewingIrColorForFace = useMemo(() => {
    const section =
      viewingNcSection ??
      viewingStepSection?.points ??
      (Array.isArray(stock?.points) ? stock.points : null)
    if (!section || viewingCutThicknesses.length === 0) return undefined
    const frame =
      viewingNcFrame ?? (viewingProfileCode ? frameForProfile(viewingProfileCode, section) : null)
    if (!frame) return undefined
    return (face: NcFace): string | undefined => {
      const thickness = Math.round(faceThickness(frame, section, face) * 10) / 10
      const index = viewingCutThicknesses.indexOf(thickness)
      if (index < 0) return undefined
      const color = THICKNESS_COLORS[index % THICKNESS_COLORS.length] as number
      return `#${color.toString(16).padStart(6, '0')}`
    }
  }, [
    viewingNcSection,
    viewingStepSection,
    stock,
    viewingNcFrame,
    viewingProfileCode,
    viewingCutThicknesses,
  ])
  /**
   * STEP → NCEP (surface scaffold). Develop the real part's cut edges onto the *same* unrolled net
   * the NC path uses, so the NCEP tab can show both conversions and their differences. Meshing is
   * the viewer's cached worker result; the development itself is the shared surface core.
   */
  // Lock the first seat chosen for a mark. A late-arriving detector seat used to re-seat the
  // 3-D pane and rebuild IR, which looked like a random rotate + reload.
  const stepSeatByMark = useRef(new Map<string, import('@/lib/step/seat').SectionSeat | null>())
  const stepIrMarkRef = useRef<string | null>(null)
  const stepSeatForViewing = useMemo(() => {
    if (!viewing) return null
    if (!stepSeatByMark.current.has(viewing.mark))
      stepSeatByMark.current.set(viewing.mark, stepIrGuess?.seat ?? null)
    return stepSeatByMark.current.get(viewing.mark) ?? null
  }, [viewing, stepIrGuess])

  const [viewingStepIr, setViewingStepIr] = useState<PartIr | null>(null)
  useEffect(() => {
    if (stepIrMarkRef.current !== (viewing?.mark ?? null)) {
      stepIrMarkRef.current = viewing?.mark ?? null
      setViewingStepIr(null)
    }
    if (!viewing || !stepBytes) return
    let cancelled = false
    const start = (
      profile: string,
      dims: number[],
      section: [number, number][],
      innerSection: [number, number][] | undefined,
      radius: number,
      seat: import('@/lib/step/seat').SectionSeat | null,
    ): void => {
      const build = (meshed: import('@/lib/step/mesh').MeshedStep): void => {
        try {
          const ir = partIrFromStepMesh(meshed, {
            mark: `${viewing.mark} · STEP`,
            profile,
            dimensions: dims,
            length: stepLengths.get(viewing.mark) ?? 0,
            section,
            innerSection,
            radius,
            seat,
          })
          if (!cancelled) setViewingStepIr(ir)
        } catch {
          if (!cancelled) setViewingStepIr(null)
        }
      }
      const cached = peekMeshForViewer(stepBytes)
      if (cached) {
        build(cached)
        return
      }
      void meshForViewer(viewing.step?.path ?? viewing.mark, stepBytes)
        .then(build)
        .catch(() => {
          if (!cancelled) setViewingStepIr(null)
        })
    }

    const ready =
      stepIrProfile && stepIrSection && stepIrDims.length >= 2 && stepIrSection.points.length >= 3
    if (ready) {
      start(
        stepIrProfile,
        stepIrDims,
        stepIrSection.points,
        stepIrSection.holes?.[0],
        stepIrRadius,
        stepSeatForViewing,
      )
      return () => {
        cancelled = true
      }
    }

    // Independent fallback: read the section from the STEP itself if the analysis map has not
    // populated yet. Never fall back to NC.
    void detectStepSection(stepBytes)
      .then((guess) => {
        if (cancelled || !guess) return
        const profile = stepIrProfile ?? guess.code
        const part = partSectionForCode(guess.code, guess.dims ?? [])
        const section = part?.points ?? null
        const dims =
          stepIrDims.length >= 2
            ? stepIrDims
            : layoutDimensions(guess.code, guess.dims ?? [], part?.points, part?.holes)
        if (!profile || !section || section.length < 3 || dims.length < 2) return
        start(
          profile,
          dims,
          section,
          part?.holes?.[0],
          stepIrRadius || guess.dims?.[4] || 0,
          stepSeatForViewing,
        )
      })
      .catch(() => {
        if (!cancelled) setViewingStepIr(null)
      })

    return () => {
      cancelled = true
    }
  }, [
    viewing,
    stepBytes,
    stepIrProfile,
    stepIrDims,
    stepIrSection,
    stepLengths,
    stepIrRadius,
    stepSeatForViewing,
  ])

  // Legend chips only for the mark channels the parsed NC actually carries (`SI` etch,
  // `PU`/`KO` scribe), so the key never promises lines the viewer cannot draw.
  const viewingMarkKinds = useMemo(() => {
    const kinds = new Set<'etch' | 'marking'>()
    for (const mark of viewingNcGeom?.marks ?? []) kinds.add(mark.kind)
    return [...kinds]
  }, [viewingNcGeom])
  // The viewed member's total length (mm), reported by the 3D viewer, so the direction arrow can
  // carry a marker showing where along the body the orbit pivot currently sits.
  const [viewingLength, setViewingLength] = useState<number | null>(null)

  // Manufactured model = the stock with the NC applied, rebuilt from the NC (T profiles only).
  const [manufactured, setManufactured] = useState<Uint8Array | null>(null)
  const [mfgStatus, setMfgStatus] = useState<'idle' | 'pending' | 'failed'>('idle')
  const viewingMark = viewing?.mark
  const viewingHasStep = Boolean(viewing?.step)
  // The viewed part's sabre comes from `sabreChecks` (analysis for STEP parts, the probe below for
  // no-STEP parts), so there is no duplicate sabre state.
  const manufacturedSabre = viewingMark
    ? (sabreRecheck.get(viewingMark) ?? sabreChecks.get(viewingMark) ?? null)
    : null
  // Stable identity: a fresh `.map` each render re-runs the viewer's scene effect (rebuilding the
  // whole three.js scene) and makes orbiting lag.
  const manufacturedSabrePoints = useMemo(
    () =>
      manufacturedSabre?.map((failure) => ({
        point: failure.point,
        normal: failure.normal,
        entry: failure.entry,
        exit: failure.exit,
        depth: failure.depth,
      })) ?? null,
    [manufacturedSabre],
  )
  useEffect(() => {
    if (!ncBytes) {
      setManufactured(null)
      setMfgStatus('idle')
      return
    }
    const ncText = new TextDecoder().decode(ncBytes)
    // A cached rebuild paints immediately; only the first open shows "building".
    const cached = peekReconstructForViewer(ncText)
    setManufactured(cached)
    setMfgStatus(cached ? 'idle' : 'pending')
    let cancelled = false
    // A STEP part's sabre is already produced by its foreground analysis rebuild, and its viewer
    // rebuild is cheap/separate. A no-STEP part needs both the probe and the STEP, so build it
    // once and share the result (the background pass primes the same cache key). An NC edit makes
    // the stored sabre stale, so re-probe the edited NC too.
    const hasNcOverride = Boolean(viewingNcOverride)
    if (!viewingHasStep || hasNcOverride) {
      void reconstructViewerWithSabre(ncText).then(
        ({ bytes, sabre }) => {
          if (cancelled) return
          if (viewingMark) {
            if (hasNcOverride) setSabreRecheck((prev) => new Map(prev).set(viewingMark, sabre))
            else setSabreChecks((prev) => new Map(prev).set(viewingMark, sabre))
          }
          if (bytes) setManufactured(bytes)
          // reconstruction is best-effort; a null/failed build falls back to the STEP view
          else setMfgStatus('failed')
        },
        () => {
          if (!cancelled) setMfgStatus('failed')
        },
      )
    } else {
      void reconstructForViewer(ncText).then(
        (step) => {
          if (cancelled) return
          if (step) setManufactured(step)
          else setMfgStatus('failed')
        },
        () => {
          if (!cancelled) setMfgStatus('failed')
        },
      )
    }
    return () => {
      cancelled = true
    }
  }, [ncBytes, viewingMark, viewingHasStep, viewingNcOverride])

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
  /** The IR mirrors the visible 3D panes: STEP, NC, and the NC/STEP cut diff. */
  const irViews = useMemo<IrSurfaceView[]>(() => {
    const views: IrSurfaceView[] = []
    if (stepShown)
      views.push({
        id: 'step',
        label: t('preflight.viewer.step'),
        nc: null,
        step: viewingStepIr,
      })
    if (manufacturedShown)
      views.push({
        id: 'nc',
        label: t('preflight.viewer.ncSurface'),
        nc: viewingNcIr,
        step: null,
      })
    if (overlayShown && viewingNcIr && viewingStepIr)
      views.push({
        id: 'diff',
        label: t('viewer.diff'),
        nc: viewingNcIr,
        step: viewingStepIr,
        diff: true,
      })
    if (views.length === 0) {
      if (viewingNcIr)
        views.push({
          id: 'nc',
          label: t('preflight.viewer.ncSurface'),
          nc: viewingNcIr,
          step: null,
        })
      else if (viewingStepIr)
        views.push({
          id: 'step',
          label: t('preflight.viewer.step'),
          nc: null,
          step: viewingStepIr,
        })
    }
    return views
  }, [stepShown, manufacturedShown, overlayShown, viewingNcIr, viewingStepIr, t])

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
  /** Issue indices the user has hidden — everything else renders in the 3D. Default: all shown. */
  const [hiddenIssues, setHiddenIssues] = useState<Set<number>>(new Set())
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
  // Optimistic load: hovering/focusing a row starts its manufactured rebuild after a short
  // debounce (neighbour priority). Clicking then opens from the primed cache.
  const prefetchTimer = useRef<number | null>(null)
  const prefetchPart = useCallback(
    (part: PartRecord) => {
      if (prefetchTimer.current != null) window.clearTimeout(prefetchTimer.current)
      prefetchTimer.current = window.setTimeout(() => {
        prefetchTimer.current = null
        const ncPath = part.nc?.path
        const bytes = ncPath ? bytesByPath.get(ncPath) : undefined
        if (!bytes) return
        const ncText = new TextDecoder().decode(bytes)
        if (peekReconstructForViewer(ncText)) return
        void reconstructViewerWithSabre(ncText, { priority: PRIORITY_NEIGHBOR })
          .then(({ bytes: made }) => {
            if (made) {
              void meshForViewer(`${part.mark} · manufactured`, made, {
                priority: PRIORITY_NEIGHBOR,
              }).catch(() => {})
            }
          })
          .catch(() => {})
      }, 250)
    },
    [bytesByPath],
  )

  const openPart = useCallback((part: PartRecord) => {
    setOrbitBus(createOrbitBus())
    setFindingFocus(null)
    setHoverIssueIndex(null)
    setHiddenIssues(new Set())
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
    const source = finding.params?.nc === 1 ? 'nc' : undefined
    setFindingFocus((prev) => ({
      code: finding.code,
      token: (prev?.token ?? 0) + 1,
      index,
      source,
    }))
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

  /**
   * Expensive per-part results, keyed by the **identity of the input bytes**. The analysis below
   * re-runs whenever the audit result changes — dropping a file, adding one, removing one — and
   * re-inspecting every STEP and re-rebuilding every NC on each of those is what made a single
   * delete take minutes. Unchanged files hit these caches, so only the cheap checks re-run.
   *
   * Identity rather than a content hash: `readInput` keeps the same `Uint8Array` for an entry that
   * didn't change, and a replaced file is a new one, so this is exact and costs nothing to compute.
   */
  const fileStamp = useRef(createFileStamp())
  const stampOf = fileStamp.current
  const inspectCache = useRef(new Map<string, { step: string; result: InspectResult }>())
  const rebuildCache = useRef(
    new Map<string, { nc: string; step: string; result: ReconstructResult }>(),
  )
  const materialCache = useRef(new Map<string, { pdf: string; material: DrawingMaterial | null }>())

  // Read the drawings (ground-truth qty/length) first — parsed concurrently, since pdf.js does the
  // work off-thread. Then the CPU-bound STEP work (measure, light-sabre, NC rebuild) runs across a
  // small pool of OCC workers, off the main thread and in parallel across parts.
  useEffect(() => {
    if (!result) {
      setAnalyzing(false)
      return
    }
    // Drop cached work for parts that are gone, so a long session doesn't accumulate them.
    const liveMarks = new Set(result.parts.map((part) => part.mark))
    for (const cache of [inspectCache.current, rebuildCache.current, materialCache.current]) {
      for (const mark of [...cache.keys()]) if (!liveMarks.has(mark)) cache.delete(mark)
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
    setWeldEtchings(new Map())
    // Keep only marks that exist in the new result (stale entries would leak across jobs).
    setSabreChecks((prev) => {
      const marks = new Set(result.parts.map((part) => part.mark))
      const next = new Map<string, SabreFailure[]>()
      for (const [mark, failures] of prev) if (marks.has(mark)) next.set(mark, failures)
      return next
    })
    setSabreRecheck(new Map())
    setResolvedFixes(new Map())
    setReachChecks(new Map())
    setBevelChanges(new Map())
    setUnclosedCuts(new Map())
    setRootFilletChecks(new Map())
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
      const rootFillet = new Map<string, RootFilletIssue[]>()
      const weld = new Map<string, WeldingEtchings>()
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
        const etchings = findWeldingEtchings(ncText, part.mark)
        if (etchings) weld.set(part.mark, etchings)
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
        // One parse feeds every cut check below — each of them re-parses the whole NC otherwise,
        // which is seconds of blocking work across a large job.
        const nc = parseNcGeometry(ncText)
        const bevelIssues = assessBevelChangeGeometry(nc)
        if (bevelIssues.length > 0) bevel.set(part.mark, bevelIssues)
        const section = part.nc?.profile
          ? partSectionForCode(part.nc.profile, part.nc.dimensions ?? [])
          : null
        const unclosedIssues = assessUnclosedCutsGeometry(nc, {
          section: section?.points,
          profile: part.nc?.profile,
        })
        if (unclosedIssues.length > 0) unclosed.set(part.mark, unclosedIssues)
        if (!section) {
          const profile = part.nc?.profile ?? '?'
          markUnchecked(part.mark, `unrecognised section ${profile}`, { profile })
          continue
        }
        const failures = assessCutReachGeometry(nc, section.points, section.holes ?? [], {
          toleranceMm: MACHINE.placementToleranceMm,
          profile: part.nc?.profile,
        }).filter(
          // Retired the 2D reach-depth finding: it reads a lengthwise pass (e.g. a tab edge
          // across the web) as a deep bore. Keep only the corner-placement risk; the 3D sabre
          // remains the real cut-depth check.
          (failure) => failure.reason === 'corner',
        )
        if (failures.length > 0) reach.set(part.mark, failures)
        const filletIssues = assessRootFilletGeometry(nc, {
          section: section.points,
          dimensions: part.nc?.dimensions ?? [],
          profile: part.nc?.profile,
        })
        if (filletIssues.length > 0) rootFillet.set(part.mark, filletIssues)
      }
      if (cancelled) return
      if (issues.size > 0) setCutIssues(new Map(issues))
      if (reach.size > 0) setReachChecks(new Map(reach))
      if (bevel.size > 0) setBevelChanges(new Map(bevel))
      if (unclosed.size > 0) setUnclosedCuts(new Map(unclosed))
      if (rootFillet.size > 0) setRootFilletChecks(new Map(rootFillet))
      if (weld.size > 0) setWeldEtchings(new Map(weld))

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
            const pdfStamp = stampOf(bytes)
            const cachedMaterial = materialCache.current.get(part.mark)
            if (cachedMaterial && cachedMaterial.pdf === pdfStamp) {
              if (cachedMaterial.material) materials.set(part.mark, cachedMaterial.material)
            } else {
              try {
                const material = await resolveDrawingMaterial(bytes, part.mark)
                materialCache.current.set(part.mark, { pdf: pdfStamp, material: material ?? null })
                if (material) materials.set(part.mark, material)
              } catch {
                // ignore an unreadable drawing
              }
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
            // NC-only part (no STEP to measure): the nominal size comes straight from the NC
            // header — length + cross-section dims — so the model-size column still reads a size.
            const length =
              materials.get(part.mark)?.length ?? part.expected?.length ?? part.nc?.length
            const ncSize =
              length != null ? ncOnlySizeCheck(length, part.nc?.dimensions ?? []) : null
            publishInspect(part.mark, ncSize ?? { ok: false, error: 'noDims' })
            return
          }
          // Length is compared against the drawing (ground truth) when available.
          const length =
            materials.get(part.mark)?.length ?? part.expected?.length ?? part.nc?.length
          const cross = part.nc?.dimensions?.slice(0, 2) ?? []
          // Always read the section from the STEP: the STEP → IR path must not fall back to NC.
          const needSection = true
          try {
            // Reuse the OCC inspect for an unchanged STEP: measuring every part again is the bulk
            // of the work, and a re-audit usually leaves most STEPS untouched.
            const stepStamp = stampOf(bytes)
            const cachedInspect = inspectCache.current.get(part.mark)
            const inspected =
              cachedInspect && cachedInspect.step === stepStamp
                ? cachedInspect.result
                : await pool.inspect(bytes, { detectSection: needSection })
            if (!cachedInspect || cachedInspect.step !== stepStamp) {
              inspectCache.current.set(part.mark, { step: stepStamp, result: inspected })
            }
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
            const ncText = new TextDecoder().decode(ncBytes)
            // Rebuilding from the NC is the most expensive step; reuse it while the NC and the
            // STEP it is compared against are the same bytes.
            const ncStamp = stampOf(ncBytes)
            const stepStamp = stampOf(part.step ? bytesByPath.get(part.step.path) : undefined)
            const cachedRebuild = rebuildCache.current.get(part.mark)
            const made =
              cachedRebuild && cachedRebuild.nc === ncStamp && cachedRebuild.step === stepStamp
                ? cachedRebuild.result
                : await pool.reconstruct(ncText, {
                    measure: true,
                  })
            if (
              !cachedRebuild ||
              cachedRebuild.nc !== ncStamp ||
              cachedRebuild.step !== stepStamp
            ) {
              // Keep the measure and the sabre rows, not the STEP text: the viewer cache already
              // holds those, and a copy per part would cost megabytes for nothing.
              rebuildCache.current.set(part.mark, {
                nc: ncStamp,
                step: stepStamp,
                result: { ...made, step: null },
              })
            }
            if (cancelled) return
            // The export is cheap and lets the viewer open this part from cache.
            if (made.step) primeReconstructForViewer(ncText, made.step)
            if (made.sabre.length > 0) {
              setSabreChecks((prev) => new Map(prev).set(part.mark, made.sabre))
            }
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
  }, [result, bytesByPath, stampOf])

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
            // Always read the section from the STEP: the STEP → IR path must not fall back to NC.
            const inspected = await pool.inspect(stepBytes, {
              priority,
              detectSection: true,
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
            const ncText = new TextDecoder().decode(ncBytes)
            const made = await pool.reconstruct(ncText, {
              measure: true,
              priority,
            })
            if (!made.measure) return
            if (made.step) primeReconstructForViewer(ncText, made.step)
            if (made.sabre.length > 0) {
              setSabreChecks((prev) => new Map(prev).set(mark, made.sabre))
            }
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

  /**
   * Re-runs the NC cut checks on any part with an applied NC edit. The issue list is the check on
   * the **current NC**, so fixed issues simply disappear and remaining issues are re-reported.
   *
   * Cached per part on its override object: an auto-fix over many marks commits one override at a
   * time, and re-checking every already-edited part on each commit is O(n²) NC parses + ray probes
   * — the reason a big auto-fix used to lock the page up. Unchanged overrides reuse their result.
   */
  const ncRecheckCache = useRef(new Map<string, { override: NcOverride; value: NcRecheck }>())
  const ncRecheck = useMemo(() => {
    const out = new Map<string, NcRecheck>()
    const cache = ncRecheckCache.current
    if (!result) {
      cache.clear()
      return out
    }
    const live = new Set<string>()
    for (const part of result.parts) {
      const override = ncOverrides.get(part.mark)
      if (!override) continue
      live.add(part.mark)
      const cached = cache.get(part.mark)
      if (cached?.override === override) {
        out.set(part.mark, cached.value)
        continue
      }
      const section = part.nc?.profile
        ? partSectionForCode(part.nc.profile, part.nc.dimensions ?? [])
        : null
      if (!section) continue
      const ncText = new TextDecoder().decode(override.bytes)
      const options = { section: section.points, profile: part.nc?.profile }
      // All four checks run on one parse: each parses the whole NC on its own otherwise.
      const nc = parseNcGeometry(ncText)
      const value: NcRecheck = {
        reach: assessCutReachGeometry(nc, section.points, section.holes ?? [], {
          toleranceMm: MACHINE.placementToleranceMm,
          profile: part.nc?.profile,
        }).filter((failure) => failure.reason === 'corner'),
        rootFillet: assessRootFilletGeometry(nc, {
          ...options,
          dimensions: part.nc?.dimensions ?? [],
        }),
        bevel: assessBevelChangeGeometry(nc),
        unclosed: assessUnclosedCutsGeometry(nc, options),
      }
      cache.set(part.mark, { override, value })
      out.set(part.mark, value)
    }
    // Drop cache entries for parts whose override was undone, so the map can't grow across a job.
    for (const mark of cache.keys()) if (!live.has(mark)) cache.delete(mark)
    return out
  }, [result, ncOverrides])

  const allFindings = useMemo(() => {
    if (!result) return []
    const extra: Finding[] = []
    for (const part of result.parts) {
      // Issue checks are a pure function of the current NC (and its manufactured model). For an
      // edited part, use the rechecked results; otherwise the original analysis.
      const rechecked = ncRecheck.get(part.mark)
      const reach = rechecked?.reach ?? reachChecks.get(part.mark)
      const bevel = rechecked?.bevel ?? bevelChanges.get(part.mark)
      const unclosed = rechecked?.unclosed ?? unclosedCuts.get(part.mark)
      const fillet = rechecked?.rootFillet ?? rootFilletChecks.get(part.mark)
      const sabre = sabreRecheck.get(part.mark) ?? sabreChecks.get(part.mark)
      const material = drawingMaterials.get(part.mark)
      const qtyKnown =
        material != null ||
        part.expected?.qty != null ||
        part.nc?.quantity != null ||
        part.step?.quantity != null
      const qtyPending = !qtyKnown && part.pdf != null && drawingChecking
      if (!qtyKnown && !qtyPending) {
        extra.push({
          severity: 'warning',
          code: 'QTY_UNKNOWN',
          mark: part.mark,
          message: `Quantity for ${part.mark} cannot be determined — no drawing, part list, NC or STEP filename quantity`,
          params: { mark: part.mark },
        })
      }
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
          message: `Found ${check.bodies ?? '2+'} detached solid bodies`,
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
      // For an edited NC, detect CUT_DEPTH from the **new manufactured NC** only — never compare
      // old rows to new probe results.
      if (sabre && sabre.length > 0) {
        // One finding per failing run (a separate cut), so each can be navigated to in 3D. A cut
        // that stays inside the material past T + r has removed metal that cannot be put back —
        // scrap, so it is a hard error, not a warning.
        const runs: SabreFailure[][] = []
        let run: SabreFailure[] = []
        for (const failure of sabre) {
          const prev = run[run.length - 1]
          if (
            prev &&
            Math.hypot(
              failure.point[0] - prev.point[0],
              failure.point[1] - prev.point[1],
              failure.point[2] - prev.point[2],
            ) > 2.5
          ) {
            runs.push(run)
            run = []
          }
          run.push(failure)
        }
        if (run.length > 0) runs.push(run)
        runs.forEach((cut, index) => {
          const x = Math.round(cut.reduce((sum, f) => sum + f.point[0], 0) / cut.length)
          const depth = Math.max(...cut.map((f) => f.depth ?? 0))
          extra.push({
            severity: 'error',
            code: 'CUT_DEPTH',
            mark: part.mark,
            message: `${cut.length}mm cut of ${Math.round(depth)}mm depth removes additional material`,
            params: {
              index,
              samples: cut.length,
              x,
              nc: 1,
              span: String(cut.length),
              depth: String(Math.round(depth)),
            },
          })
        })
      }
      if (reach) {
        // Phase 0 keeps only corner-placement risks; the 2D reach-depth finding is retired.
        reach.forEach((failure, index) => {
          const tol = MACHINE.placementToleranceMm
          extra.push({
            severity: 'error',
            code: 'CUT_CORNER',
            mark: part.mark,
            message: `Cut lands on a corner: with the head's ±${tol} mm placement error, ${failure.spanMm.toFixed(0)} mm of the cut on face ${failure.face} can fall on the section's corner radius — the beam meets the curve at a bevel with no flat escape for the slag — not manufacturable`,
            params: {
              index,
              face: failure.face,
              x: Math.round((failure.from[0] + failure.to[0]) / 2),
              span: failure.spanMm.toFixed(0),
              tol: String(tol),
            },
          })
        })
      }
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
            params: {
              ...issue.params,
              index: base + index,
              contourIndex: issue.contourIndex,
              vertices: issue.vertices.join(','),
            },
          })
        })
      }
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
            params: {
              ...issue.params,
              index: base + index,
              contourIndex: issue.contourIndex,
              removal: issue.removal?.join(',') ?? '',
            },
          })
        })
      }
      if (fillet) {
        // One error per long cut running on a root fillet. Its marker continues after reach,
        // bevel and unclosed, matching `viewerSabreFailures`.
        const base = (reach?.length ?? 0) + (bevel?.length ?? 0) + (unclosed?.length ?? 0)
        fillet.forEach((issue, index) => {
          extra.push({
            severity: issue.severity,
            code: issue.code,
            mark: part.mark,
            message: issue.message,
            params: {
              ...issue.params,
              index: base + index,
              contourIndex: issue.contourIndex,
              vertices: issue.vertices.join(','),
            },
          })
        })
      }
      // Keep fixes that are no longer reported by the new-NC check as resolved rows (Undo), but
      // don't duplicate an issue that the check still reports — that active row already has Undo.
      const fixedRecords = resolvedFixes.get(part.mark)
      if (fixedRecords && fixedRecords.length > 0) {
        const activeKeys = new Set(
          extra
            .filter((finding) => finding.mark === part.mark)
            .map((finding) => findingOpKey(finding))
            .filter((key): key is string => key != null),
        )
        for (const record of fixedRecords) {
          const key = findingOpKey(record)
          if (key && activeKeys.has(key)) continue
          extra.push(record)
        }
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
    drawingChecking,
    modelChecks,
    manufactureChecks,
    geometryChecks,
    cutIssues,
    sabreChecks,
    sabreRecheck,
    ncRecheck,
    reachChecks,
    bevelChanges,
    unclosedCuts,
    rootFilletChecks,
    resolvedFixes,
    t,
  ])

  /**
   * Findings still open after the applied fixes. A fixed finding stays in `allFindings` as a
   * resolved row so the issues list can offer Undo, but it must not colour the part's status,
   * sort order, status counts or search tokens until that fix is undone.
   */
  const activeFindings = useMemo(
    () =>
      allFindings.filter((finding) => {
        if (finding.params?.resolved === 1) return false
        const override = finding.mark ? stepOverrides.get(finding.mark) : undefined
        return !(override && resolvedFindings(override.kind).includes(finding.code))
      }),
    [allFindings, stepOverrides],
  )

  /**
   * Pieces for a mark: drawing qty is ground truth, then the part list, then the NC batch qty,
   * then the `<n> OFF` token in the STEP filename. A part with none of those is a single piece.
   */
  const partQty = useCallback(
    (part: PartRecord): number =>
      drawingMaterials.get(part.mark)?.qty ??
      part.expected?.qty ??
      part.nc?.quantity ??
      part.step?.quantity ??
      1,
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
    for (const part of result.parts) total += partQty(part) * batches
    return total
  }, [result, partQty, batches])

  /** Cumulative cut length in mm (qty × length per mark, drawing length is ground truth). */
  const totalLengthMm = useMemo(() => {
    if (!result) return 0
    let total = 0
    for (const part of result.parts) {
      const length = partLength(part)
      if (length != null) total += partQty(part) * batches * length
    }
    return total
  }, [result, partLength, partQty, batches])

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
      // The NC header's own weight by metre (real Tekla data) wins over the catalogue lookup, so a
      // code the catalogue can't resolve (e.g. `UB360*57` vs `360UB56.7`) still gets a mass.
      const perMetre =
        part.nc?.weightPerMetre ??
        (profile != null
          ? sectionMassPerMetre(profile, part.nc?.dimensions ?? [])
          : (sectionGuesses.get(part.mark)?.mass ?? null))
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
      if (mass != null) total += partQty(part) * batches * mass
    }
    return total
  }, [result, pieceMass, partQty, batches])

  /** Per-profile rollup: pieces, cumulative length and mass, so stock/pickup can be planned. */
  const profileGroups = useMemo(() => {
    if (!result) return []
    const map = new Map<
      string,
      {
        marks: Map<string, ProfileMarkRow>
        pieces: number
        lengthMm: number
        massKg: number
        /** NC header dims from a representative part, for the cross-section + thicknesses. */
        dims: number[]
      }
    >()
    for (const part of result.parts) {
      const profile = sectionLabel(part)
      const entry = map.get(profile) ?? {
        marks: new Map<string, ProfileMarkRow>(),
        pieces: 0,
        lengthMm: 0,
        massKg: 0,
        dims: [],
      }
      if (entry.dims.length === 0) {
        const dims = part.nc?.dimensions ?? sectionGuesses.get(part.mark)?.dims ?? []
        if (dims.length > 0) entry.dims = dims
      }
      const qty = partQty(part) * batches
      const length = partLength(part)
      const mass = pieceMass(part)
      const mark = entry.marks.get(part.mark) ?? {
        mark: part.mark,
        pieces: 0,
        lengthMm: 0,
        massKg: 0,
      }
      mark.pieces += qty
      if (length != null) mark.lengthMm += qty * length
      if (mass != null) mark.massKg += qty * mass
      entry.marks.set(part.mark, mark)
      entry.pieces += qty
      if (length != null) entry.lengthMm += qty * length
      if (mass != null) entry.massKg += qty * mass
      map.set(profile, entry)
    }
    return [...map.entries()]
      .map(([profile, entry]) => ({
        profile,
        marks: [...entry.marks.values()].sort((a, b) =>
          a.mark.localeCompare(b.mark, undefined, { numeric: true }),
        ),
        markCount: entry.marks.size,
        pieces: entry.pieces,
        lengthMm: entry.lengthMm,
        massKg: entry.massKg,
        dims: entry.dims,
      }))
      .sort((a, b) => b.lengthMm - a.lengthMm || b.pieces - a.pieces)
  }, [result, pieceMass, sectionLabel, partQty, partLength, sectionGuesses, batches])

  /**
   * Purchase groups for the stock calculator. A T is bought as its parent UB (one beam gives two
   * T bars), so all T profiles that resolve to the same UB are nested together; every other
   * profile is nested on its own. Quantities carry the job's batch multiplier.
   */
  const purchaseGroups = useMemo(() => {
    if (!result) return []
    const map = new Map<string, PurchaseGroupInput>()
    for (const part of result.parts) {
      const length = partLength(part)
      const quantity = partQty(part) * batches
      if (length == null || length <= 0 || quantity <= 0) continue

      const profile = sectionLabel(part)
      const code =
        part.nc?.profile ?? listedProfile(part) ?? sectionGuesses.get(part.mark)?.code ?? ''
      const dims = part.nc?.dimensions ?? sectionGuesses.get(part.mark)?.dims ?? []
      const tee = code ? inferTee(code, dims) : null
      const key = tee ? `tee:${tee.section.designation}` : `profile:${profile}`
      const massPerMetre = tee
        ? tee.section.mass
        : (part.nc?.weightPerMetre ??
          sectionMassPerMetre(profile, dims) ??
          sectionGuesses.get(part.mark)?.mass ??
          null)

      let group = map.get(key)
      if (!group) {
        group = {
          key,
          stock: tee ? tee.section.designation : profile,
          sources: [],
          tee: Boolean(tee),
          massPerMetre,
          pieces: [],
        }
        map.set(key, group)
      } else if (massPerMetre != null) {
        group.massPerMetre =
          group.massPerMetre == null ? massPerMetre : Math.max(group.massPerMetre, massPerMetre)
      }
      if (profile !== '—' && !group.sources.includes(profile)) group.sources.push(profile)
      group.pieces.push({ mark: part.mark, lengthMm: length, quantity })
    }

    const totalLength = (group: PurchaseGroupInput) =>
      group.pieces.reduce((sum, piece) => sum + piece.lengthMm * piece.quantity, 0)
    return [...map.values()].sort((a, b) => totalLength(b) - totalLength(a))
  }, [result, partLength, partQty, sectionLabel, sectionGuesses, batches])

  /**
   * One status pill per distinct *active* finding code, so the parts table carries its own triage.
   * Pills are ordered worst-first then by code, so the same kind of problem sits in the same place
   * from row to row and the table can be scanned down a column of badges.
   */
  const issuesByMark = useMemo(() => {
    const map = new Map<string, StatusPill[]>()
    for (const finding of activeFindings) {
      if (!finding.mark) continue
      const mark = finding.mark
      const list = map.get(mark) ?? []
      const existing = list.find((pill) => pill.code === finding.code)
      if (existing) {
        existing.count++
      } else {
        list.push({
          code: finding.code,
          severity: finding.severity,
          count: 1,
          finding,
        })
      }
      map.set(mark, list)
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code),
      )
    }
    return map
  }, [activeFindings])

  /** Findings for the part currently open in the viewer, shown above the 3D to debug fast. */
  const viewerFindings = useMemo(
    () => (viewing ? allFindings.filter((finding) => finding.mark === viewing.mark) : []),
    [viewing, allFindings],
  )

  // The right pane swaps between the drawing, the issues list and the canonical surface view;
  // default to issues when there are any, since that's what needs attention.
  const [rightTab, setRightTab] = useState<'info' | 'drawing' | 'issues' | 'surface'>('drawing')
  /**
   * The part mark whose tab the operator chose manually. The default-tab effect keeps running as
   * analysis findings arrive; without this guard it yanks the pane back to Drawing/Issues.
   */
  const rightTabMark = useRef<string | null>(null)
  useEffect(() => {
    if (!viewing) {
      rightTabMark.current = null
      return
    }
    if (rightTabMark.current === viewing.mark) return
    setRightTab(
      allFindings.some((finding) => finding.mark === viewing.mark)
        ? 'issues'
        : viewingPdfBytes
          ? 'drawing'
          : 'surface',
    )
  }, [viewing, allFindings, viewingPdfBytes])

  /** Rows whose own NC edit is applied (their action is Undo). */
  const ncAppliedRows = useMemo(() => {
    const applied = new Set(
      (viewing ? (ncOverrides.get(viewing.mark)?.ops ?? []) : []).map((op) => op.key),
    )
    const rows = new Set<number>()
    viewerFindings.forEach((finding, row) => {
      const key = findingOpKey(finding)
      if (key && applied.has(key)) rows.add(row)
    })
    return rows
  }, [viewing, viewerFindings, ncOverrides])
  /** Rows that are resolved (fixed) and therefore have no active 3D marker. */
  const resolvedViewerRows = useMemo(() => {
    const rows = new Set<number>()
    const stepOverride = viewing ? stepOverrides.get(viewing.mark) : undefined
    viewerFindings.forEach((finding, index) => {
      const stepResolved = Boolean(
        stepOverride && resolvedFindings(stepOverride.kind).includes(finding.code),
      )
      if (stepResolved || finding.params?.resolved === 1) rows.add(index)
    })
    return rows
  }, [viewerFindings, stepOverrides, viewing])
  /** Marker indices whose sub-cuts are shown in the 3D (manual eye on, not resolved). */
  const visibleSpans = useMemo(
    () =>
      viewerFindings
        .map((finding, index) => ({ finding, index }))
        .filter(({ index }) => !hiddenIssues.has(index) && !resolvedViewerRows.has(index))
        .map(({ finding }) => markerIndexOf(finding))
        .filter((value): value is number => value != null),
    [viewerFindings, hiddenIssues, resolvedViewerRows],
  )
  /** NC probe runs (CUT_DEPTH_NC rows) that are checked on (their eye is on, not resolved). */
  const visibleRuns = useMemo(
    () =>
      viewerFindings
        .map((finding, index) => ({ finding, index }))
        .filter(
          ({ finding, index }) =>
            isNcRun(finding) && !hiddenIssues.has(index) && !resolvedViewerRows.has(index),
        )
        .map(({ finding }) => finding.params?.index)
        .filter((value): value is number => typeof value === 'number'),
    [viewerFindings, hiddenIssues, resolvedViewerRows],
  )
  /** The NC probe run to glow while its CUT_DEPTH_NC row is hovered. */
  const highlightRun = useMemo(() => {
    if (hoverIssueIndex == null) return null
    const finding = viewerFindings[hoverIssueIndex]
    if (!finding || !isNcRun(finding)) return null
    const index = finding.params?.index
    return typeof index === 'number' ? index : null
  }, [viewerFindings, hoverIssueIndex])
  /** Warning line to glow while its bevel row is hovered (the finding's own index). */
  const highlightWarning = useMemo(() => {
    if (hoverIssueIndex == null) return null
    const finding = viewerFindings[hoverIssueIndex]
    if (finding?.code !== 'BEVEL_OUT_OF_RANGE') return null
    const index = finding.params?.index
    return typeof index === 'number' ? index : null
  }, [viewerFindings, hoverIssueIndex])
  /** Warning-line indices (bevel findings) hidden by their row's eye. */
  const hiddenOutOfRange = useMemo(
    () =>
      new Set(
        viewerFindings
          .map((finding, index) => ({ finding, index }))
          .filter(
            ({ finding, index }) =>
              finding.code === 'BEVEL_OUT_OF_RANGE' && hiddenIssues.has(index),
          )
          .map(({ finding }) => finding.params?.index)
          .filter((value): value is number => typeof value === 'number'),
      ),
    [viewerFindings, hiddenIssues],
  )
  const toggleIssue = useCallback((index: number) => {
    setHiddenIssues((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])
  const toggleAllIssues = useCallback(() => {
    setHiddenIssues((prev) =>
      prev.size === 0
        ? new Set(
            viewerFindings
              .map((finding, index) => ({ finding, index }))
              .filter(({ finding }) => isVisualisable(finding))
              .map(({ index }) => index),
          )
        : // Show all; rows a recheck has cleared stay hidden independently.
          new Set<number>(),
    )
  }, [viewerFindings])
  /**
   * Cut markers of the viewed part — the manufactured view draws the guilty cuts. Cut-reach
   * failures come first, then the bevel-change lines, so a finding's `params.index` (assigned in
   * the same order in `allFindings`) picks the right marker.
   *
   * Fixed findings keep their marker at the end of the list. The eye stays off (their issue is
   * resolved), but hovering the row can still highlight it, so the operator sees what Undo restores.
   * `resolvedIndexByKey` maps each fixed row's op key to that kept marker.
   */
  const viewerMarkers = useMemo<{
    failures: CutMarker[] | null
    resolvedIndexByKey: Map<string, number>
  }>(() => {
    const resolvedIndexByKey = new Map<string, number>()
    const none = { failures: null, resolvedIndexByKey }
    if (!viewing) return none
    // Markers follow the same current-NC check results as the findings.
    const rechecked = ncRecheck.get(viewing.mark)
    const reach = rechecked?.reach ?? reachChecks.get(viewing.mark) ?? []
    const bevel = rechecked?.bevel ?? bevelChanges.get(viewing.mark) ?? []
    const unclosed = rechecked?.unclosed ?? unclosedCuts.get(viewing.mark) ?? []
    const rootFillet = rechecked?.rootFillet ?? rootFilletChecks.get(viewing.mark) ?? []
    // A channel's NC `v` line is drawn on the web's outer (`h`) plane after a `web·tan(bevel)` shift;
    // findings built from the raw v contour need the same shift or the marker floats off the line.
    const family = viewingProfileCode ? profileFamily(viewingProfileCode) : null
    const section = viewingNcSection ?? (Array.isArray(stock?.points) ? stock.points : null)
    const channelProjection =
      family === 'channel' && viewingNcFrame && section && viewingNcGeom
        ? {
            web: faceThickness(viewingNcFrame, section, 'h'),
            mid: ncAlongMid(viewingNcGeom),
          }
        : null
    const markers: CutMarker[] = [...reach]
    const pushBevel = (issue: BevelChangeIssue): void => {
      // A changing bevel is an NC-specific error: it only reads on the manufactured model, so the
      // viewer draws it there alone (see `CutMarker.ncOnly`).
      let from = issue.from
      let to = issue.to
      let lines = issue.lines
      const contour =
        channelProjection && issue.face === 'v'
          ? viewingNcGeom?.contours[issue.contourIndex]
          : undefined
      if (channelProjection && contour) {
        const shift = channelVToHShift(contour, channelProjection.web, channelProjection.mid)
        const moved = (index: number, point: [number, number]): [number, number] => [
          point[0] + (shift[index] ?? 0),
          point[1],
        ]
        from = moved(issue.vertices[0] ?? 0, issue.from)
        to = moved(issue.vertices[issue.vertices.length - 1] ?? 0, issue.to)
        if (lines?.length === 1 && lines[0]) {
          lines = [lines[0].map((point, k) => moved(issue.vertices[k] ?? 0, point))]
        }
      }
      markers.push({ face: issue.face, from, to, lines, ncOnly: true })
    }
    const pushIssue = (issue: CutMarker): void => {
      markers.push({
        face: issue.face,
        from: issue.from,
        to: issue.to,
        lines: issue.lines,
      })
    }
    for (const issue of bevel) pushBevel(issue)
    for (const issue of unclosed) pushIssue(issue)
    for (const issue of rootFillet) pushIssue(issue)
    // Keep a marker for each fixed finding, after the active ones so their indices do not shift.
    // The geometry comes from the original check on the bundled NC (the fix no longer reports it).
    for (const record of resolvedFixes.get(viewing.mark) ?? []) {
      const key = findingOpKey(record)
      if (!key) continue
      if (record.code === 'CUT_BEVEL_CHANGE') {
        const issue = (bevelChanges.get(viewing.mark) ?? []).find(
          (candidate) => `bevel:${candidate.contourIndex}:${candidate.vertices.join(',')}` === key,
        )
        if (!issue) continue
        pushBevel(issue)
      } else if (record.code === 'CUT_UNCLOSED' || record.code === 'CUT_CUTOUT') {
        const issue = (unclosedCuts.get(viewing.mark) ?? []).find(
          (candidate) =>
            candidate.removal &&
            `cut:${candidate.contourIndex}:${candidate.removal.join(',')}` === key,
        )
        if (!issue) continue
        pushIssue(issue)
      } else if (record.code === 'CUT_ROOT_FILLET') {
        const issue = (rootFilletChecks.get(viewing.mark) ?? []).find(
          (candidate) => `fillet:${candidate.contourIndex}:${candidate.vertices.join(',')}` === key,
        )
        if (!issue) continue
        pushIssue(issue)
      } else {
        continue
      }
      resolvedIndexByKey.set(key, markers.length - 1)
    }
    return { failures: markers.length > 0 ? markers : null, resolvedIndexByKey }
  }, [
    viewing,
    ncRecheck,
    reachChecks,
    bevelChanges,
    unclosedCuts,
    rootFilletChecks,
    resolvedFixes,
    viewingNcFrame,
    viewingNcSection,
    viewingNcGeom,
    viewingProfileCode,
    stock,
  ])

  /** The live marker index of a finding; a fixed row uses the marker kept for its own op key. */
  const viewerMarkerIndexFor = useCallback(
    (finding: Finding): number | null => {
      if (finding.params?.resolved === 1) {
        const key = findingOpKey(finding)
        return key ? (viewerMarkers.resolvedIndexByKey.get(key) ?? null) : null
      }
      return markerIndexOf(finding)
    },
    [viewerMarkers],
  )
  /** Sub-cut index to glow in the 3D while its issue row is hovered (only cut checks map to one). */
  const highlightSpan = useMemo(() => {
    if (hoverIssueIndex == null) return null
    const finding = viewerFindings[hoverIssueIndex]
    return finding ? viewerMarkerIndexFor(finding) : null
  }, [viewerFindings, hoverIssueIndex, viewerMarkerIndexFor])
  /**
   * Row click: pan/zoom onto the issue. It never hides a visible marker — if the marker is
   * currently hidden it is turned back on first. A fixed row stays visually off (visibility is
   * disabled; hover still highlights it), but the kept marker is framed so Undo has a target.
   */
  const activateIssue = useCallback(
    (index: number) => {
      const finding = viewerFindings[index]
      // Only findings with a 3D marker are interactive; the rest have no eye.
      if (!finding || !isVisualisable(finding)) return
      if (!resolvedViewerRows.has(index) && hiddenIssues.has(index)) toggleIssue(index)
      if (findingLocationOf(finding) == null) return
      const markerIndex = viewerMarkerIndexFor(finding)
      focusFinding(
        markerIndex != null && finding.params?.resolved === 1
          ? { ...finding, params: { ...finding.params, index: markerIndex } }
          : finding,
      )
    },
    [
      viewerFindings,
      hiddenIssues,
      toggleIssue,
      focusFinding,
      resolvedViewerRows,
      viewerMarkerIndexFor,
    ],
  )

  // Collapsible sections — long jobs push the tables far down, so profiles
  // and parts collapse like an accordion.
  const [profilesOpen, setProfilesOpen] = useState(true)
  const [partsOpen, setPartsOpen] = useState(true)
  /** Index into `profileGroups` of the profile whose cut-settings dialog is open. */
  const [settingsProfileIndex, setSettingsProfileIndex] = useState<number | null>(null)
  const [purchaseOpen, setPurchaseOpen] = useState(false)
  const [sectionLookupOpen, setSectionLookupOpen] = useState(false)
  const settingsGroup =
    settingsProfileIndex === null ? null : (profileGroups[settingsProfileIndex] ?? null)
  /** Previous/next profile while the dialog is open (arrow keys or the header buttons). */
  const navigateProfile = useCallback(
    (delta: -1 | 1) => {
      setSettingsProfileIndex((current) => {
        if (current === null) return current
        const next = current + delta
        return next < 0 || next >= profileGroups.length ? current : next
      })
    },
    [profileGroups.length],
  )

  // Parts table sorting — defaults to worst-problem-first so triage is quick.
  const [sort, setSort] = useState<{ key: PartSortKey; dir: 1 | -1 }>({ key: 'severity', dir: 1 })
  const toggleSort = useCallback((key: PartSortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  }, [])
  /** Free-text filter on the part mark, so a long job can be narrowed to the piece at hand. */
  const [markQuery, setMarkQuery] = useState('')
  /** Assembly chosen in the parts table; null shows every assembly and the job totals. */
  const [assemblyFilter, setAssemblyFilter] = useState<string | null>(null)
  /** Fixability pill: auto-fixable, needs a human, or off (null shows both). */
  const [fixFilter, setFixFilter] = useState<FixTier | null>(null)
  const sortedParts = useMemo(
    () =>
      result
        ? sortParts(result.parts, sort.key, sort.dir, {
            findings: activeFindings,
            materials: drawingMaterials,
            modelChecks,
            weldingMarks: new Set(weldEtchings.keys()),
            mass: pieceMass,
          })
        : [],
    [result, sort, activeFindings, drawingMaterials, modelChecks, weldEtchings, pieceMass],
  )
  /** Each part's section label, so a profile is searchable even when it came from the STEP. */
  const sectionLabels = useMemo(
    () => new Map((result?.parts ?? []).map((part) => [part.mark, sectionLabel(part)])),
    [result, sectionLabel],
  )
  /** Everything the parts search can match: mark, profile/grade, findings and weld etchings. */
  const partFilterContext = useMemo<PartFilterContext>(
    () => ({
      findings: activeFindings,
      materials: drawingMaterials,
      modelChecks,
      weldingMarks: new Set(weldEtchings.keys()),
      sectionLabels,
      findingText,
      weldingText: (mark) => {
        const etchings = weldEtchings.get(mark)
        return etchings ? weldEtchingsTitle(t, etchings) : ''
      },
    }),
    [activeFindings, drawingMaterials, modelChecks, weldEtchings, sectionLabels, findingText, t],
  )
  /** Distinct assemblies in the job, for the filter and the assembly column. */
  const assemblyOptions = useMemo(() => {
    const names = new Set<string>()
    for (const part of sortedParts) {
      for (const usage of part.assemblies ?? []) names.add(usage.assembly)
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }, [sortedParts])
  /** The sorted parts narrowed by the tokenised search (status words + free text). */
  const searchedParts = useMemo(
    () => filterParts(sortedParts, markQuery, partFilterContext),
    [sortedParts, markQuery, partFilterContext],
  )

  /**
   * Whether one finding can be handled by the batch "Auto fix" on this part. Only codes with a
   * well-defined default are eligible (see `lib/audit/fixTier.ts`); a resolved finding, or one a
   * STEP override already cleared, drops out.
   */
  const isAutoFixable = useCallback(
    (part: PartRecord, finding: Finding): boolean => {
      if (!AUTO_FIX_CODES.has(finding.code)) return false
      if (finding.params?.resolved === 1) return false
      const stepKind = stepOverrides.get(part.mark)?.kind
      if (stepKind && resolvedFindings(stepKind).includes(finding.code)) return false
      // CUT_END_PIECE rebuilds the STEP (simplified); every other auto fix edits the NC.
      if (finding.code === 'CUT_END_PIECE') return Boolean(part.nc)
      return Boolean(part.nc) && ncOpForFinding(finding) != null
    },
    [stepOverrides],
  )

  /**
   * Whether a fix exists for this finding but needs the operator to choose, so it is only ever
   * applied one at a time from the finding's own fix menu.
   */
  const isManuallyFixable = useCallback(
    (part: PartRecord, finding: Finding): boolean => {
      if (fixTierForCode(finding.code) !== 'manual') return false
      if (finding.params?.resolved === 1) return false
      const stepKind = stepOverrides.get(part.mark)?.kind
      if (stepKind && resolvedFindings(stepKind).includes(finding.code)) return false
      const kind = fixForFinding(finding)
      if (kind === 'clean') return Boolean(part.step)
      if (kind === 'regenerate') return Boolean(part.nc)
      if (!kind) return false
      return Boolean(part.nc) && ncOpForFinding(finding) != null
    },
    [stepOverrides],
  )

  /** How a finding's fix can be applied: by the batch, one at a time, or not at all. */
  const fixTier = useCallback(
    (part: PartRecord, finding: Finding): FixTier | null => {
      if (isAutoFixable(part, finding)) return 'auto'
      if (isManuallyFixable(part, finding)) return 'manual'
      return null
    },
    [isAutoFixable, isManuallyFixable],
  )

  /**
   * Which fix tiers each part carries, in one pass over the findings. A part can carry both: the
   * batch clears its auto findings, and its manual ones still need a human — the same split the
   * "Auto fix" button counts, so the pills and the button never disagree.
   */
  const fixTiersByMark = useMemo(() => {
    const parts = new Map((result?.parts ?? []).map((part) => [part.mark, part]))
    const tiers = new Map<string, Set<FixTier>>()
    for (const finding of activeFindings) {
      if (!finding.mark) continue
      const part = parts.get(finding.mark)
      if (!part) continue
      const tier = fixTier(part, finding)
      if (!tier) continue
      const set = tiers.get(finding.mark) ?? new Set<FixTier>()
      set.add(tier)
      tiers.set(finding.mark, set)
    }
    return tiers
  }, [result, activeFindings, fixTier])

  const fixCounts = useMemo(() => {
    const counts: Record<FixTier, number> = { auto: 0, manual: 0 }
    for (const part of sortedParts) {
      const tiers = fixTiersByMark.get(part.mark)
      if (tiers?.has('auto')) counts.auto++
      if (tiers?.has('manual')) counts.manual++
    }
    return counts
  }, [sortedParts, fixTiersByMark])

  const visibleParts = useMemo(() => {
    let parts = searchedParts
    if (assemblyFilter) {
      parts = parts.filter((part) =>
        part.assemblies?.some((usage) => usage.assembly === assemblyFilter),
      )
    }
    if (fixFilter) parts = parts.filter((part) => fixTiersByMark.get(part.mark)?.has(fixFilter))
    return parts
  }, [searchedParts, assemblyFilter, fixFilter, fixTiersByMark])
  const parsedPartQuery = useMemo(() => parsePartQuery(markQuery), [markQuery])
  /** Status chips are single-select; "all" is the absence of a status word. */
  const activeStatus = parsedPartQuery.statuses.length === 1 ? parsedPartQuery.statuses[0] : null
  const statusCounts = useMemo(() => {
    const counts: Record<PartStatus, number> = { error: 0, warning: 0, info: 0, ok: 0 }
    for (const part of sortedParts) counts[statusForPart(part, partFilterContext)]++
    return counts
  }, [sortedParts, partFilterContext])
  const setStatusFilter = useCallback((status: PartStatus | 'all') => {
    setMarkQuery((query) => withStatusFilter(query, status))
  }, [])
  /** True when a pill's token is already narrowing the table, so it can be clicked off. */
  const isFilterTokenActive = useCallback(
    (token: string) => {
      const needle = token.toLowerCase() as PartStatus
      if (needle === 'ok' || needle === 'error' || needle === 'warning' || needle === 'info') {
        return parsedPartQuery.statuses.includes(needle)
      }
      return parsedPartQuery.terms.includes(needle)
    },
    [parsedPartQuery],
  )
  const toggleFilterToken = useCallback((token: string) => {
    setMarkQuery((query) => toggleQueryToken(query, token))
  }, [])

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
    let cancelled = false
    // Settle first: rapid next/prev should not queue prefetches for marks the user skips over.
    const timer = setTimeout(() => {
      if (cancelled) return
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
          // Do not add a separate sabre rebuild here: it doubles the neighbour's worker work and
          // makes rapid next/prev navigation wait. STEP neighbours get it from `fastTrackPart`;
          // no-STEP neighbours are filled by the sequential background pass.
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
    }, 700)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [viewing, viewingIndex, viewableParts, bytesByPath, fastTrackPart])

  // Background CUT_DEPTH pass: parts with no STEP are skipped by the analysis rebuild, so probe
  // their NC cut lines here too. The combined viewer+sabre build also primes the viewer cache, so
  // opening the part later does not rebuild it. Run a few at a time across the multi-core pool;
  // the viewed part and its neighbours still jump ahead on priority.
  const sabreQueued = useRef(new Set<string>())
  const sabreChecksRef = useRef(sabreChecks)
  sabreChecksRef.current = sabreChecks
  useEffect(() => {
    if (!result) return
    let cancelled = false
    const pending = result.parts.filter(
      (part) => part.nc?.path && !part.step && !sabreChecksRef.current.has(part.mark),
    )
    let next = 0
    // Fill the worker pool: each task does its OCC work off the main thread, and foreground
    // viewer/neighbour tasks still jump the queue by priority.
    const CONCURRENCY = STEP_WORKER_COUNT
    const work = async () => {
      while (!cancelled) {
        const part = pending[next++]
        if (!part) return
        if (sabreChecksRef.current.has(part.mark) || sabreQueued.current.has(part.mark)) continue
        const ncPath = part.nc?.path
        const bytes = ncPath ? bytesByPath.get(ncPath) : undefined
        if (!bytes) continue
        sabreQueued.current.add(part.mark)
        try {
          const { sabre } = await reconstructViewerWithSabre(new TextDecoder().decode(bytes), {
            priority: PRIORITY_BACKGROUND,
          })
          if (cancelled) return
          setSabreChecks((prev) => new Map(prev).set(part.mark, sabre))
        } catch {
          // best-effort
        } finally {
          sabreQueued.current.delete(part.mark)
        }
      }
    }
    void Promise.all(Array.from({ length: CONCURRENCY }, work))
    return () => {
      cancelled = true
    }
  }, [result, bytesByPath])

  // Re-run the CUT_DEPTH probe on every edited NC after a fix. The **new manufactured model**
  // decides it: if the edit actually removed the over-cut, the issue clears; otherwise it stays.
  // This is independent of the viewed part, so the parts table updates too.
  //
  // Keyed on the override object: an auto-fix over many marks commits one part per update, and
  // re-probing every already-edited part on each commit queued O(n²) multi-second OCC rebuilds
  // (and thrashed the 32-entry rebuild cache). A result is applied only while it is still that
  // part's current override, so no part is validated against an NC that has since been edited.
  const ncOverridesRef = useRef(ncOverrides)
  ncOverridesRef.current = ncOverrides
  const sabreProbedOverride = useRef(new Map<string, NcOverride>())
  useEffect(() => {
    if (!result) return
    const probed = sabreProbedOverride.current
    for (const part of result.parts) {
      const override = ncOverrides.get(part.mark)
      if (!override) {
        probed.delete(part.mark)
        continue
      }
      if (probed.get(part.mark) === override) continue
      probed.set(part.mark, override)
      // The viewed part's recheck must jump the queue: background work is held while a part is
      // open, which otherwise leaves its CUT_DEPTH untested until the viewer closes.
      const priority = part.mark === viewing?.mark ? PRIORITY_FOREGROUND : PRIORITY_BACKGROUND
      void reconstructViewerWithSabre(new TextDecoder().decode(override.bytes), {
        priority,
      })
        .then(({ sabre }) => {
          if (ncOverridesRef.current.get(part.mark) !== override) return
          if (import.meta.env.DEV) {
            console.info('[cut-depth recheck]', part.mark, 'sabre samples', sabre.length)
          }
          setSabreRecheck((prev) => new Map(prev).set(part.mark, sabre))
        })
        .catch(() => {
          // best-effort; clear the mark so a later render can retry it
          if (probed.get(part.mark) === override) probed.delete(part.mark)
        })
    }
  }, [result, ncOverrides, viewing?.mark])

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

  /**
   * A part can be tabbed when its STEP carries separate nested bodies (the clean fix would throw
   * the other pieces away). Tabs keep every piece and join them into one connected solid.
   */
  const isTabbable = useCallback(
    (part: PartRecord | undefined) =>
      Boolean(
        part?.step &&
          modelChecks.get(part.mark)?.stray &&
          stepOverrides.get(part.mark)?.kind !== 'tabbed',
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

  const setOverride = useCallback(
    (mark: string, bytes: Uint8Array, kind: StepFixKind, seated = false) => {
      setStepOverrides((prev) => {
        const next = new Map(prev)
        next.set(mark, { bytes, kind, seated })
        return next
      })
    },
    [],
  )

  const undoOverride = useCallback((mark: string) => {
    setStepOverrides((prev) => {
      if (!prev.has(mark)) return prev
      const next = new Map(prev)
      next.delete(mark)
      return next
    })
  }, [])

  /**
   * Keep the fixed finding as a resolved record so the existing row (with Undo) survives while the
   * active rows come from the re-run check. Records stack by op key; a repeated fix of the same
   * issue replaces its record rather than adding another.
   */
  const rememberResolvedFix = useCallback((part: PartRecord, finding: Finding) => {
    const key = findingOpKey(finding)
    if (!key) return
    setResolvedFixes((prev) => {
      const list = prev.get(part.mark) ?? []
      const next = list.filter((item) => findingOpKey(item) !== key)
      next.push({
        ...finding,
        params: { ...finding.params, resolved: 1 },
      })
      return new Map(prev).set(part.mark, next)
    })
  }, [])

  /** Drops a part's NC edit, so it reverts to the bundled `.nc1`, and re-runs the NC checks. */
  const undoNcFinding = useCallback(
    (part: PartRecord, finding: Finding) => {
      const key = findingOpKey(finding)
      const original = part.nc ? bytesByPath.get(part.nc.path) : undefined
      if (!key || !original) return
      setNcOverrides((prev) => {
        const ops = (prev.get(part.mark)?.ops ?? []).filter((op) => op.key !== key)
        return withNcOps(prev, part.mark, ops, original)
      })
      setSabreRecheck((prev) => {
        if (!prev.has(part.mark)) return prev
        const next = new Map(prev)
        next.delete(part.mark)
        return next
      })
      setResolvedFixes((prev) => {
        const current = prev.get(part.mark) ?? []
        const next = current.filter((item) => findingOpKey(item) !== key)
        if (next.length === current.length) return prev
        const map = new Map(prev)
        if (next.length === 0) map.delete(part.mark)
        else map.set(part.mark, next)
        return map
      })
    },
    [bytesByPath],
  )

  /** Cleans one part's stray STEP bodies, keeping the real geometry untouched (in the OCC worker). */
  const cleanPart = useCallback(
    async (part: PartRecord) => {
      const path = part.step?.path
      const bytes = path ? bytesByPath.get(path) : undefined
      if (!path || !bytes) return
      setFixingMark(part.mark)
      try {
        const cleaned = await getStepWorkerPool().clean(bytes, { priority: PRIORITY_FOREGROUND })
        if (cleaned && cleaned.removed > 0) setOverride(part.mark, cleaned.bytes, 'cleaned')
      } catch {
        // leave the original in place if cleaning fails
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, setOverride],
  )

  /**
   * Joins one part's separate nested bodies with tabs instead of deleting all but the largest.
   * The density is tabs per metre; the whole fix runs in the STEP worker so the viewer stays live.
   */
  const tabPart = useCallback(
    async (
      part: PartRecord,
      settings: {
        density: number
        tabLength: number
        tabWidth: number
        engagement: number
      },
    ) => {
      const path = part.step?.path
      const bytes = path ? bytesByPath.get(path) : undefined
      if (!path || !bytes) return
      setFixingMark(part.mark)
      setError(null)
      try {
        const result = await getStepWorkerPool().tab(bytes, {
          ...settings,
          priority: PRIORITY_FOREGROUND,
        })
        if (result) setOverride(part.mark, result.bytes, 'tabbed')
        else setError(t('preflight.tabs.failed'))
      } catch {
        setError(t('preflight.tabs.failed'))
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, setOverride, t],
  )

  /**
   * Opens the tab dialog and asks the worker for the detected defaults from this STEP (local
   * web/wall width, standard length and engagement) so the fields start from real geometry.
   */
  const openTabEdit = useCallback(
    async (part: PartRecord) => {
      setTabEdit(part)
      setTabDetected(null)
      setTabDetecting(false)
      const path = part.step?.path
      const bytes = path ? bytesByPath.get(path) : undefined
      if (!bytes) return
      setTabDetecting(true)
      try {
        const detected = await getStepWorkerPool().tabDefaults(bytes, {
          priority: PRIORITY_FOREGROUND,
        })
        setTabDetected(detected)
        setTabLength(String(+detected.tabLength.toFixed(2)))
        setTabWidth(String(+detected.tabWidth.toFixed(2)))
        setTabEngagement(String(+detected.engagement.toFixed(2)))
      } catch {
        // keep the persisted values when detection fails
      } finally {
        setTabDetecting(false)
      }
    },
    [bytesByPath],
  )
  const closeTabEdit = useCallback(() => setTabEdit(null), [])
  const useDetectedTabDefaults = useCallback(() => {
    if (!tabDetected) return
    setTabDensity(String(+tabDetected.density.toFixed(2)))
    setTabLength(String(+tabDetected.tabLength.toFixed(2)))
    setTabWidth(String(+tabDetected.tabWidth.toFixed(2)))
    setTabEngagement(String(+tabDetected.engagement.toFixed(2)))
  }, [tabDetected])
  const applyTabEdit = useCallback(
    (settings: { density: number; tabLength: number; tabWidth: number; engagement: number }) => {
      const part = tabEdit
      setTabEdit(null)
      if (part) void tabPart(part, settings)
    },
    [tabEdit, tabPart],
  )

  /**
   * The clean base bundled with the job, if any: a second STEP whose name matches the part mark
   * (e.g. `GB8(3).stp`, `corrected/GB8.stp`, `GB8.fixed.stp`). Non-technical users just drop the
   * corrected export into the job; the button finds it automatically — no picker, no script.
   */
  const jobBaseFor = useCallback(
    (part: PartRecord): Uint8Array | undefined => {
      const own = part.step?.path
      const mark = part.mark.toLowerCase().replace(/[^a-z0-9]/g, '')
      let best: { score: number; bytes: Uint8Array } | null = null
      for (const entry of bundle?.entries ?? []) {
        if (!/\.(stp|step)$/i.test(entry.path)) continue
        if (entry.path === own) continue
        const stem =
          entry.path
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.[^.]+$/, '') ?? ''
        const norm = stem.toLowerCase().replace(/[^a-z0-9]/g, '')
        if (!mark || !norm.startsWith(mark)) continue
        let score = 0
        if (/correct|fix|clean|repair/i.test(entry.path)) score += 10
        if (norm !== mark) score += 1
        if (!best || score > best.score) best = { score, bytes: entry.bytes }
      }
      return best?.bytes
    },
    [bundle],
  )

  /**
   * Tekla repair preview: use a clean base bundled with the job (corrected STEP) or rebuilt from
   * the NC, then re-drill the part's real STEP holes into it. The result becomes the viewer/export
   * override — no save dialog, no script.
   */
  const cleanTeklaPart = useCallback(
    async (part: PartRecord) => {
      const path = part.step?.path
      const featureBytes = path ? bytesByPath.get(path) : undefined
      if (!featureBytes) return
      const ncPath = part.nc?.path
      const ncBytes =
        ncOverrides.get(part.mark)?.bytes ?? (ncPath ? bytesByPath.get(ncPath) : undefined)
      const jobBase = ncBytes ? undefined : jobBaseFor(part)
      setFixingMark(part.mark)
      try {
        if (ncBytes) {
          // NC rebuild is canonical; seat the raw STEP features into that frame first.
          let features = featureBytes
          const code =
            part.nc?.profile ?? listedProfile(part) ?? sectionGuesses.get(part.mark)?.code
          const dims = part.nc?.dimensions ?? sectionGuesses.get(part.mark)?.dims ?? []
          const profile = code ? (partSectionForCode(code, dims)?.points ?? null) : null
          if (profile) {
            try {
              const seated = await getStepWorkerPool().seat(featureBytes, profile, {
                priority: PRIORITY_FOREGROUND,
              })
              features = new TextEncoder().encode(seated.step)
            } catch {
              // use the raw STEP if seating fails
            }
          }
          let base: Uint8Array | null = null
          try {
            base = await reconstructForViewer(new TextDecoder().decode(ncBytes))
          } catch {
            base = null
          }
          const result = await getStepWorkerPool().repair(base, features, {
            priority: PRIORITY_FOREGROUND,
          })
          if (result.valid) {
            setOverride(
              part.mark,
              result.bytes,
              result.cleaned ? 'cleaned' : 'repaired',
              !result.cleaned,
            )
          }
        } else {
          // A corrected base in the job wins; otherwise the worker rebuilds the stock base
          // from the part's own faces before re-drilling (auto repair, no external file).
          const result = await getStepWorkerPool().repair(jobBase ?? null, featureBytes, {
            priority: PRIORITY_FOREGROUND,
          })
          if (result.valid) {
            setOverride(part.mark, result.bytes, result.cleaned ? 'cleaned' : 'repaired')
          }
        }
      } catch {
        try {
          const cleaned = await getStepWorkerPool().clean(featureBytes, {
            priority: PRIORITY_FOREGROUND,
          })
          if (cleaned) setOverride(part.mark, cleaned.bytes, 'cleaned')
        } catch {
          // leave the original in place
        }
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, jobBaseFor, ncOverrides, sectionGuesses, setOverride],
  )

  /** Rebuilds a part's STEP from its NC, so the viewer + export match what will be manufactured. */
  const regeneratePart = useCallback(
    async (part: PartRecord) => {
      const ncPath = part.nc?.path
      const ncBytes =
        ncOverrides.get(part.mark)?.bytes ?? (ncPath ? bytesByPath.get(ncPath) : undefined)
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
    [bytesByPath, ncOverrides, setOverride],
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
      const contourIndex = finding.params?.contourIndex
      const removalText = finding.params?.removal
      if (typeof contourIndex !== 'number' || typeof removalText !== 'string' || !removalText) {
        return
      }
      const removal = removalText.split(',').map(Number)
      if (removal.length < 2) return
      setFixingMark(part.mark)
      try {
        const current = ncOverrides.get(part.mark)?.ops ?? []
        const key = `cut:${contourIndex}:${removalText}`
        const ops = upsertOp(current, {
          key,
          kind: 'removeCut',
          contourIndex,
          removeVertices: [removal[0] as number, removal[1] as number],
        })
        setNcOverrides((prev) => withNcOps(prev, part.mark, ops, original))
        rememberResolvedFix(part, finding)
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, ncOverrides, rememberResolvedFix],
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
      // Use the finding's own contour/vertices, so stacked fixes stay aligned with the current NC.
      const contourIndex = finding.params?.contourIndex
      const verticesText = finding.params?.vertices
      if (typeof contourIndex !== 'number' || typeof verticesText !== 'string') return
      const vertices = verticesText
        .split(',')
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= 0)
      if (vertices.length === 0) return
      setFixingMark(part.mark)
      try {
        const current = ncOverrides.get(part.mark)?.ops ?? []
        const key = `bevel:${contourIndex}:${verticesText}`
        const ops = upsertOp(current, {
          key,
          kind: 'unifyBevel',
          contourIndex,
          vertices,
          angle,
        })
        setNcOverrides((prev) => withNcOps(prev, part.mark, ops, original))
        rememberResolvedFix(part, finding)
      } catch {
        // leave the NC as it is if the edit fails
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, ncOverrides, rememberResolvedFix],
  )

  /**
   * Changes one out-of-range welding prep on the part's NC: set it to an in-range angle, or delete it
   * (`0`). Only that couple changes, so in-range preps on the same vertex are kept.
   */
  const changeOutOfRangeBevel = useCallback(
    async (part: PartRecord, finding: Finding, angle: number) => {
      const ncPath = part.nc?.path
      const original = ncPath ? bytesByPath.get(ncPath) : undefined
      if (!original) return
      const contourIndex = finding.params?.contourIndex
      const vertex = finding.params?.vertex
      if (typeof contourIndex !== 'number' || typeof vertex !== 'number') return
      setFixingMark(part.mark)
      try {
        const current = ncOverrides.get(part.mark)?.ops ?? []
        const key = `oor:${contourIndex}:${vertex}`
        const ops = upsertOp(current, { key, kind: 'outOfRangeBevel', contourIndex, vertex, angle })
        setNcOverrides((prev) => withNcOps(prev, part.mark, ops, original))
        rememberResolvedFix(part, finding)
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, ncOverrides, rememberResolvedFix],
  )

  /**
   * Moves a longitudinal cut off a rolled root fillet by editing the part's NC: every vertex on the
   * flagged run shifts across the face by `offset` (default: the issue's suggested delta), so the
   * line lands on the flat plate. The manufactured model rebuilds from the edited NC and the export
   * ships it; the row's Undo drops the op and restores the original line.
   */
  const moveRootFilletCut = useCallback(
    async (part: PartRecord, finding: Finding, offset?: number) => {
      const ncPath = part.nc?.path
      const original = ncPath ? bytesByPath.get(ncPath) : undefined
      if (!original) return
      // Use the finding's own run, not an index into the original list: after the first fix the
      // active list shrinks, and an index lookup would stack the second fix onto the wrong edge.
      const contourIndex = finding.params?.contourIndex
      const verticesText = finding.params?.vertices
      const suggested = finding.params?.delta
      const deltaY = offset ?? (typeof suggested === 'number' ? suggested : 0)
      if (typeof contourIndex !== 'number' || typeof verticesText !== 'string') return
      const vertices = verticesText
        .split(',')
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= 0)
      if (!Number.isFinite(deltaY) || deltaY === 0 || vertices.length === 0) return
      setFixingMark(part.mark)
      try {
        const current = ncOverrides.get(part.mark)?.ops ?? []
        const key = `fillet:${contourIndex}:${verticesText}`
        const ops = upsertOp(current, {
          key,
          kind: 'moveCut',
          contourIndex,
          vertices,
          deltaY,
        })
        // The override effect re-probes this edited NC's manufactured model; clear the old
        // CUT_DEPTH rows in the meantime so they reflect the new build, not the old one.
        setNcOverrides((prev) => withNcOps(prev, part.mark, ops, original))
        setSabreRecheck((prev) => new Map(prev).set(part.mark, []))
        rememberResolvedFix(part, finding)
      } finally {
        setFixingMark(null)
      }
    },
    [bytesByPath, ncOverrides, rememberResolvedFix],
  )

  /** Opens the "move cut" mini menu, prefilling the suggested offset for the flagged line. */
  const openMoveEdit = useCallback((part: PartRecord, finding: Finding) => {
    const suggested = finding.params?.delta
    setMoveOffset(typeof suggested === 'number' ? String(suggested) : '')
    setMoveEdit({ part, finding })
  }, [])
  const closeMoveEdit = useCallback(() => setMoveEdit(null), [])
  /** Applies the chosen offset to the open finding's flagged cut line. */
  const applyMoveEdit = useCallback(
    (offset: number) => {
      const target = moveEdit
      setMoveEdit(null)
      if (!target) return
      void moveRootFilletCut(target.part, target.finding, offset)
    },
    [moveEdit, moveRootFilletCut],
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
      if (!target) return
      if (target.finding.code === 'BEVEL_OUT_OF_RANGE')
        void changeOutOfRangeBevel(target.part, target.finding, angle)
      else void changeBevel(target.part, target.finding, angle)
    },
    [bevelEdit, changeBevel, changeOutOfRangeBevel],
  )

  /** A part's still-active findings that the batch auto-fix can resolve, in listing order. */
  const autoFixableFindings = useCallback(
    (part: PartRecord): Finding[] =>
      allFindings.filter((finding) => finding.mark === part.mark && isAutoFixable(part, finding)),
    [allFindings, isAutoFixable],
  )

  /** Ticked marks that currently have at least one finding auto-fix can resolve. */
  const autoFixableMarks = useMemo(() => {
    const marks = new Set<string>()
    if (!result) return marks
    for (const part of result.parts) {
      if (!selectedMarks.has(part.mark)) continue
      if (autoFixableFindings(part).length > 0) marks.add(part.mark)
    }
    return marks
  }, [result, selectedMarks, autoFixableFindings])

  /**
   * The NC edits auto-fix would make to one part, applied to a running copy of its NC. Pure — the
   * caller commits the result — so a bulk fix can stack every part's edits into one update.
   */
  const planNcFixes = useCallback(
    (
      part: PartRecord,
      findings: Finding[],
      base: NcOverride | undefined,
    ): {
      original: Uint8Array
      ncText: string
      ops: NcOp[]
      newOps: NcOp[]
      applied: Finding[]
    } | null => {
      const ncPath = part.nc?.path
      const original = ncPath ? bytesByPath.get(ncPath) : undefined
      if (!original) return null
      let ncText = new TextDecoder().decode(base?.bytes ?? original)
      const newOps: NcOp[] = []
      const applied: Finding[] = []
      const candidates = findings
        .map((finding) => ({ finding, op: ncOpForFinding(finding) }))
        .filter((entry): entry is { finding: Finding; op: NcOp } => entry.op != null)
      // Line-preserving edits first, then removals in descending vertex order within a contour, so
      // a removal never shifts the indices of an edit still to come.
      const preserving = candidates.filter(({ op }) => op.kind !== 'removeCut')
      const removing = candidates
        .filter(({ op }) => op.kind === 'removeCut')
        .sort((a, b) => {
          if (a.op.kind !== 'removeCut' || b.op.kind !== 'removeCut') return 0
          return (
            b.op.contourIndex - a.op.contourIndex || b.op.removeVertices[0] - a.op.removeVertices[0]
          )
        })
      for (const { finding, op } of [...preserving, ...removing]) {
        try {
          const next = applyNcOp(ncText, op)
          // A no-op means the edit can't be made against this NC; leave the finding for a human.
          if (next === ncText) continue
          ncText = next
          newOps.push(op)
          applied.push(finding)
        } catch {
          // leave this finding alone
        }
      }
      return { original, ncText, ops: [...(base?.ops ?? []), ...newOps], newOps, applied }
    },
    [bytesByPath],
  )

  /**
   * The one STEP fix the batch applies: `CUT_END_PIECE` rebuilds the model simplified, so a
   * bevelled end stays attached instead of detaching. Stray-body cleaning and NC regeneration are
   * per-case judgement calls (see `lib/audit/fixTier.ts`) and never run here.
   */
  const fixStepForPart = useCallback(
    async (part: PartRecord, findings: Finding[], ncText: string | null) => {
      if (!ncText) return
      if (!findings.some((finding) => finding.code === 'CUT_END_PIECE')) return
      const step = await reconstructForViewer(ncText, {
        simplify: true,
        priority: PRIORITY_NEIGHBOR,
      })
      if (step) setOverride(part.mark, step, 'simplified')
    },
    [setOverride],
  )

  /**
   * Auto-fixes every ticked mark that has a fixable finding.
   *
   * Two phases, so nothing runs as one long main-thread task:
   *  1. **NC edits** are cheap text rewrites. They are planned one part at a time against the
   *     override map as it grows and committed in **one** update, so the NC checks re-run once for
   *     the whole batch instead of once per part — that per-part re-check over every already-edited
   *     part was the O(n²) freeze. A yield between parts keeps the page and progress label live.
   *  2. **STEP rebuilds** are seconds of OCC work each, so they go through the worker pool a few at
   *     a time (the same queue the background analysis uses) and report progress as each part
   *     lands. They sit below viewer priority, so opening a part still preempts this bulk work.
   */
  const autoFixSelected = useCallback(async () => {
    if (!result || autoFixing) return
    const parts = result.parts.filter((part) => autoFixableMarks.has(part.mark))
    if (parts.length === 0) return
    setAutoFixing({ done: 0, total: parts.length })
    try {
      // --- Phase 1: NC edits, planned against the map as it grows (never this render's snapshot).
      const commits: Array<{ mark: string; ops: NcOp[]; original: Uint8Array }> = []
      const resolved: Array<{ part: PartRecord; finding: Finding }> = []
      const moved = new Set<string>()
      const jobs: Array<{ part: PartRecord; findings: Finding[]; ncText: string | null }> = []
      let overrides = ncOverrides
      for (const part of parts) {
        const findings = autoFixableFindings(part)
        const plan = planNcFixes(part, findings, overrides.get(part.mark))
        if (plan && plan.newOps.length > 0) {
          commits.push({ mark: part.mark, ops: plan.ops, original: plan.original })
          for (const finding of plan.applied) resolved.push({ part, finding })
          if (plan.newOps.some((op) => op.kind === 'moveCut')) moved.add(part.mark)
          overrides = withNcOps(overrides, part.mark, plan.ops, plan.original)
        }
        jobs.push({ part, findings, ncText: plan?.ncText ?? null })
        // Hand the thread back: the edits above are synchronous, so without this a big batch
        // never lets the progress label paint or the page handle input.
        await yieldToMain()
      }
      if (commits.length > 0) {
        setNcOverrides((prev) => {
          let next = prev
          for (const commit of commits)
            next = withNcOps(next, commit.mark, commit.ops, commit.original)
          return next
        })
        for (const { part, finding } of resolved) rememberResolvedFix(part, finding)
        if (moved.size > 0) {
          // The override effect re-probes the edited NC; drop the old CUT_DEPTH rows meanwhile.
          setSabreRecheck((prev) => {
            const next = new Map(prev)
            for (const mark of moved) next.set(mark, [])
            return next
          })
        }
      }

      // --- Phase 2: STEP rebuilds, a pool-full at a time, progress per finished part.
      const viewingMark = viewing?.mark ?? null
      if (viewingMark && jobs.some(({ part }) => part.mark === viewingMark))
        setFixingMark(viewingMark)
      let done = 0
      let cursor = 0
      const work = async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor++]
          if (!job) return
          try {
            await fixStepForPart(job.part, job.findings, job.ncText)
          } catch {
            // one part's failure must not stop the rest
          }
          done += 1
          // Batched with the override the fix sets, so the table and the label move together.
          setAutoFixing({ done, total: parts.length })
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(STEP_WORKER_COUNT, jobs.length) }, () => work()),
      )
    } finally {
      setFixingMark(null)
      setAutoFixing(null)
    }
  }, [
    result,
    autoFixing,
    autoFixableMarks,
    autoFixableFindings,
    ncOverrides,
    planNcFixes,
    fixStepForPart,
    rememberResolvedFix,
    viewing?.mark,
  ])

  /** The canonical cross-section to seat / rewrite a part's export against, or null when unknown. */
  const exportProfile = useCallback(
    (part: PartRecord): [number, number][] | null => {
      const code = part.nc?.profile ?? listedProfile(part) ?? sectionGuesses.get(part.mark)?.code
      if (!code) return null
      const dims = part.nc?.dimensions ?? sectionGuesses.get(part.mark)?.dims ?? []
      return partSectionForCode(code, dims)?.points ?? null
    },
    [sectionGuesses],
  )

  /**
   * The STEP bytes to ship: the part's fix override (cleaned / regenerated / simplified) or its real
   * STEP, seated into the canonical manufacturing orientation. Regenerated / simplified overrides
   * already come out of the NC rebuild in that frame, so only raw / cleaned geometry is re-seated.
   */
  const exportStepBytes = useCallback(
    async (part: PartRecord): Promise<Uint8Array | undefined> => {
      const override = stepOverrides.get(part.mark)
      const path = part.step?.path
      const base = override?.bytes ?? (path ? bytesByPath.get(path) : undefined)
      if (!base) return undefined
      if (override?.kind === 'regenerated' || override?.kind === 'simplified' || override?.seated)
        return base
      const profile = exportProfile(part)
      if (!profile) return base
      try {
        const { step } = await getStepWorkerPool().seat(base, profile, {
          priority: PRIORITY_FOREGROUND,
        })
        return new TextEncoder().encode(step)
      } catch {
        return base
      }
    },
    [bytesByPath, stepOverrides, exportProfile],
  )

  /** The NC bytes to ship: the (edited) NC re-emitted by our own writer rather than copied raw. */
  const exportNcBytes = useCallback(
    (part: PartRecord): Uint8Array | undefined => {
      const override = ncOverrides.get(part.mark)
      const path = part.nc?.path
      const base = override?.bytes ?? (path ? bytesByPath.get(path) : undefined)
      if (!base) return undefined
      try {
        return new TextEncoder().encode(reemitPartNc(new TextDecoder().decode(base)))
      } catch {
        return base
      }
    },
    [bytesByPath, ncOverrides],
  )

  /**
   * The NCEP bytes to ship: develop the effective NC into WiseCAM's CAD-only `.ncep`
   * package. Unsupported families (T/angle/round) return undefined.
   */
  const exportNcepBytes = useCallback(
    (part: PartRecord): Uint8Array | undefined => {
      const override = ncOverrides.get(part.mark)
      const path = part.nc?.path
      const base = override?.bytes ?? (path ? bytesByPath.get(path) : undefined)
      if (!base) return undefined
      try {
        return buildNcepFromNc(new TextDecoder().decode(base), { mark: part.mark }) ?? undefined
      } catch {
        return undefined
      }
    },
    [bytesByPath, ncOverrides],
  )

  /** Direct download of the viewed part's generated NCEP (the importable CAD-only package). */
  const downloadViewingNcep = useCallback(() => {
    if (!viewing) return
    const bytes = viewingNcIr
      ? buildNcepFromIr(viewingNcIr, { mark: viewing.mark })
      : ncBytes
        ? buildNcepFromNc(new TextDecoder().decode(ncBytes), { mark: viewing.mark })
        : null
    if (!bytes) return
    downloadBlob(
      `${viewing.mark}.ncep`,
      new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
    )
  }, [viewing, ncBytes, viewingNcIr])

  /**
   * Rebuilds each ticked part's STEP from its NC (the manufactured part) and records it as the
   * part's override, so the next "Export selected" ships the NC-derived STEP.
   */
  const ncToStepSelected = useCallback(async () => {
    if (!result || selectedMarks.size === 0) return
    const selected = result.parts.filter((part) => selectedMarks.has(part.mark))
    if (!selected.some((part) => part.nc?.path || ncOverrides.has(part.mark))) {
      setError(t('preflight.findings.ncToStepNone'))
      return
    }
    setExporting(true)
    try {
      for (const part of selected) {
        const ncPath = part.nc?.path
        const nc =
          ncOverrides.get(part.mark)?.bytes ?? (ncPath ? bytesByPath.get(ncPath) : undefined)
        if (!nc) continue
        try {
          const step = await reconstructForViewer(new TextDecoder().decode(nc))
          if (step) setOverride(part.mark, step, 'regenerated')
        } catch {
          // Skip a part whose NC can't be rebuilt; the others still convert.
        }
      }
    } finally {
      setExporting(false)
    }
  }, [result, selectedMarks, ncOverrides, bytesByPath, setOverride, t])

  /**
   * Exports the ticked parts' PDF drawing + STEP + NC together in one flattened zip, with the fix
   * overrides applied and the STEP/NC written in the canonical manufacturing orientation.
   */
  const exportSelected = useCallback(async () => {
    if (!result || !bundle || selectedMarks.size === 0) return
    setExporting(true)
    try {
      const files = new Map<string, Uint8Array>()
      const selected = result.parts.filter((part) => selectedMarks.has(part.mark))
      const resolved = await Promise.all(
        selected.map(async (part) => ({
          part,
          step:
            part.step?.path || stepOverrides.has(part.mark)
              ? await exportStepBytes(part)
              : undefined,
          nc: part.nc?.path ? exportNcBytes(part) : undefined,
          ncep: part.nc?.path ? exportNcepBytes(part) : undefined,
        })),
      )
      for (const { part, step, nc, ncep } of resolved) {
        if (part.pdf?.path) {
          const bytes = bytesByPath.get(part.pdf.path)
          if (bytes) files.set(part.pdf.path, bytes)
        }
        if (step) files.set(exportStepPath(part), step)
        if (nc && part.nc?.path) files.set(part.nc.path, nc)
        if (ncep) files.set(`${part.mark}.ncep`, ncep)
      }
      if (files.size === 0) {
        setError(t('preflight.findings.nothingSelected'))
        return
      }
      downloadBlob(
        `${fileStem(result.sourceName)}-selected.zip`,
        new Blob([zipSync(flattenZipEntries(files))], { type: 'application/zip' }),
      )
    } finally {
      setExporting(false)
    }
  }, [
    result,
    bundle,
    selectedMarks,
    stepOverrides,
    bytesByPath,
    exportStepBytes,
    exportNcBytes,
    exportNcepBytes,
    t,
  ])

  if (loadingProject) {
    return (
      <div className="rounded-lg border border-border px-3.5 py-3 text-sm text-muted-foreground">
        {t('preflight.projects.loading')}
      </div>
    )
  }

  if (missingProject) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border px-3.5 py-3">
        <p className="text-sm text-muted-foreground">{t('preflight.projects.notFound')}</p>
        <Button size="sm" onClick={() => void navigate({ to: '/preflight' })}>
          {t('preflight.projects.back')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {result && bundle ? (
        <JobPanel
          sourceName={bundle.sourceName}
          entries={bundle.entries}
          batches={batches}
          onBatchesChange={changeBatches}
          onAdd={addToBundle}
          onError={setError}
          onDelete={deleteEntries}
        />
      ) : (
        <DropZone onBundle={handleBundle} onError={setError} />
      )}

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 px-3.5 py-3 text-sm text-destructive-foreground">
          {error}
        </div>
      )}

      {result && (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={t('preflight.stats.parts')} value={result.summary.parts} />
          <Stat label={t('preflight.stats.totalQty')} value={totalQty} />
          <Stat
            label={t('preflight.stats.totalLength')}
            value={totalLengthMm > 0 ? `${(totalLengthMm / 1000).toFixed(1)} m` : '—'}
            pending={analyzing && drawingChecking}
          />
          <Stat
            label={t('preflight.stats.totalMass')}
            value={totalMassKg > 0 ? formatMass(totalMassKg, i18n.language) : '—'}
            title={
              totalMassKg > 0 ? `${formatNumber(totalMassKg, 1, i18n.language)} kg` : undefined
            }
            pending={analyzing && drawingChecking}
          />
        </section>
      )}

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
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
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSectionLookupOpen(true)}>
              {t('preflight.profiles.lookup')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPurchaseOpen(true)}
              disabled={purchaseGroups.length === 0}
            >
              {t('preflight.purchase.open')}
            </Button>
          </div>
        </CardHeader>
        {profilesOpen && (
          <CardContent>
            {profileGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('preflight.profiles.empty')}</p>
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
                <TableBody className="row-spotlight">
                  {profileGroups.map((group, index) => (
                    <TableRow
                      key={group.profile}
                      className={cn(group.profile !== '—' && 'cursor-pointer')}
                      title={
                        group.profile !== '—'
                          ? t('preflight.profileSettings.open', { profile: group.profile })
                          : undefined
                      }
                      onClick={() => {
                        if (group.profile !== '—') setSettingsProfileIndex(index)
                      }}
                    >
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
                          formatMass(group.massKg, i18n.language)
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
            {result && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('preflight.source')}:{' '}
                <span className="font-mono">
                  {result.entriesTotal} {t('preflight.stats.files').toLowerCase()} ·{' '}
                  {t('preflight.stats.partList')}:{' '}
                  {result.summary.hasPartList ? t('preflight.stats.yes') : t('preflight.stats.no')}
                </span>
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {result && result.parts.length > 0 && (
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
                  {sortedParts.length !== visibleParts.length ? `/${sortedParts.length}` : ''})
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
                  className="h-8 w-56 rounded-md border border-border bg-background pl-7 pr-7 text-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
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
                size="sm"
                onClick={() => void autoFixSelected()}
                disabled={autoFixableMarks.size === 0 || exporting || autoFixing !== null}
                title={t('preflight.findings.autoFixHint')}
              >
                <Wand className="size-4 shrink-0" aria-hidden />
                {autoFixing
                  ? t('preflight.findings.autoFixing', autoFixing)
                  : t('preflight.findings.autoFix', { count: autoFixableMarks.size })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void ncToStepSelected()}
                disabled={selectedMarks.size === 0 || exporting || autoFixing !== null}
                title={t('preflight.findings.ncToStepHint')}
              >
                {t('preflight.findings.ncToStep', { count: selectedMarks.size })}
              </Button>
              <Button
                size="sm"
                onClick={() => void exportSelected()}
                disabled={selectedMarks.size === 0 || exporting || autoFixing !== null}
              >
                {t('preflight.findings.exportSelected', { count: selectedMarks.size })}
              </Button>
            </div>
          </CardHeader>
          {partsOpen && (
            <CardContent>
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">
                  {t('preflight.parts.filterStatus')}
                </span>
                <Toggle
                  size="xs"
                  pressed={activeStatus === null}
                  onPressedChange={() => setStatusFilter('all')}
                >
                  {t('preflight.filters.all')}
                </Toggle>
                {(
                  [
                    ['error', t('preflight.filters.error'), statusCounts.error],
                    ['warning', t('preflight.filters.warning'), statusCounts.warning],
                    ['ok', t('preflight.status.ok'), statusCounts.ok],
                  ] as const
                ).map(([status, label, count]) => (
                  <Toggle
                    key={status}
                    size="xs"
                    pressed={activeStatus === status}
                    onPressedChange={() => setStatusFilter(status)}
                  >
                    {label}
                    <span className="font-mono opacity-60">{count}</span>
                  </Toggle>
                ))}
                <span className="mx-0.5 h-3.5 w-px bg-border" aria-hidden />
                <Toggle
                  size="xs"
                  pressed={fixFilter === 'auto'}
                  disabled={fixCounts.auto === 0}
                  onPressedChange={() =>
                    setFixFilter((current) => (current === 'auto' ? null : 'auto'))
                  }
                  title={t('preflight.filters.autoFixableHint')}
                >
                  <Wand className="size-3! shrink-0" aria-hidden />
                  {t('preflight.filters.autoFixable')}
                  <span className="font-mono opacity-60">{fixCounts.auto}</span>
                </Toggle>
                <Toggle
                  size="xs"
                  pressed={fixFilter === 'manual'}
                  disabled={fixCounts.manual === 0}
                  onPressedChange={() =>
                    setFixFilter((current) => (current === 'manual' ? null : 'manual'))
                  }
                  title={t('preflight.filters.fixIndividuallyHint')}
                >
                  <Wrench className="size-3! shrink-0" aria-hidden />
                  {t('preflight.filters.fixIndividually')}
                  <span className="font-mono opacity-60">{fixCounts.manual}</span>
                </Toggle>
                {assemblyOptions.length > 0 && (
                  <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{t('preflight.parts.filterAssembly')}</span>
                    <select
                      value={assemblyFilter ?? ''}
                      onChange={(event) => setAssemblyFilter(event.target.value || null)}
                      className="h-7 max-w-56 rounded-md border border-border bg-background px-1.5 text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">{t('preflight.parts.allAssemblies')}</option>
                      {assemblyOptions.map((assembly) => (
                        <option key={assembly} value={assembly}>
                          {assembly}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
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
                        align={column.align}
                        width={column.width}
                      />
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody className="row-spotlight row-spotlight--sticky-cols [&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:z-10 [&_td:first-child]:bg-card [&_td:nth-child(2)]:sticky [&_td:nth-child(2)]:left-8 [&_td:nth-child(2)]:z-10 [&_td:nth-child(2)]:bg-card">
                  {visibleParts.length === 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={PART_COLUMNS.length + 1}
                        className="text-center text-sm text-muted-foreground"
                      >
                        {assemblyFilter && !markQuery.trim()
                          ? t('preflight.parts.assemblyEmpty', { assembly: assemblyFilter })
                          : fixFilter
                            ? t('preflight.filters.fixEmpty')
                            : t('preflight.parts.searchEmpty', { query: markQuery.trim() })}
                      </TableCell>
                    </TableRow>
                  )}
                  {visibleParts.map((part) => {
                    const material = drawingMaterials.get(part.mark)
                    const pdfQty = material?.qty ?? part.expected?.qty ?? null
                    const ncQty = part.nc?.quantity ?? null
                    const stepQty = part.step?.quantity ?? null
                    const qtyMismatch = pdfQty != null && ncQty != null && pdfQty !== ncQty
                    const qtyFallback = pdfQty == null && ncQty != null
                    const stepQtyFallback = pdfQty == null && ncQty == null && stepQty != null
                    const mass = pieceMass(part)
                    const band = massBand(mass)
                    const pills = issuesByMark.get(part.mark) ?? []
                    const weld = weldEtchings.get(part.mark)
                    const assemblyUsage = assemblyFilter
                      ? part.assemblies?.find((usage) => usage.assembly === assemblyFilter)
                      : undefined
                    const qtyKnown =
                      assemblyUsage != null || pdfQty != null || ncQty != null || stepQty != null
                    const section = sectionLabel(part)
                    const sizeCheck = modelChecks.get(part.mark)
                    const sizeFails = failsSize(sizeCheck)
                    return (
                      <TableRow
                        key={part.mark}
                        tabIndex={0}
                        onClick={() => openPart(part)}
                        onMouseEnter={() => prefetchPart(part)}
                        onFocus={() => prefetchPart(part)}
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
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          {/* A span so the row spotlight can fade the sticky cell's
                              contents without fading its opaque background. */}
                          <span>{part.mark}</span>
                        </TableCell>
                        <TableCell className="text-left">
                          <div className="flex flex-wrap gap-1">
                            {/* A weld etching is a marker, not a problem: an otherwise clean part
                                is still OK, and the OK filter must keep finding it. */}
                            {pills.length === 0 && (
                              <FilterPill
                                token="ok"
                                active={isFilterTokenActive('ok')}
                                title={t('preflight.status.ok')}
                                onToggle={toggleFilterToken}
                              >
                                <Badge variant="success">{t('preflight.status.ok')}</Badge>
                              </FilterPill>
                            )}
                            {pills.map((pill) => {
                              const tier = fixTier(part, pill.finding)
                              return (
                                <FilterPill
                                  key={pill.code}
                                  token={pill.code}
                                  active={isFilterTokenActive(pill.code)}
                                  title={
                                    findingText(pill.finding) +
                                    (tier === 'auto'
                                      ? ` · ${t('preflight.status.autoFix')}`
                                      : tier === 'manual'
                                        ? ` · ${t('preflight.status.fixIndividually')}`
                                        : '')
                                  }
                                  onToggle={toggleFilterToken}
                                >
                                  <Badge
                                    variant={SEVERITY_VARIANT[pill.severity]}
                                    className="gap-1 font-mono"
                                  >
                                    {tier === 'auto' && (
                                      <Wand className="size-3 shrink-0" aria-hidden />
                                    )}
                                    {tier === 'manual' && (
                                      <Wrench className="size-3 shrink-0" aria-hidden />
                                    )}
                                    {pill.code}
                                    {pill.count > 1 && ` ×${pill.count}`}
                                  </Badge>
                                </FilterPill>
                              )
                            })}
                            {/* Weld etchings are info, not a problem: last, after the findings. */}
                            {weld && (
                              <FilterPill
                                token="weld"
                                active={isFilterTokenActive('weld')}
                                title={weldEtchingsTitle(t, weld)}
                                onToggle={toggleFilterToken}
                              >
                                <Badge variant="info" className="gap-1 font-mono">
                                  {t('preflight.status.weld')}
                                </Badge>
                              </FilterPill>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {part.assemblies && part.assemblies.length > 0 ? (
                            <div className="flex flex-wrap justify-end gap-1">
                              {part.assemblies.map((usage) => (
                                <button
                                  key={usage.assembly}
                                  type="button"
                                  aria-pressed={assemblyFilter === usage.assembly}
                                  title={t('preflight.qty.assemblyTitle', {
                                    assembly: usage.assembly,
                                    qty: usage.qtyPerAssembly,
                                    count: usage.assemblyQty,
                                    total: usage.total,
                                  })}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    setAssemblyFilter((current) =>
                                      current === usage.assembly ? null : usage.assembly,
                                    )
                                  }}
                                  className={cn(
                                    'cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                    assemblyFilter === usage.assembly &&
                                      'ring-2 ring-ring ring-offset-1 ring-offset-card',
                                  )}
                                >
                                  <Badge variant="muted" className="font-mono">
                                    {usage.assembly}
                                  </Badge>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'whitespace-nowrap text-right tabular-nums',
                            !assemblyUsage &&
                              qtyMismatch &&
                              'font-semibold text-destructive-foreground',
                          )}
                          title={
                            assemblyUsage
                              ? t('preflight.qty.assemblyTitle', {
                                  assembly: assemblyUsage.assembly,
                                  qty: assemblyUsage.qtyPerAssembly,
                                  count: assemblyUsage.assemblyQty,
                                  total: assemblyUsage.total,
                                })
                              : !qtyKnown
                                ? t('preflight.qty.unknownTitle')
                                : qtyMismatch
                                  ? t('preflight.qty.mismatchTitle', { nc: ncQty, pdf: pdfQty })
                                  : qtyFallback
                                    ? t('preflight.qty.fallbackTitle')
                                    : stepQtyFallback
                                      ? t('preflight.qty.stepFallbackTitle')
                                      : undefined
                          }
                        >
                          {assemblyUsage?.total ?? pdfQty ?? ncQty ?? stepQty ?? '?'}
                          {!assemblyUsage && qtyMismatch && (
                            <span className="ml-1 text-xs">≠ {ncQty}</span>
                          )}
                          {!assemblyUsage && qtyFallback && (
                            <span className="ml-1 text-xs text-muted-foreground">(NC)</span>
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'whitespace-nowrap text-right font-mono text-xs tabular-nums',
                            band && MASS_BAND_CLASS[band],
                          )}
                          title={
                            band === 'red'
                              ? t('preflight.mass.heavy', { kg: MASS_RED_KG })
                              : band === 'yellow'
                                ? t('preflight.mass.medium', { kg: MASS_YELLOW_KG })
                                : undefined
                          }
                        >
                          {mass != null ? mass.toFixed(1) : '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-mono text-xs">
                          <FilterPill
                            token={section}
                            active={isFilterTokenActive(section)}
                            title={t('preflight.columns.profile')}
                            onToggle={toggleFilterToken}
                          >
                            <Badge variant="muted" className="font-mono">
                              {section}
                            </Badge>
                          </FilterPill>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right text-xs">
                          {overrideFor(part) ? (
                            <Badge variant="success">
                              {overrideFor(part)?.kind
                                ? t(`common.fix.${overrideFor(part)?.kind}`)
                                : ''}
                            </Badge>
                          ) : sizeCheck ? (
                            <span
                              // On a mismatch the colour moves to the failing dimension, so the
                              // rest of the triple fades back and the wrong number stands out.
                              className={cn(!sizeFails && sizeCheckTone(sizeCheck))}
                              title={sizeCheckTitle(t, sizeCheck)}
                            >
                              {sizeSegments(t, sizeCheck).map((segment) => (
                                <span
                                  key={segment.dim}
                                  className={
                                    sizeFails
                                      ? segment.bad
                                        ? 'font-semibold text-amber-400'
                                        : 'text-muted-foreground'
                                      : undefined
                                  }
                                >
                                  {segment.text}
                                </span>
                              ))}
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
      )}

      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={
          viewing ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{viewing.mark}</span>
              {viewingIndex >= 0 && (
                <div className="flex shrink-0 items-center gap-0.5">
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
                  <span
                    className="w-16 whitespace-nowrap text-center text-xs font-normal tabular-nums text-muted-foreground"
                    aria-live="polite"
                  >
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
                      {viewing.nc && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-auto rounded-sm px-1.5 py-0.5 text-[11px] leading-none"
                          disabled={!ncBytes || fixingMark === viewing.mark}
                          onClick={() => void regeneratePart(viewing)}
                          title={t('preflight.viewer.ncToStepHint')}
                        >
                          {fixingMark === viewing.mark
                            ? t('common.actions.working')
                            : t('preflight.viewer.ncToStep')}
                        </Button>
                      )}
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
                    {(viewingNcGeom ||
                      viewingCutThicknesses.length > 0 ||
                      (overlayShown && mfgDiff)) && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-card/50 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                        {(viewingNcGeom || viewingCutThicknesses.length > 0) && (
                          <NcLegend
                            thicknesses={viewingCutThicknesses}
                            markings={viewingMarkKinds}
                          />
                        )}
                        {overlayShown && mfgDiff && <DiffLegend info={mfgDiff} />}
                      </div>
                    )}
                  </div>
                  {viewingFaceMap && (
                    <div
                      className="flex w-14 shrink-0 grow-0 basis-auto items-center justify-center self-stretch border-l border-border p-1"
                      title={t('preflight.viewer.faceMap')}
                    >
                      <FaceMapSquare layout={viewingFaceMap} />
                    </div>
                  )}
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
                            stock={viewerStock}
                            bus={orbitBus}
                            highlightStray
                            smoothLines
                            alignReference={manufactured}
                            seatProfile={stepIrSection?.points ?? null}
                            stepSeat={stepSeatForViewing}
                            focus={findingFocus}
                            // The STEP pane is STEP-only: no NC marks, section, frame or alignment
                            // reference. Its cut lines come from the STEP-derived IR options.
                            sabreFailures={viewerMarkers.failures}
                            ncMarks={null}
                            ncSection={stepIrSection?.points ?? null}
                            faceFrame={stepFaceFrame}
                            cutEdges={stepCutEdgeOptions}
                            visibleSpans={visibleSpans}
                            visibleRuns={visibleRuns}
                            highlightRun={highlightRun}
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
                            hiddenOutOfRange={hiddenOutOfRange}
                            highlightWarning={highlightWarning}
                            bytes={manufactured}
                            stock={viewerStock}
                            bus={orbitBus}
                            ncPrimary
                            // The rebuild is oriented to the STEP frame, so the guilty-cut
                            // marks land on what the laser will actually cut — not the ideal.
                            sabreFailures={viewerMarkers.failures}
                            sabrePoints={manufacturedSabrePoints}
                            nc={viewingNcGeom}
                            ncSection={viewingNcSection}
                            faceFrame={viewingNcFrame}
                            visibleSpans={visibleSpans}
                            visibleRuns={visibleRuns}
                            highlightRun={highlightRun}
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
                            hiddenOutOfRange={hiddenOutOfRange}
                            highlightWarning={highlightWarning}
                            bytes={manufactured}
                            compareBytes={stepBytes}
                            compareLabel={t('preflight.viewer.step')}
                            stock={viewerStock}
                            bus={orbitBus}
                            ncPrimary
                            focus={findingFocus}
                            sabreFailures={viewerMarkers.failures}
                            ncMarks={viewingNcGeom?.marks ?? null}
                            ncSection={viewingNcSection}
                            faceFrame={viewingNcFrame}
                            visibleSpans={visibleSpans}
                            visibleRuns={visibleRuns}
                            highlightRun={highlightRun}
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
                      { id: 'info' as const, label: t('preflight.viewer.info') },
                      ...(viewingPdfBytes
                        ? [{ id: 'drawing' as const, label: t('preflight.viewer.drawing') }]
                        : []),
                      {
                        id: 'issues' as const,
                        label: t('preflight.warnings.issues', { count: viewerFindings.length }),
                      },
                      { id: 'surface' as const, label: t('preflight.viewer.surface') },
                    ]}
                    value={rightTab}
                    onChange={(id) => {
                      rightTabMark.current = viewing?.mark ?? null
                      setRightTab(id)
                    }}
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {rightTab === 'info' ? (
                    <div className="h-full overflow-auto p-3 @container">
                      <div className="flex flex-wrap items-start gap-3">
                        <div className="flex w-full min-w-0 items-start gap-3 @[42rem]:flex-1">
                          <div className="w-[9.5rem] shrink-0">
                            <SectionPreview
                              section={partSectionForCode(sectionLabel(viewing), viewingDims)}
                              label={sectionLabel(viewing)}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <PartSummary
                              part={viewing}
                              material={drawingMaterials.get(viewing.mark)}
                              profile={sectionLabel(viewing)}
                              massKg={pieceMass(viewing)}
                              qty={partQty(viewing)}
                              lengthMm={partLength(viewing)}
                            />
                          </div>
                        </div>
                        <div className="w-full min-w-0 @[42rem]:flex-1">
                          <CutSettings profile={sectionLabel(viewing)} dims={viewingDims} compact />
                        </div>
                      </div>
                    </div>
                  ) : rightTab === 'surface' ? (
                    <IrSurfaceDrawing
                      views={irViews}
                      layout={resolvedLayout}
                      colorForFace={viewingIrColorForFace}
                      onExport={viewingNcIr ? downloadViewingNcep : undefined}
                    />
                  ) : rightTab === 'issues' ? (
                    <ViewerWarnings
                      findings={viewerFindings}
                      step={viewing.step}
                      ncApplied={ncAppliedRows}
                      // The bevel dialog sits over the rows, so the pointer leaving a row must not clear
                      // its highlight; keep the row highlighted through apply and the rebuild.
                      onHover={(index) => {
                        if (index === null && bevelEdit) return
                        setHoverIssueIndex(index)
                      }}
                      isChecked={(index) => !hiddenIssues.has(index)}
                      onToggleCheck={toggleIssue}
                      onActivate={activateIssue}
                      allShown={hiddenIssues.size === 0}
                      onToggleAll={toggleAllIssues}
                      fix={{
                        override: overrideFor(viewing)?.kind,
                        canClean: isCleanable(viewing),
                        canTab: isTabbable(viewing),
                        canRegenerate: isRegeneratable(viewing),
                        canSimplify: isSimplifiable(viewing),
                        canRepair:
                          Boolean(viewing.step) && modelChecks.get(viewing.mark)?.stray === true,
                        canRemoveCut: Boolean(viewing.nc),
                        canMoveCut: Boolean(viewing.nc),
                        canSetBevel: Boolean(viewing.nc),
                        ncEdit: ncOverrides.get(viewing.mark),
                        pending: fixingMark === viewing.mark,
                        onClean: () => void cleanPart(viewing),
                        onTab: () => openTabEdit(viewing),
                        onRegenerate: () => void regeneratePart(viewing),
                        onSimplify: () => void simplifyPart(viewing),
                        onRepair: () => void cleanTeklaPart(viewing),
                        onRemoveCut: (finding) => void removeCut(viewing, finding),
                        onMoveCut: (finding) => openMoveEdit(viewing, finding),
                        onSetBevel: (finding) => openBevelEdit(viewing, finding),
                        onUndo: () => undoOverride(viewing.mark),
                        onUndoNc: (finding) => undoNcFinding(viewing, finding),
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

      <PurchaseDialog
        open={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
        groups={purchaseGroups}
        jobName={result?.sourceName}
      />

      <ProfileSettingsDialog
        open={settingsProfileIndex !== null}
        onClose={() => setSettingsProfileIndex(null)}
        profile={settingsGroup?.profile ?? ''}
        dims={settingsGroup?.dims ?? []}
        marks={settingsGroup?.marks ?? []}
        onNavigate={navigateProfile}
        canPrevious={settingsProfileIndex !== null && settingsProfileIndex > 0}
        canNext={settingsProfileIndex !== null && settingsProfileIndex < profileGroups.length - 1}
        position={
          settingsProfileIndex === null
            ? undefined
            : { index: settingsProfileIndex + 1, total: profileGroups.length }
        }
      />

      <SectionLookupDialog open={sectionLookupOpen} onClose={() => setSectionLookupOpen(false)} />

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

      <MoveMenu
        open={moveEdit !== null}
        suggested={
          typeof moveEdit?.finding.params?.delta === 'number'
            ? String(moveEdit.finding.params.delta)
            : undefined
        }
        direction={moveEdit?.finding.params?.direction === 'outward' ? 'outward' : 'inward'}
        offset={moveOffset}
        onOffset={setMoveOffset}
        onApply={applyMoveEdit}
        onClose={closeMoveEdit}
      />

      <TabDialog
        open={tabEdit !== null}
        density={tabDensity}
        tabLength={tabLength}
        tabWidth={tabWidth}
        engagement={tabEngagement}
        detected={tabDetected}
        detecting={tabDetecting}
        onDensity={setTabDensity}
        onTabLength={setTabLength}
        onTabWidth={setTabWidth}
        onEngagement={setTabEngagement}
        onUseDetected={useDetectedTabDefaults}
        onApply={applyTabEdit}
        onClose={closeTabEdit}
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
  const { t, i18n } = useTranslation()
  const section = profile ?? listedProfile(part) ?? '—'
  const qty =
    qtyProp ??
    material?.qty ??
    part.expected?.qty ??
    part.nc?.quantity ??
    part.step?.quantity ??
    null
  const length = lengthMm ?? material?.length ?? part.expected?.length ?? part.nc?.length ?? null
  const mass = massKg ?? material?.weight ?? part.expected?.weight ?? null
  const grade = part.nc?.grade ?? part.expected?.grade ?? '—'
  const rows: [string, string][] = [
    [t('preflight.columns.mark'), part.mark],
    [t('preflight.columns.profile'), section],
    [t('preflight.columns.grade'), grade],
    [t('preflight.columns.qty'), qty != null ? String(qty) : '—'],
    [t('preflight.meta.length'), length != null ? `${length} mm` : '—'],
    [t('preflight.meta.mass'), mass != null ? formatMass(mass, i18n.language) : '—'],
  ]
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableBody>
          {rows.map(([label, value]) => (
            <TableRow key={label}>
              <TableCell className="w-24 whitespace-nowrap px-2 py-1 text-xs text-muted-foreground">
                {label}
              </TableCell>
              <TableCell className="px-2 py-1 font-mono text-xs tabular-nums">{value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

interface ViewerFix {
  override?: StepFixKind
  canClean: boolean
  /** Keep all nested bodies and join them with tabs (for an already-nested STEP). */
  canTab: boolean
  canRegenerate: boolean
  canSimplify: boolean
  /** A STEP repair is possible when the part has a real STEP to harvest features from. */
  canRepair: boolean
  /** A `CUT_UNCLOSED` finding can be resolved by editing the NC. */
  canRemoveCut: boolean
  /** A `CUT_ROOT_FILLET` finding can be resolved by moving the cut line off the fillet in the NC. */
  canMoveCut: boolean
  /** A `CUT_BEVEL_CHANGE` finding can be resolved by unifying the cut line's bevel via the NC. */
  canSetBevel: boolean
  /** A `BEVEL_OUT_OF_RANGE` finding can be resolved by removing that prep from the NC. */
  /** The NC edit already applied to the part, if any. */
  ncEdit?: NcOverride
  pending: boolean
  onClean: () => void
  onTab: () => void
  onRegenerate: () => void
  onSimplify: () => void
  onRepair: () => void
  onRemoveCut: (finding: Finding) => void
  onMoveCut: (finding: Finding) => void
  onSetBevel: (finding: Finding) => void
  onUndo: () => void
  onUndoNc: (finding: Finding) => void
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
  if (kind === 'moveCut')
    return {
      label: t('common.actions.moveCut'),
      pendingLabel: t('common.actions.working'),
      run: () => fix.onMoveCut(finding),
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
  if (kind === 'moveCut') return fix.canMoveCut
  if (kind === 'setBevel') return fix.canSetBevel
  return fix.canSimplify
}

/** Findings + file problems for the viewed part, shown above the 3D so debugging is fast. */
function ViewerWarnings({
  findings,
  step,
  fix,
  ncApplied,
  onHover,
  isChecked,
  onToggleCheck,
  onActivate,
  allShown = true,
  onToggleAll,
}: {
  findings: Finding[]
  step?: StepFile
  fix?: ViewerFix
  /** Row indices whose own NC edit is applied (their action is Undo). */
  ncApplied?: ReadonlySet<number>
  onHover?: (index: number | null) => void
  isChecked?: (index: number) => boolean
  onToggleCheck?: (index: number) => void
  onActivate?: (index: number) => void
  allShown?: boolean
  onToggleAll?: () => void
}) {
  const { t } = useTranslation()
  // Sortable issues table: defaults to location along the member (grouped by where you'd walk
  // the beam), and can be re-sorted by severity (worst first) or by type (code).
  const [sort, setSort] = useState<{
    key: 'severity' | 'code' | 'location' | 'fix'
    dir: 1 | -1
  }>({
    key: 'location',
    dir: 1,
  })
  const toggleSort = (key: 'severity' | 'code' | 'location' | 'fix') =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  /** Location along the member (mm) a finding sits at, or null when it has none. */
  const locationOf = findingLocationOf
  /** Whether a finding can be fixed with the actions currently available for this part. */
  const fixableFinding = (finding: Finding): boolean => {
    if (!fix) return false
    if (finding.code === 'STRAY_BODY') return fix.canClean || fix.canTab || fix.canRepair
    if (fix.override && resolvedFindings(fix.override).includes(finding.code)) return false
    const kind = fixForFinding(finding)
    return Boolean(kind && viewerFixAvailable(fix, kind))
  }
  const rows = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      if (sort.key === 'fix') {
        const fa = fixableFinding(a.finding) ? 1 : 0
        const fb = fixableFinding(b.finding) ? 1 : 0
        if (fa !== fb) return (fa - fb) * sort.dir
        return SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]
      }
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
    t(
      finding.code === 'CUT_DEPTH' && finding.params?.nc === 1
        ? 'findings.CUT_DEPTH_NC'
        : `findings.${finding.code}`,
      {
        ...finding.params,
        defaultValue: finding.message,
      },
    )
  /** A sortable column header, with an up/down arrow when it's the active sort. */
  const SortHead = ({
    k,
    label,
  }: {
    k: 'severity' | 'code' | 'location' | 'fix'
    label: string
  }) => (
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
  const hasFixRow = Boolean(fix?.override || fix?.canRegenerate || fix?.canSimplify || fix?.ncEdit)
  if (rows.length === 0 && !invalid && !hasFixRow) return null
  const errors = rows.filter(({ finding }) => finding.severity === 'error').length
  const warnings = rows.filter(({ finding }) => finding.severity === 'warning').length
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-auto bg-card px-4 py-2">
      {rows.length > 0 && (
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <span className="font-semibold">
            {t('preflight.warnings.issues', { count: rows.length })}
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
      {rows.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-auto w-8 px-3 py-1">
                  {onToggleAll ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-5 p-0.5 text-muted-foreground hover:text-foreground"
                      onClick={onToggleAll}
                      title={
                        allShown ? t('preflight.warnings.hideAll') : t('preflight.warnings.showAll')
                      }
                      aria-label={
                        allShown ? t('preflight.warnings.hideAll') : t('preflight.warnings.showAll')
                      }
                    >
                      {allShown ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                    </Button>
                  ) : null}
                </TableHead>
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
                <TableHead className="w-48">
                  <SortHead k="fix" label={t('preflight.warnings.colFix')} />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ finding, index }) => {
                const stepResolved = Boolean(
                  fix?.override && resolvedFindings(fix.override).includes(finding.code),
                )
                const resolved = stepResolved || finding.params?.resolved === 1
                const applied = ncApplied?.has(index) ?? false
                // An applied-but-still-failing fix offers Undo (not the fix) so it can be reverted.
                const fixKind = fix && !resolved && !applied ? fixForFinding(finding) : null
                const fixable = Boolean(fixKind && fix && viewerFixAvailable(fix, fixKind))
                const action = fixKind && fix ? viewerFixAction(t, fix, fixKind, finding) : null
                // Only findings the viewer can point at in 3D get an eye toggle / are clickable.
                const showable = isVisualisable(finding)
                return (
                  <TableRow
                    key={`${finding.code}-${findingOpKey(finding) ?? finding.params?.index ?? finding.message}`}
                    tabIndex={showable ? 0 : undefined}
                    onClick={showable && onActivate ? () => onActivate(index) : undefined}
                    onKeyDown={
                      showable
                        ? (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              onActivate?.(index)
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
                        <button
                          type="button"
                          title={t('preflight.warnings.toggleIssue')}
                          disabled={resolved}
                          onClick={(event) => {
                            event.stopPropagation()
                            onToggleCheck?.(index)
                          }}
                          className={cn(
                            'inline-flex rounded p-0.5 disabled:cursor-not-allowed disabled:opacity-40',
                            isChecked?.(index) && !resolved
                              ? 'text-primary'
                              : 'text-muted-foreground',
                          )}
                        >
                          {isChecked?.(index) && !resolved ? (
                            <Eye className="size-4" />
                          ) : (
                            <EyeOff className="size-4" />
                          )}
                        </button>
                      ) : null}
                    </TableCell>
                    <TableCell className="py-1">
                      <span
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                          resolved && 'opacity-40 saturate-0',
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
                      {applied ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          disabled={fix?.pending}
                          onClick={(event) => {
                            event.stopPropagation()
                            fix?.onUndoNc(finding)
                          }}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <Undo2 />
                          {t('common.actions.undo')}
                        </Button>
                      ) : stepResolved ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          disabled={fix?.pending}
                          onClick={(event) => {
                            event.stopPropagation()
                            fix?.onUndo()
                          }}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <Undo2 />
                          {t('common.actions.undo')}
                        </Button>
                      ) : finding.code === 'STRAY_BODY' &&
                        fix &&
                        (fix.canClean || fix.canTab || fix.canRepair) ? (
                        <div className="flex flex-wrap justify-end gap-1">
                          {fix.canClean && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7"
                              disabled={fix.pending}
                              onClick={(event) => {
                                event.stopPropagation()
                                fix.onClean()
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              {fix.pending
                                ? t('common.actions.cleaning')
                                : t('common.actions.cleanStep')}
                            </Button>
                          )}
                          {fix.canTab && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7"
                              disabled={fix.pending}
                              onClick={(event) => {
                                event.stopPropagation()
                                fix.onTab()
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              {fix.pending
                                ? t('common.actions.working')
                                : t('common.actions.addTabs')}
                            </Button>
                          )}
                          {fix.canRepair && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7"
                              disabled={fix.pending}
                              onClick={(event) => {
                                event.stopPropagation()
                                fix.onRepair()
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              {fix.pending
                                ? t('common.actions.working')
                                : t('common.actions.cleanTekla')}
                            </Button>
                          )}
                        </div>
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
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {invalid && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
          {invalid}
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
    </div>
  )
}

/**
 * The "move cut" mini menu for a `CUT_ROOT_FILLET` cut line. The suggested offset (signed across
 * the face) is prefilled so the operator can apply it unchanged or tune it — a larger magnitude
 * clears the fillet further, the opposite sign moves the cut the other way.
 */
function MoveMenu({
  open,
  suggested,
  direction,
  offset,
  onOffset,
  onApply,
  onClose,
}: {
  open: boolean
  suggested?: string
  direction: 'inward' | 'outward'
  offset: string
  onOffset: (value: string) => void
  onApply: (offset: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const parsed = Number.parseFloat(offset)
  const valid = Number.isFinite(parsed) && Math.abs(parsed) > 1e-6
  return (
    <Dialog open={open} onClose={onClose} title={t('preflight.move.title')}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="move-offset" className="text-sm font-medium">
            {t('preflight.move.offset')}
          </label>
          <input
            id="move-offset"
            type="number"
            inputMode="decimal"
            step="0.5"
            value={offset}
            onChange={(event) => onOffset(event.target.value)}
            className="h-8 w-24 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span className="text-sm text-muted-foreground">mm</span>
          {suggested && (
            <span className="text-xs text-muted-foreground">
              {t('preflight.move.recommended', { offset: suggested, direction })}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('preflight.move.hint')}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button size="sm" disabled={!valid} onClick={() => onApply(parsed)}>
            {t('preflight.move.apply')}
          </Button>
        </div>
      </div>
    </Dialog>
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
  title,
}: {
  label: string
  value: number | string
  tone?: Severity
  pending?: boolean
  title?: string
}) {
  return (
    <div
      className="flex flex-col gap-0.5 rounded-xl border border-border bg-card px-3.5 py-3"
      title={title}
    >
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

/**
 * A tiny square plane labelled with the four DSTV faces (`o`/`u`/`v`/`h`) in the canonical
 * cross-section, drawn as if the beam direction arrow points at the viewer (looking down the
 * member). Static by design, so the letters read at a glance without tracking the 3D camera.
 */
function FaceMapSquare({ layout }: { layout: FaceMapEntry[] }) {
  const size = 40
  const c = size / 2
  const half = 8
  const radius = half + 6
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${size} ${size}`} className="size-full text-foreground">
      <rect
        x={c - half}
        y={c - half}
        width={half * 2}
        height={half * 2}
        fill="currentColor"
        fillOpacity={0.08}
        stroke="currentColor"
        strokeWidth={0.6}
        strokeLinejoin="round"
      />
      {layout.map(({ face, dx, dy }) => (
        <text
          key={face}
          x={c + dx * radius}
          y={c - dy * radius}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={8}
          fontWeight={600}
          fill="currentColor"
        >
          {face}
        </text>
      ))}
    </svg>
  )
}

export interface IrSurfaceView {
  id: string
  label: string
  nc: PartIr | null
  step: PartIr | null
  diff?: boolean
}

function IrSurfaceDrawing({
  views,
  layout,
  colorForFace,
  onExport,
}: {
  views: IrSurfaceView[]
  layout: 'rows' | 'cols'
  colorForFace?: (face: NcFace) => string | undefined
  onExport?: () => void
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<PanZoomView>({ x: 0, y: 0, k: 1 })
  const zoom = Math.max(0.2, Math.min(200, Math.round(view.k * 100) / 100))
  const rendered = views.map((entry) => {
    const base = entry.nc ?? entry.step
    if (!base) return { entry, baseLength: 0, orientation: 'wisecam' as const, parts: null }
    const orientation = base.profileType.trim().toUpperCase() === 'U' ? 'flipY' : 'wisecam'
    return {
      entry,
      baseLength: base.length,
      orientation,
      parts: partIrSvgParts(base, {
        overlay: entry.nc && entry.step ? entry.step : undefined,
        diff: entry.diff,
        stroke: 1 / zoom,
        colorForFace,
        section: false,
        orientation,
      }),
    }
  })
  if (rendered.length === 0) {
    return (
      <div className="grid h-full place-items-center px-4 text-center text-sm text-muted-foreground">
        {t('preflight.viewer.surfaceEmpty')}
      </div>
    )
  }
  // Anchor every pane on the part zero (station 0, along 0). A chart's local y=0 maps to `length`
  // in wisecam/flipY, so shift each body by (maxLength − length); zero then lands at the same
  // shared coordinate. Union the shifted bounds for the common viewBox.
  const sharedLength = Math.max(
    1,
    ...rendered.map((entry) => (entry.parts ? (entry.baseLength ?? 0) : 0)),
  )
  const laidOut = rendered.map((entry) => ({
    ...entry,
    dy: entry.parts ? sharedLength - (entry.baseLength ?? 0) : 0,
  }))
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const entry of laidOut) {
    if (!entry.parts) continue
    const [x, y, width, height] = entry.parts.viewBox.split(' ').map(Number)
    if (x == null || y == null || width == null || height == null) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y + entry.dy)
    maxX = Math.max(maxX, x + width)
    maxY = Math.max(maxY, y + entry.dy + height)
  }
  minY = Math.min(minY, 0)
  maxY = Math.max(maxY, sharedLength)
  const sharedViewBox = Number.isFinite(minX)
    ? `${minX} ${minY} ${maxX - minX} ${maxY - minY}`
    : '0 0 1 1'
  const columns = layout === 'rows' || rendered.length === 1 ? 1 : rendered.length
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t('preflight.viewer.surface')}</span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-red-400" />
          {t('preflight.viewer.surfaceOvercut')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-blue-400" />
          {t('preflight.viewer.surfaceUndercut')}
        </span>
        {onExport && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={onExport}>
            {t('preflight.viewer.downloadNcep')}
          </Button>
        )}
      </div>
      <div
        className={cn(
          'grid min-h-0 flex-1 auto-rows-fr gap-px bg-border',
          columns === 1 ? 'grid-cols-1' : columns === 2 ? 'grid-cols-2' : 'grid-cols-3',
        )}
      >
        {laidOut.map(({ entry, parts, dy }) => (
          <div key={entry.id} className="relative min-h-0 bg-[#0b0f14]">
            <span className="pointer-events-none absolute left-0 top-0 z-10 whitespace-nowrap rounded-br-sm bg-card/85 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground backdrop-blur">
              {entry.label}
            </span>
            {parts ? (
              <PanZoomSvg
                viewBox={sharedViewBox}
                label={entry.label}
                view={view}
                onViewChange={setView}
              >
                <g
                  transform={`translate(0 ${dy})`}
                  dangerouslySetInnerHTML={{ __html: parts.body }}
                />
              </PanZoomSvg>
            ) : (
              <div className="grid h-full place-items-center px-3 text-center text-xs text-muted-foreground">
                {t('preflight.viewer.surfaceEmpty')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export interface PanZoomView {
  x: number
  y: number
  k: number
}

function PanZoomSvg({
  viewBox,
  label,
  children,
  view: controlledView,
  onViewChange,
}: {
  viewBox: string
  label: string
  children: ReactNode
  view?: PanZoomView
  onViewChange?: (view: PanZoomView) => void
}) {
  const [localView, setLocalView] = useState<PanZoomView>({ x: 0, y: 0, k: 1 })
  const view = controlledView ?? localView
  const updateView = (next: PanZoomView): void => {
    if (onViewChange) onViewChange(next)
    else setLocalView(next)
  }
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  return (
    <div
      role="application"
      aria-label={label}
      className={cn(
        'relative h-full w-full touch-none overflow-hidden bg-[#0b0f14] outline-none',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
      )}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y }
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start) return
        updateView({
          ...view,
          x: start.vx + event.clientX - start.x,
          y: start.vy + event.clientY - start.y,
        })
      }}
      onPointerUp={() => {
        drag.current = null
        setDragging(false)
      }}
      onPointerCancel={() => {
        drag.current = null
        setDragging(false)
      }}
      onWheel={(event) => {
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const mx = event.clientX - rect.left
        const my = event.clientY - rect.top
        {
          const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
          const k = Math.min(200, Math.max(0.2, view.k * factor))
          const scale = k / view.k
          updateView({ k, x: mx - (mx - view.x) * scale, y: my - (my - view.y) * scale })
        }
      }}
      onDoubleClick={() => updateView({ x: 0, y: 0, k: 1 })}
    >
      <svg
        viewBox={viewBox}
        preserveAspectRatio="xMinYMin meet"
        className="absolute inset-0 h-full w-full select-none"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          transformOrigin: '0 0',
        }}
      >
        <title>{label}</title>
        {children}
      </svg>
      <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-card/80 px-2 py-0.5 text-[10px] text-muted-foreground">
        drag to pan · wheel to zoom · double-click to reset
      </div>
    </div>
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
  align,
  width,
}: {
  label: string
  sortKey: PartSortKey
  sort: { key: PartSortKey; dir: 1 | -1 }
  onSort: (key: PartSortKey) => void
  /** Value columns sit at the right edge, over their numbers. */
  align?: 'right'
  /** Fixed width, so the column never moves as its values change. */
  width?: string
}) {
  const active = sort.key === sortKey
  return (
    <TableHead className={cn(width, align === 'right' ? 'text-right' : 'text-left')}>
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

/** Density and tab-dimension settings for the stray-body "add tabs" fix. */
function TabDialog({
  open,
  density,
  tabLength,
  tabWidth,
  engagement,
  detected,
  detecting,
  onDensity,
  onTabLength,
  onTabWidth,
  onEngagement,
  onUseDetected,
  onApply,
  onClose,
}: {
  open: boolean
  density: string
  tabLength: string
  tabWidth: string
  engagement: string
  detected: TabDefaults | null
  detecting: boolean
  onDensity: (value: string) => void
  onTabLength: (value: string) => void
  onTabWidth: (value: string) => void
  onEngagement: (value: string) => void
  onUseDetected: () => void
  onApply: (settings: {
    density: number
    tabLength: number
    tabWidth: number
    engagement: number
  }) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const parsedDensity = Number.parseFloat(density)
  const parsedLength = Number.parseFloat(tabLength)
  const parsedWidth = Number.parseFloat(tabWidth)
  const parsedEngagement = Number.parseFloat(engagement)
  const valid =
    Number.isFinite(parsedDensity) &&
    parsedDensity >= TAB_DENSITY_MIN &&
    parsedDensity <= TAB_DENSITY_MAX &&
    Number.isFinite(parsedLength) &&
    parsedLength >= TAB_LENGTH_MIN &&
    parsedLength <= TAB_LENGTH_MAX &&
    Number.isFinite(parsedWidth) &&
    parsedWidth >= TAB_WIDTH_MIN &&
    parsedWidth <= TAB_WIDTH_MAX &&
    Number.isFinite(parsedEngagement) &&
    parsedEngagement >= TAB_ENGAGEMENT_MIN &&
    parsedEngagement <= TAB_ENGAGEMENT_MAX
  const inputClass =
    'h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring'
  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    min: number,
    max: number,
    step: string,
    unit: string,
  ) => (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={inputClass}
        />
        <span className="shrink-0 text-xs text-muted-foreground">{unit}</span>
      </div>
    </label>
  )
  return (
    <Dialog open={open} onClose={onClose} title={t('preflight.tabs.title')}>
      <div className="flex flex-col gap-4 p-5">
        <p className="text-sm text-muted-foreground">{t('preflight.tabs.hint')}</p>
        {detecting ? (
          <p className="text-xs text-muted-foreground">{t('preflight.tabs.detecting')}</p>
        ) : detected ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span>
              {t('preflight.tabs.detected', {
                length: +detected.tabLength.toFixed(2),
                width: +detected.tabWidth.toFixed(2),
                engagement: +detected.engagement.toFixed(2),
                density: +detected.density.toFixed(2),
              })}
            </span>
            <Button variant="ghost" size="sm" className="h-6" onClick={onUseDetected}>
              {t('preflight.tabs.useDetected')}
            </Button>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          {field(
            'tab-density',
            t('preflight.tabs.density'),
            density,
            onDensity,
            TAB_DENSITY_MIN,
            TAB_DENSITY_MAX,
            '0.5',
            t('preflight.tabs.densityUnit'),
          )}
          {field(
            'tab-length',
            t('preflight.tabs.length'),
            tabLength,
            onTabLength,
            TAB_LENGTH_MIN,
            TAB_LENGTH_MAX,
            '1',
            t('preflight.tabs.mm'),
          )}
          {field(
            'tab-width',
            t('preflight.tabs.width'),
            tabWidth,
            onTabWidth,
            TAB_WIDTH_MIN,
            TAB_WIDTH_MAX,
            '0.1',
            t('preflight.tabs.mm'),
          )}
          {field(
            'tab-engagement',
            t('preflight.tabs.engagement'),
            engagement,
            onEngagement,
            TAB_ENGAGEMENT_MIN,
            TAB_ENGAGEMENT_MAX,
            '0.1',
            t('preflight.tabs.mm'),
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!valid}
            onClick={() =>
              onApply({
                density: parsedDensity,
                tabLength: parsedLength,
                tabWidth: parsedWidth,
                engagement: parsedEngagement,
              })
            }
          >
            {t('common.actions.addTabs')}
          </Button>
        </div>
      </div>
    </Dialog>
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
