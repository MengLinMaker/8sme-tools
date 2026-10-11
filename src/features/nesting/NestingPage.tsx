import { strToU8, zipSync } from 'fflate'
import type { TFunction } from 'i18next'
import { Eye } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DropZone } from '@/components/DropZone'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { createOrbitBus, requestView, type ViewPreset } from '@/features/preflight/orbitSync'
import { auditEntries } from '@/lib/audit/auditJob'
import { downloadBlob } from '@/lib/download'
import { buildBarNc } from '@/lib/nesting/nc'
import {
  collectTees,
  groupTees,
  type NestResult,
  nestGroup,
  type StockLength,
  type TeeBar,
  type TeeGroup,
  type UbBar,
  ubLayouts,
} from '@/lib/nesting/nest'
import { parseDstv } from '@/lib/parsers/dstv'
import { type NcGeometry, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import type { InputBundle } from '@/lib/readInput'
import { getUb } from '@/lib/sections/ub'
import { buildCutBeamStep } from '@/lib/step/cutBeam'
import {
  buildUbBarStep,
  inspectStepBodies,
  profileToPoints,
  type StepBody,
  ubOutline,
} from '@/lib/step/occ'
import { cn } from '@/lib/utils'
import { BeamNcViewer, type BeamSlot } from './BeamNcViewer'

const PartViewer = lazy(() => import('@/features/preflight/PartViewer'))

const UNLIMITED = Number.POSITIVE_INFINITY
const COMMON_LENGTHS = [6000, 9000, 12000, 15000, 16500, 18000]

interface StockRow {
  id: string
  length: number
  count: number
}

interface ViewFile {
  name: string
  /** Nested STEP: the finished T pieces packed as separate solids (the STEP ideal). */
  bytes: Uint8Array
  /** Manufactured NC: the whole stock beam with the split + kerf cuts + real features carved. */
  manufactured: Uint8Array | null
  /** Generated Weihong .nc1 text for this beam. */
  ncText: string | null
  /** Piece spans per side along the beam, driving the NC preview + cuts tab. */
  slots: BeamSlot[]
  /** Each nested piece's real NC at its slot: the stitched NC 3D view. */
  ncItems: NcItem[]
  /** Marks with no NC file, omitted from the stitch. */
  ncMissing: string[]
  kerf: number
  stockLength: number
  beam: { profile: [number, number][]; length: number }
  bodies: number
  bodyInfo: StepBody[]
}

/** One nested piece's real NC geometry at its position along the beam. */
interface NcItem {
  mark: string
  side: 'L' | 'R'
  /** Distance from the beam start to this piece's NC origin. */
  start: number
  /** Nominal nest slot length for this piece. */
  slotLength: number
  /** The NC's own ST-header declared length, if it parsed. */
  headerLength: number | null
  geometry: NcGeometry
}

const VIEW_PRESETS: { id: ViewPreset; labelKey: string }[] = [
  { id: 'iso', labelKey: 'preflight.viewer.iso' },
  { id: 'front', labelKey: 'preflight.viewer.front' },
  { id: 'top', labelKey: 'preflight.viewer.top' },
  { id: 'side', labelKey: 'preflight.viewer.side' },
]

/** How the 3D area shows the manufactured (cut-beam) model against the nested STEP. */
type NestViewMode = 'step' | 'manufactured' | 'split' | 'overlay'

const NEST_VIEW_MODES: { id: NestViewMode; labelKey: string }[] = [
  { id: 'manufactured', labelKey: 'preflight.viewer.manufactured' },
  { id: 'step', labelKey: 'preflight.viewer.step' },
  { id: 'split', labelKey: 'preflight.viewer.sideBySide' },
  { id: 'overlay', labelKey: 'preflight.viewer.overlay' },
]

let rowSeq = 0
const newRow = (length: number, count = UNLIMITED): StockRow => ({
  id: `stock-${rowSeq++}`,
  length,
  count,
})

const SETTINGS_KEY = '8sme.nesting.settings'
interface StoredSettings {
  rows: { length: number; count: number | null }[]
  kerf: number
  leftover: number
}

function loadSettings(): StoredSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? (JSON.parse(raw) as StoredSettings) : null
  } catch {
    return null
  }
}

export function NestingPage() {
  const { t } = useTranslation()
  const [bundle, setBundle] = useState<InputBundle | null>(null)
  const [groups, setGroups] = useState<TeeGroup[] | null>(null)
  const [results, setResults] = useState<NestResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<StockRow[]>(() => {
    const stored = loadSettings()
    return stored ? stored.rows.map((row) => newRow(row.length, row.count ?? UNLIMITED)) : []
  })
  const [kerf, setKerf] = useState(() => loadSettings()?.kerf ?? 0)
  const [leftover, setLeftover] = useState(() => loadSettings()?.leftover ?? 0)
  const [exporting, setExporting] = useState<'step' | 'nc' | 'cut' | null>(null)
  const [viewing, setViewing] = useState<ViewFile | null>(null)
  const [viewBusy, setViewBusy] = useState(false)
  // Preflight principles in the nesting viewer: one orbit bus shared by both 3D panes so the
  // nested STEP and the manufactured (cut-beam) model rotate together, plus split/overlay modes
  // with the boolean red/blue diff. The manufactured pane shows a placeholder until the cut-beam
  // build lands instead of remounting viewers when it arrives.
  const [orbitBus, setOrbitBus] = useState(() => createOrbitBus())
  const [nestViewMode, setNestViewMode] = useState<NestViewMode>('split')
  const [rightTab, setRightTab] = useState<'cuts' | 'preview'>('preview')

  useEffect(() => {
    const data: StoredSettings = {
      rows: rows.map((row) => ({
        length: row.length,
        count: Number.isFinite(row.count) ? row.count : null,
      })),
      kerf,
      leftover,
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data))
    } catch {
      // ignore storage failures (private mode, quota)
    }
  }, [rows, kerf, leftover])

  const stock = (): StockLength[] =>
    rows.filter((row) => row.length > 0).map((row) => ({ length: row.length, count: row.count }))

  // Real part STEP bytes by mark, so the nested beam is assembled from real geometry.
  const stepByMark = useMemo(() => {
    const map = new Map<string, Uint8Array>()
    for (const entry of bundle?.entries ?? []) {
      const dot = entry.path.lastIndexOf('.')
      const ext = dot >= 0 ? entry.path.slice(dot + 1).toLowerCase() : ''
      if (ext !== 'stp' && ext !== 'step') continue
      const base = (entry.path.split('/').pop() ?? entry.path).replace(/\.[^.]+$/, '')
      const mark = (base.match(/^[A-Za-z]+\d+/)?.[0] ?? base).toLowerCase()
      if (!map.has(mark)) map.set(mark, entry.bytes)
    }
    return map
  }, [bundle])

  const pieceFor = (unit: { mark: string; length: number }) => ({
    mark: unit.mark,
    length: unit.length,
    bytes: stepByMark.get(unit.mark),
  })

  // Real part NC text by mark, so the stitched NC view draws each piece's true toolpaths.
  const ncTextByMark = useMemo(() => {
    const map = new Map<string, string>()
    const decoder = new TextDecoder()
    for (const entry of bundle?.entries ?? []) {
      const dot = entry.path.lastIndexOf('.')
      const ext = dot >= 0 ? entry.path.slice(dot + 1).toLowerCase() : ''
      if (ext !== 'nc1' && ext !== 'nc') continue
      const base = (entry.path.split('/').pop() ?? entry.path).replace(/\.[^.]+$/, '')
      const mark = (base.match(/^[A-Za-z]+\d+/)?.[0] ?? base).toLowerCase()
      if (!map.has(mark)) {
        try {
          map.set(mark, decoder.decode(entry.bytes))
        } catch {
          // unreadable NC — treated as missing for the stitch
        }
      }
    }
    return map
  }, [bundle])

  const handleBundle = useCallback(
    (input: InputBundle) => {
      setBundle(input)
      setResults(null)
      setError(null)
      const audit = auditEntries(input.sourceName, input.entries)
      const tees = collectTees(audit)
      if (tees.length === 0) {
        setGroups(null)
        setError(t('nesting.noTees'))
        return
      }
      const detected = groupTees(tees)
      setGroups(detected)
      setRows((current) => (current.length > 0 ? current : [newRow(12000)]))
    },
    [t],
  )

  const nest = () => {
    if (!groups) return
    setError(null)
    const inventory = stock()
    if (inventory.length === 0) {
      setError(t('nesting.addStock'))
      return
    }
    setResults(groups.map((group) => nestGroup(group, { stock: inventory, kerf, leftover })))
  }

  const updateRow = (id: string, patch: Partial<StockLength>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  const layoutStep = async (
    result: NestResult,
    layout: { ubBar: UbBar; quantity: number },
    index: number,
  ): Promise<ViewFile | null> => {
    const ub = getUb(result.parentUb)
    if (!ub) return null
    const left = layout.ubBar.teeBars[0].units.map(pieceFor)
    const right = layout.ubBar.teeBars[1].units.map(pieceFor)
    const base = `${result.parentUb}-x${layout.quantity}-${layout.ubBar.stockLength}-L${left.length}R${right.length}-bar${String(index + 1).padStart(2, '0')}`
    const name = `${base}.step`
    const grade = result.parts[0]?.grade
    // The NC text is sync and cheap — generate it up front so the right-hand tab is never empty.
    let ncText: string | null = null
    try {
      ncText = buildBarNc({
        section: ub,
        name: base,
        stockLength: layout.ubBar.stockLength,
        left,
        right,
        kerf: result.kerf,
        grade,
      })
    } catch {
      ncText = null
    }
    const content = await buildUbBarStep(
      { section: ub, name, left, right, kerf: result.kerf },
      { strict: false },
    )
    const bytes = strToU8(content)
    const bodies = (content.match(/MANIFOLD_SOLID_BREP/g) ?? []).length
    const bodyInfo = bodies === 1 ? [] : await inspectStepBodies(bytes).catch(() => [])
    // Piece spans per side, mirroring the cut-beam layout (kerf gap between neighbours) — the NC
    // preview draws these, so it is available instantly without waiting for any OCC boolean.
    const span = (units: { mark: string; length: number }[], side: 'L' | 'R'): BeamSlot[] => {
      const out: BeamSlot[] = []
      let cursor = 0
      units.forEach((unit, i) => {
        if (i > 0) cursor += result.kerf
        out.push({ side, mark: unit.mark, start: cursor, end: cursor + unit.length })
        cursor += unit.length
      })
      return out
    }
    const slots: BeamSlot[] = [
      ...span(layout.ubBar.teeBars[0].units, 'L'),
      ...span(layout.ubBar.teeBars[1].units, 'R'),
    ]
    // Stitch each piece's real NC at its slot (sync text parse — instant, no OCC involved).
    const ncItems: NcItem[] = []
    const ncMissing: string[] = []
    const seenMissing = new Set<string>()
    const noteMissing = (mark: string): void => {
      if (!seenMissing.has(mark)) {
        seenMissing.add(mark)
        ncMissing.push(mark)
      }
    }
    for (const slot of slots) {
      const text = ncTextByMark.get(slot.mark) ?? ncTextByMark.get(slot.mark.toLowerCase())
      if (!text) {
        noteMissing(slot.mark)
        continue
      }
      let geometry: NcGeometry | null = null
      try {
        geometry = parseNcGeometry(text)
      } catch {
        geometry = null
      }
      if (!geometry || (geometry.contours.length === 0 && geometry.holes.length === 0)) {
        noteMissing(slot.mark)
        continue
      }
      let headerLength: number | null = null
      try {
        const parsed = parseDstv(text).header.length
        headerLength = Number.isFinite(parsed) && parsed > 0 ? parsed : null
      } catch {
        headerLength = null
      }
      ncItems.push({
        mark: slot.mark,
        side: slot.side,
        start: slot.start,
        slotLength: slot.end - slot.start,
        headerLength,
        geometry,
      })
    }
    return {
      name,
      bytes,
      manufactured: null,
      ncText,
      slots,
      ncItems,
      ncMissing,
      kerf: result.kerf,
      stockLength: layout.ubBar.stockLength,
      beam: { profile: profileToPoints(ubOutline(ub)), length: layout.ubBar.stockLength },
      bodies,
      bodyInfo,
    }
  }

  const layoutManufacturedStep = async (
    result: NestResult,
    layout: { ubBar: UbBar; quantity: number },
    index: number,
  ): Promise<Uint8Array | null> => {
    const ub = getUb(result.parentUb)
    if (!ub) return null
    const left = layout.ubBar.teeBars[0].units.map(pieceFor)
    const right = layout.ubBar.teeBars[1].units.map(pieceFor)
    const base = `${result.parentUb}-x${layout.quantity}-${layout.ubBar.stockLength}-bar${String(index + 1).padStart(2, '0')}`
    try {
      return strToU8(
        await buildCutBeamStep({
          section: ub,
          name: base,
          stockLength: layout.ubBar.stockLength,
          left,
          right,
          kerf: result.kerf,
        }),
      )
    } catch (error) {
      // Surfaced in the dialog placeholder; logged for diagnosis (orientation skips inside the
      // carve don't throw, so anything landing here is a genuine OCC/build failure).
      // eslint-disable-next-line no-console
      console.warn('[nesting] cut-beam build failed:', error)
      return null
    }
  }

  const viewLayout = async (
    result: NestResult,
    layout: { ubBar: UbBar; quantity: number },
    index: number,
  ) => {
    setViewBusy(true)
    setError(null)
    setRightTab('preview')
    setNestViewMode('split')
    setOrbitBus(createOrbitBus())
    let file: ViewFile | null = null
    try {
      file = await layoutStep(result, layout, index)
      if (file) setViewing(file)
    } catch (err) {
      setError(t('nesting.stepFailed', { error: err instanceof Error ? err.message : String(err) }))
      setViewBusy(false)
      return
    } finally {
      if (!file) setViewBusy(false)
    }
    if (!file) return
    // The cut-beam boolean carve is the slow part — build it after the nested STEP is already
    // on screen, then patch it into the open dialog so the manufactured pane fills in.
    const expectedName = file.name
    try {
      const manufactured = await layoutManufacturedStep(result, layout, index)
      if (manufactured) {
        setViewing((current) =>
          current && current.name === expectedName ? { ...current, manufactured } : current,
        )
      }
    } finally {
      setViewBusy(false)
    }
  }

  const finishExport = (files: Record<string, Uint8Array>, name: string) => {
    if (Object.keys(files).length === 0) {
      setError(t('nesting.nothingToExport'))
      return
    }
    const zip = zipSync(files)
    downloadBlob(name, new Blob([zip], { type: 'application/zip' }))
  }

  /** One single-piece STEP per distinct stock-beam layout (imports into WiseCAM as one piece). */
  const downloadStepFiles = async () => {
    if (!results) return
    setExporting('step')
    setError(null)
    try {
      const files: Record<string, Uint8Array> = {}
      for (const result of results) {
        const ub = getUb(result.parentUb)
        if (!ub) continue
        const layouts = ubLayouts(result)
        for (let index = 0; index < layouts.length; index++) {
          const { ubBar, quantity } = layouts[index]
          const left = ubBar.teeBars[0].units.map(pieceFor)
          const right = ubBar.teeBars[1].units.map(pieceFor)
          const base = `${result.parentUb}-x${quantity}-${ubBar.stockLength}-bar${String(index + 1).padStart(2, '0')}`
          const step = await buildUbBarStep({
            section: ub,
            name: base,
            left,
            right,
            kerf: result.kerf,
          })
          files[`${base}.step`] = strToU8(step)
        }
      }
      finishExport(files, `nesting-step-${bundle?.sourceName ?? 'job'}.zip`)
    } catch (err) {
      setError(
        t('nesting.stepExportFailed', { error: err instanceof Error ? err.message : String(err) }),
      )
    } finally {
      setExporting(null)
    }
  }

  /**
   * Whole-beam STEP: the stock UB modelled as the beam the laser cuts (local lengthwise split +
   * transverse kerf cuts + each part's real features) rather than loose finished parts.
   */
  const downloadCutBeamFiles = async () => {
    if (!results) return
    setExporting('cut')
    setError(null)
    try {
      const files: Record<string, Uint8Array> = {}
      for (const result of results) {
        const ub = getUb(result.parentUb)
        if (!ub) continue
        const layouts = ubLayouts(result)
        for (let index = 0; index < layouts.length; index++) {
          const { ubBar, quantity } = layouts[index]
          const left = ubBar.teeBars[0].units.map(pieceFor)
          const right = ubBar.teeBars[1].units.map(pieceFor)
          const base = `${result.parentUb}-x${quantity}-${ubBar.stockLength}-bar${String(index + 1).padStart(2, '0')}`
          const step = await buildCutBeamStep({
            section: ub,
            name: base,
            stockLength: ubBar.stockLength,
            left,
            right,
            kerf: result.kerf,
          })
          files[`${base}.step`] = strToU8(step)
        }
      }
      finishExport(files, `nesting-cutbeam-${bundle?.sourceName ?? 'job'}.zip`)
    } catch (err) {
      setError(
        t('nesting.cutBeamExportFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    } finally {
      setExporting(null)
    }
  }

  /** Experimental Weihong .nc1 per stock beam — opt-in, kept separate from the STEP. */
  const downloadNcFiles = async () => {
    if (!results) return
    setExporting('nc')
    setError(null)
    try {
      const files: Record<string, Uint8Array> = {}
      for (const result of results) {
        const ub = getUb(result.parentUb)
        if (!ub) continue
        const grade = result.parts[0]?.grade
        const layouts = ubLayouts(result)
        for (let index = 0; index < layouts.length; index++) {
          const { ubBar, quantity } = layouts[index]
          const left = ubBar.teeBars[0].units.map(pieceFor)
          const right = ubBar.teeBars[1].units.map(pieceFor)
          const base = `${result.parentUb}-x${quantity}-${ubBar.stockLength}-bar${String(index + 1).padStart(2, '0')}`
          files[`${base}.nc1`] = strToU8(
            buildBarNc({
              section: ub,
              name: base,
              stockLength: ubBar.stockLength,
              left,
              right,
              kerf: result.kerf,
              grade,
            }),
          )
        }
      }
      finishExport(files, `nesting-nc-${bundle?.sourceName ?? 'job'}.zip`)
    } catch (err) {
      setError(
        t('nesting.ncExportFailed', { error: err instanceof Error ? err.message : String(err) }),
      )
    } finally {
      setExporting(null)
    }
  }

  const totalUb = results?.reduce((sum, r) => sum + r.ubCount, 0) ?? 0
  const totalTeeBars = results?.reduce((sum, r) => sum + r.teeBarCount, 0) ?? 0
  const totalLayouts = results?.reduce((sum, r) => sum + ubLayouts(r).length, 0) ?? 0

  // Preflight-style effective mode: the split layout renders straight away — the manufactured
  // pane shows a placeholder until the cut-beam build lands — instead of collapsing to a single
  // STEP view and remounting both viewers when it arrives. If the cut-beam build failed, fall
  // back to the STEP view (the mode buttons stay visible but manufactured-dependent modes disable).
  const hasManufactured = Boolean(viewing?.manufactured)
  const hasStep = Boolean(viewing?.bytes)
  const mfgFailed = Boolean(viewing && !viewing.manufactured && !viewBusy)
  const effectiveMode: NestViewMode = mfgFailed ? 'step' : nestViewMode
  const mfgPaneActive =
    effectiveMode === 'split' || effectiveMode === 'manufactured' || effectiveMode === 'overlay'
  const stepPaneActive = effectiveMode === 'step' || effectiveMode === 'split'
  const showMfgPane = Boolean(viewing) && mfgPaneActive && (hasManufactured || viewBusy)
  const showStepPane = Boolean(viewing) && stepPaneActive && hasStep
  const twoPane = showMfgPane && showStepPane
  const ncCuts = viewing?.ncText ? parseBeamNcCuts(viewing.ncText) : []
  // Every nested piece's NC, shifted to its slot along the beam, so the manufactured cut-beam
  // view can project each piece's toolpath onto the part the laser actually cuts.
  const beamNc = useMemo<NcGeometry | null>(() => {
    if (!viewing) return null
    const contours: NcGeometry['contours'] = []
    const holes: NcGeometry['holes'] = []
    for (const item of viewing.ncItems) {
      for (const contour of item.geometry.contours) {
        contours.push({
          ...contour,
          points: contour.points.map(([x, y]) => [x + item.start, y] as [number, number]),
        })
      }
      for (const hole of item.geometry.holes) holes.push({ ...hole, x: hole.x + item.start })
    }
    return contours.length > 0 || holes.length > 0 ? { contours, holes } : null
  }, [viewing])

  return (
    <div className="flex flex-col gap-6">
      <section className="max-w-2xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">{t('nesting.title')}</h1>
        <p className="text-muted-foreground">{t('nesting.subtitle')}</p>
      </section>

      <DropZone onBundle={handleBundle} onError={setError} />

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 px-3.5 py-3 text-sm text-destructive-foreground">
          {error}
        </div>
      )}

      {groups && (
        <Card>
          <CardHeader>
            <CardTitle>{t('nesting.detectedTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              {groups.map((group) => {
                const ub = getUb(group.parentUb)
                return (
                  <div
                    key={group.parentUb}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <span className="font-semibold">{group.parentUb}</span>
                    {ub && <Badge variant="muted">{ub.mass} kg/m</Badge>}
                    <span className="text-sm text-muted-foreground">
                      {ub
                        ? t('nesting.teeDetailSection', {
                            count: group.teeCount,
                            length: Math.round(group.totalLength),
                            d: ub.d,
                            b: ub.b,
                            tee: (ub.mass / 2).toFixed(1),
                          })
                        : t('nesting.teeDetail', {
                            count: group.teeCount,
                            length: Math.round(group.totalLength),
                          })}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <span className="text-sm font-medium">{t('nesting.stockTitle')}</span>
              <div className="flex flex-wrap gap-2">
                {COMMON_LENGTHS.map((length) => (
                  <Button
                    key={length}
                    variant="outline"
                    size="sm"
                    onClick={() => setRows((current) => [...current, newRow(length)])}
                  >
                    + {length / 1000} m
                  </Button>
                ))}
              </div>
              {rows.map((row) => (
                <div key={row.id} className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">{t('nesting.lengthLabel')}</span>
                    <input
                      type="number"
                      min={1}
                      value={row.length || ''}
                      onChange={(event) =>
                        updateRow(row.id, { length: Number(event.target.value) || 0 })
                      }
                      className="h-9 w-36 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">{t('nesting.qtyLabel')}</span>
                    <input
                      type="number"
                      min={0}
                      placeholder="∞"
                      value={Number.isFinite(row.count) ? row.count : ''}
                      onChange={(event) =>
                        updateRow(row.id, {
                          count:
                            event.target.value.trim() === ''
                              ? UNLIMITED
                              : Number(event.target.value),
                        })
                      }
                      className="h-9 w-40 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRows((current) => current.filter((r) => r.id !== row.id))}
                  >
                    {t('common.actions.remove')}
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t('nesting.leftoverLabel')}</span>
                  <input
                    type="number"
                    min={0}
                    value={leftover}
                    onChange={(event) => setLeftover(Number(event.target.value) || 0)}
                    className="h-9 w-40 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t('nesting.kerfLabel')}</span>
                  <input
                    type="number"
                    min={0}
                    value={kerf}
                    onChange={(event) => setKerf(Number(event.target.value) || 0)}
                    className="h-9 w-28 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <Button onClick={nest}>{t('nesting.nest')}</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {results && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label={t('nesting.stats.ubGroups')} value={results.length} />
            <Stat label={t('nesting.stats.beamLayouts')} value={totalLayouts} />
            <Stat label={t('nesting.stats.stockUbs')} value={totalUb} />
            <Stat label={t('nesting.stats.tBars')} value={totalTeeBars} />
            <Stat
              label={t('nesting.stats.utilisation')}
              value={`${Math.round(
                (results.reduce((sum, r) => sum + r.utilisation, 0) / Math.max(1, results.length)) *
                  100,
              )}%`}
            />
          </section>

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              onClick={() => void downloadStepFiles()}
              disabled={exporting !== null}
            >
              {exporting === 'step' ? t('nesting.generating') : t('nesting.downloadStep')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void downloadCutBeamFiles()}
              disabled={exporting !== null}
            >
              {exporting === 'cut' ? t('nesting.generating') : t('nesting.downloadCutBeam')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void downloadNcFiles()}
              disabled={exporting !== null}
            >
              {exporting === 'nc' ? t('nesting.generating') : t('nesting.downloadNc')}
            </Button>
          </div>

          {results.map((result) => (
            <Card key={result.parentUb}>
              <CardHeader className="gap-1.5">
                <div className="flex flex-wrap items-center gap-3">
                  <CardTitle>{result.parentUb}</CardTitle>
                  <Badge variant="muted">{t('nesting.kgPerMUb', { mass: result.mass })}</Badge>
                  <Badge variant="secondary">
                    {t('nesting.ubsCount', {
                      ubCount: result.ubCount,
                      teeBarCount: result.teeBarCount,
                    })}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{sectionDetail(t, result.parentUb)}</p>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {result.oversized.length > 0 && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                    {t('nesting.oversized', {
                      count: result.oversized.length,
                      lengths: result.oversized.map((u) => Math.round(u.length)).join(', '),
                    })}
                  </div>
                )}
                {ubLayouts(result).map((layout, index) => (
                  <UbDiagram
                    key={
                      layout.ubBar.teeBars[0].units[0]?.id ?? layout.ubBar.teeBars[1].units[0]?.id
                    }
                    ub={layout.ubBar}
                    quantity={layout.quantity}
                    index={index}
                    onView={() => void viewLayout(result, layout, index)}
                    viewBusy={viewBusy}
                  />
                ))}
              </CardContent>
            </Card>
          ))}

          <p className="text-sm text-muted-foreground">{t('nesting.stepNote')}</p>
        </>
      )}

      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing ? t('nesting.dialogTitle', { name: viewing.name }) : undefined}
        className="h-[90vh] max-w-[96vw]"
      >
        {viewing && (
          <div className="flex h-full flex-col">
            {viewing.bodies !== 1 && (
              <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                <div className="font-medium">
                  {t('nesting.bodiesNote', { count: viewing.bodies })}
                </div>
                {viewing.bodyInfo.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 font-mono">
                    {[...viewing.bodyInfo]
                      .sort(
                        (a, b) =>
                          a.size[0] * a.size[1] * a.size[2] - b.size[0] * b.size[1] * b.size[2],
                      )
                      .slice(0, 8)
                      .map((body) => (
                        <li key={`${body.center.join(',')}`}>
                          {body.size.map((v) => Math.round(v)).join(' × ')} mm @ z=
                          {Math.round(body.center[2])}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="relative min-h-72 w-full flex-1 bg-[#0b0f14]">
                <Suspense
                  fallback={
                    <div className="grid h-full place-items-center text-sm text-muted-foreground">
                      {t('nesting.loadingViewer')}
                    </div>
                  }
                >
                  <div className={cn('grid h-full', twoPane ? 'grid-cols-2' : 'grid-cols-1')}>
                    <div className={cn('relative h-full', showMfgPane ? '' : 'hidden')}>
                      {viewing.manufactured ? (
                        <PartViewer
                          name={`${viewing.name} · manufactured`}
                          bytes={viewing.manufactured}
                          compareBytes={
                            effectiveMode === 'overlay' ? (viewing.bytes ?? null) : null
                          }
                          compareLabel={t('preflight.viewer.step')}
                          stock={null}
                          // Same profile as the STEP pane: seating (length → X + roll) must match
                          // or split/overlay compare misaligned models. The ghost doubles as the
                          // uncut-stock outline, showing what the split + kerfs removed.
                          beam={viewing.beam}
                          bus={orbitBus}
                          nc={beamNc}
                          smoothLines
                        />
                      ) : (
                        <div className="grid h-full place-items-center px-6 text-center">
                          <p className="max-w-sm text-sm text-muted-foreground">
                            {mfgFailed
                              ? t('nesting.viewer.manufacturedFailed')
                              : t('nesting.viewer.buildingManufactured')}
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
                      <PartViewer
                        name={viewing.name}
                        bytes={viewing.bytes}
                        stock={null}
                        beam={viewing.beam}
                        bus={orbitBus}
                      />
                      {twoPane && <PaneTag tone="step">{t('preflight.viewer.step')}</PaneTag>}
                    </div>
                    {!showMfgPane && !showStepPane && (
                      <div className="grid h-full place-items-center px-6 text-center">
                        <p className="max-w-sm text-sm text-muted-foreground">
                          {t('nesting.loadingViewer')}
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
                {/* Always visible (unlike the first cut): manufactured / split / overlay disable
                    until the cut-beam build lands, so the Overlay option is discoverable while it
                    builds instead of appearing out of nowhere. */}
                <div className="absolute bottom-3 left-3 z-10 flex gap-1 rounded-md border border-border bg-card/80 p-1 backdrop-blur">
                  {NEST_VIEW_MODES.map((mode) => {
                    const needsMfg =
                      mode.id === 'manufactured' || mode.id === 'split' || mode.id === 'overlay'
                    const disabled =
                      (mode.id === 'step' && !hasStep) ||
                      (needsMfg && (!hasManufactured || !hasStep))
                    const title =
                      needsMfg && !hasManufactured
                        ? mfgFailed
                          ? t('nesting.viewer.manufacturedFailed')
                          : t('nesting.viewer.buildingManufactured')
                        : undefined
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        disabled={disabled}
                        title={title}
                        onClick={() => setNestViewMode(mode.id)}
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
              </div>
              <div className="flex h-[40vh] w-full shrink-0 flex-col border-t border-border">
                <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
                  {[
                    { id: 'preview' as const, labelKey: 'nesting.viewer.previewTab' },
                    { id: 'cuts' as const, labelKey: 'nesting.viewer.cutsTab' },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setRightTab(tab.id)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                        rightTab === tab.id
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(tab.labelKey)}
                    </button>
                  ))}
                  {viewing.ncText && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      onClick={() =>
                        downloadBlob(
                          viewing.name.replace(/\.step$/, '.nc1'),
                          new Blob([viewing.ncText ?? ''], { type: 'text/plain' }),
                        )
                      }
                    >
                      {t('nesting.viewer.downloadNc')}
                    </Button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {rightTab === 'preview' ? (
                    <div className="h-full min-h-64">
                      <BeamNcViewer
                        profile={viewing.beam.profile}
                        stockLength={viewing.stockLength}
                        slots={viewing.slots}
                        kerf={viewing.kerf}
                        bus={orbitBus}
                      />
                    </div>
                  ) : ncCuts.length === 0 ? (
                    <div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
                      {t('nesting.viewer.ncEmpty')}
                    </div>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card">
                        <tr className="text-left text-muted-foreground">
                          <th className="px-4 py-2 font-medium">{t('nesting.viewer.side')}</th>
                          <th className="px-2 py-2 font-medium">{t('nesting.viewer.mark')}</th>
                          <th className="px-2 py-2 text-right font-medium">
                            {t('nesting.viewer.cutAt')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {ncCuts.map((cut) => (
                          <tr
                            key={`${cut.side}-${cut.end.toFixed(2)}-${cut.mark}`}
                            className="border-t border-border"
                          >
                            <td className="px-4 py-1.5 text-muted-foreground">
                              {cut.side === 'L' ? t('nesting.left') : t('nesting.right')}
                            </td>
                            <td className="px-2 py-1.5 font-mono">{cut.mark}</td>
                            <td className="px-2 py-1.5 text-right font-mono">
                              {cut.end.toFixed(0)} mm
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                  {t('nesting.viewer.diffHint')}
                </div>
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}

function UbDiagram({
  ub,
  quantity,
  index,
  onView,
  viewBusy,
}: {
  ub: UbBar
  quantity: number
  index: number
  onView: () => void
  viewBusy: boolean
}) {
  const { t } = useTranslation()
  const counts = new Map<string, number>()
  for (const bar of ub.teeBars) {
    for (const unit of bar.units) counts.set(unit.mark, (counts.get(unit.mark) ?? 0) + 1)
  }
  const summary = [...counts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { numeric: true }),
  )
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{t('nesting.ubLabel', { index: index + 1, length: ub.stockLength })}</span>
        <Badge variant="default">×{quantity}</Badge>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onView} disabled={viewBusy}>
          <Eye />
          {t('common.actions.view')}
        </Button>
      </div>
      <TeeBarRow label={t('nesting.left')} bar={ub.teeBars[0]} />
      <TeeBarRow label={t('nesting.right')} bar={ub.teeBars[1]} />
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 pl-12 text-[10px] text-muted-foreground">
        {summary.map(([mark, count]) => (
          <span key={mark}>
            {mark} ×{count}
          </span>
        ))}
      </div>
    </div>
  )
}

function TeeBarRow({ label, bar }: { label: string; bar: TeeBar }) {
  const { t } = useTranslation()
  const wastePct = (bar.waste / bar.stockLength) * 100
  const reservedPct = (bar.reserved / bar.stockLength) * 100
  const freePct = Math.max(0, wastePct - reservedPct)
  const free = bar.waste - bar.reserved
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-right text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex h-7 flex-1 overflow-hidden rounded border border-border">
        {bar.units.map((unit) => (
          <div
            key={unit.id}
            title={`${unit.mark} · ${unit.length} mm`}
            style={{ width: `${(unit.length / bar.stockLength) * 100}%` }}
            className="flex items-center justify-center overflow-hidden border-r border-border bg-primary/25"
          >
            <span className="flex flex-col items-center leading-none">
              <span className="truncate px-0.5 text-[9px] font-medium">{unit.mark}</span>
              <span className="px-0.5 text-[8px] text-muted-foreground">
                {Math.round(unit.length)}
              </span>
            </span>
          </div>
        ))}
        {bar.reserved > 0 && (
          <div
            title={t('nesting.trimTitle', { value: bar.reserved })}
            style={{ width: `${reservedPct}%` }}
            className="border-r border-border bg-amber-500/30"
          />
        )}
        <div
          style={{ width: `${freePct}%` }}
          className="flex items-center justify-center bg-muted/40 text-[10px] text-muted-foreground"
        >
          {free > 200 ? Math.round(free) : ''}
        </div>
      </div>
      <span className="w-20 shrink-0 text-right text-[10px] text-muted-foreground">
        {t('nesting.waste', { value: Math.round(bar.waste) })}
      </span>
    </div>
  )
}

/** One transverse cut from the generated beam NC (`L/R end mark` lines under `AK`). */
interface BeamCut {
  side: 'L' | 'R'
  mark: string
  end: number
}

/** Parses the cut list out of a generated beam `.nc1` for the cuts tab. */
function parseBeamNcCuts(ncText: string): BeamCut[] {
  const cuts: BeamCut[] = []
  let inAk = false
  for (const raw of ncText.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === 'AK') {
      inAk = true
      continue
    }
    if (line === 'EN') break
    if (!inAk) continue
    const match = /^[LR]\s+(-?\d+(?:\.\d+)?)\s+(.+)$/.exec(line)
    if (!match) continue
    cuts.push({
      side: line[0] as 'L' | 'R',
      end: Number(match[1]),
      mark: match[2].trim(),
    })
  }
  return cuts.filter((cut) => Number.isFinite(cut.end))
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

function sectionDetail(t: TFunction, designation: string): string {
  const ub = getUb(designation)
  if (!ub) return ''
  return t('nesting.parentUb', {
    d: ub.d,
    b: ub.b,
    tf: ub.tf,
    tw: ub.tw,
    tee: (ub.mass / 2).toFixed(1),
  })
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-card px-3.5 py-3">
      <span className="text-2xl font-bold tracking-tight">{value}</span>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  )
}
