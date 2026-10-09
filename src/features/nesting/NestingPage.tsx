import { strToU8, zipSync } from 'fflate'
import { Eye } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { DropZone } from '@/components/DropZone'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { auditEntries } from '@/lib/audit/auditJob'
import { downloadBlob, downloadText } from '@/lib/download'
import {
  collectTees,
  groupTees,
  type NestResult,
  nestGroup,
  nestingToCsv,
  type StockLength,
  type TeeBar,
  type TeeGroup,
  type UbBar,
  ubLayouts,
} from '@/lib/nesting/nest'
import type { InputBundle } from '@/lib/readInput'
import { getUb } from '@/lib/sections/ub'
import { buildUbBarStep, ubOutline } from '@/lib/step/occ'

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
  bytes: Uint8Array
  beam: { profile: [number, number][]; length: number }
}

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
  minSeparation: number
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
  const [minSep, setMinSep] = useState(() => loadSettings()?.minSeparation ?? 10)
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<ViewFile | null>(null)
  const [viewBusy, setViewBusy] = useState(false)

  useEffect(() => {
    const data: StoredSettings = {
      rows: rows.map((row) => ({
        length: row.length,
        count: Number.isFinite(row.count) ? row.count : null,
      })),
      kerf,
      leftover,
      minSeparation: minSep,
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data))
    } catch {
      // ignore storage failures (private mode, quota)
    }
  }, [rows, kerf, leftover, minSep])

  const stock = (): StockLength[] =>
    rows.filter((row) => row.length > 0).map((row) => ({ length: row.length, count: row.count }))

  const handleBundle = useCallback((input: InputBundle) => {
    setBundle(input)
    setResults(null)
    setError(null)
    const audit = auditEntries(input.sourceName, input.entries)
    const tees = collectTees(audit)
    if (tees.length === 0) {
      setGroups(null)
      setError('No T-sections (halved-UB parts) were found in this job.')
      return
    }
    const detected = groupTees(tees)
    setGroups(detected)
    setRows((current) => (current.length > 0 ? current : [newRow(12000)]))
  }, [])

  const nest = () => {
    if (!groups) return
    setError(null)
    const inventory = stock()
    if (inventory.length === 0) {
      setError('Add at least one stock length.')
      return
    }
    setResults(
      groups.map((group) =>
        nestGroup(group, { stock: inventory, kerf, leftover, minSeparation: minSep }),
      ),
    )
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
    const left = layout.ubBar.teeBars[0].units.map((unit) => unit.length)
    const right = layout.ubBar.teeBars[1].units.map((unit) => unit.length)
    const name = `${result.parentUb}-x${layout.quantity}-${layout.ubBar.stockLength}-L${left.length}R${right.length}-bar${String(index + 1).padStart(2, '0')}.step`
    const content = await buildUbBarStep({ section: ub, name, left, right, kerf: result.kerf })
    return {
      name,
      bytes: strToU8(content),
      beam: { profile: ubOutline(ub), length: layout.ubBar.stockLength },
    }
  }

  const viewLayout = async (
    result: NestResult,
    layout: { ubBar: UbBar; quantity: number },
    index: number,
  ) => {
    setViewBusy(true)
    setError(null)
    try {
      const file = await layoutStep(result, layout, index)
      if (file) setViewing(file)
    } catch (err) {
      setError(`STEP generation failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setViewBusy(false)
    }
  }

  const downloadStep = async () => {
    if (!results) return
    setBusy(true)
    setError(null)
    try {
      const files: Record<string, Uint8Array> = {}
      for (const result of results) {
        const layouts = ubLayouts(result)
        for (let index = 0; index < layouts.length; index++) {
          const file = await layoutStep(result, layouts[index], index)
          if (file) files[file.name] = file.bytes
        }
      }
      if (Object.keys(files).length === 0) {
        setError('Nothing to export.')
        return
      }
      const zip = zipSync(files)
      downloadBlob(
        `step-${bundle?.sourceName ?? 'job'}.zip`,
        new Blob([zip], { type: 'application/zip' }),
      )
    } catch (err) {
      setError(`STEP generation failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const totalUb = results?.reduce((sum, r) => sum + r.ubCount, 0) ?? 0
  const cutConflicts = results?.flatMap((r) => r.cutConflicts) ?? []
  const totalTeeBars = results?.reduce((sum, r) => sum + r.teeBarCount, 0) ?? 0
  const totalLayouts = results?.reduce((sum, r) => sum + ubLayouts(r).length, 0) ?? 0

  return (
    <div className="flex flex-col gap-6">
      <section className="max-w-2xl">
        <h1 className="mb-1.5 text-2xl font-bold tracking-tight">T Nesting</h1>
        <p className="text-muted-foreground">
          Each stock UB is split lengthwise into two independent T bars (left & right) and each is
          nested separately — so no material is wasted pairing T’s. Shorter pieces go to the front.
          Identical beams are grouped with a quantity.
        </p>
      </section>

      <DropZone
        onBundle={handleBundle}
        onError={setError}
        title="Drop the job .zip, files, or a folder"
      />

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 px-3.5 py-3 text-sm text-destructive-foreground">
          {error}
        </div>
      )}

      {groups && (
        <Card>
          <CardHeader>
            <CardTitle>Detected T sections</CardTitle>
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
                      {group.teeCount} T’s · {Math.round(group.totalLength)} mm
                      {ub ? ` · ${ub.d}×${ub.b} mm · tee ≈ ${(ub.mass / 2).toFixed(1)} kg/m` : ''}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <span className="text-sm font-medium">Stock inventory</span>
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
                    <span className="text-muted-foreground">Length (mm)</span>
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
                    <span className="text-muted-foreground">Qty (blank = unlimited)</span>
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
                    Remove
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">Leftover / trim (mm)</span>
                  <input
                    type="number"
                    min={0}
                    value={leftover}
                    onChange={(event) => setLeftover(Number(event.target.value) || 0)}
                    className="h-9 w-40 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">Kerf (mm)</span>
                  <input
                    type="number"
                    min={0}
                    value={kerf}
                    onChange={(event) => setKerf(Number(event.target.value) || 0)}
                    className="h-9 w-28 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">Min cut separation (mm)</span>
                  <input
                    type="number"
                    min={0}
                    value={minSep}
                    onChange={(event) => setMinSep(Number(event.target.value) || 0)}
                    className="h-9 w-44 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <Button onClick={nest}>Nest</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {results && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="UB groups" value={results.length} />
            <Stat label="Beam layouts" value={totalLayouts} />
            <Stat label="Stock UBs" value={totalUb} />
            <Stat label="T bars" value={totalTeeBars} />
            <Stat
              label="Utilisation"
              value={`${Math.round(
                (results.reduce((sum, r) => sum + r.utilisation, 0) / Math.max(1, results.length)) *
                  100,
              )}%`}
            />
          </section>

          {cutConflicts.length > 0 && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-3 text-sm text-destructive-foreground">
              <div className="font-medium">
                Cut collision — {cutConflicts.length} cut(s) land on the same or a near line:
              </div>
              <ul className="mt-1 list-disc pl-5">
                {cutConflicts.slice(0, 12).map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={() => void downloadStep()} disabled={busy}>
              {busy ? 'Generating STEP…' : 'Download STEP (.zip)'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                downloadText(`nesting-${bundle?.sourceName ?? 'job'}.csv`, nestingToCsv(results))
              }
            >
              Download cut list (CSV)
            </Button>
          </div>

          {results.map((result) => (
            <Card key={result.parentUb}>
              <CardHeader className="gap-1.5">
                <div className="flex flex-wrap items-center gap-3">
                  <CardTitle>{result.parentUb}</CardTitle>
                  <Badge variant="muted">{result.mass} kg/m UB</Badge>
                  <Badge variant="secondary">
                    {result.ubCount} UBs · {result.teeBarCount} T-bars
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{sectionDetail(result.parentUb)}</p>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {result.oversized.length > 0 && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                    {result.oversized.length} T(s) could not be placed (too long or stock
                    exhausted): {result.oversized.map((u) => Math.round(u.length)).join(', ')} mm
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

          <p className="text-sm text-muted-foreground">
            STEP: one file per distinct layout (AP214) — the UB split into left/right T bars with
            every T part visible. CSV: the cut list per beam and side.
          </p>
        </>
      )}

      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing ? `${viewing.name} · 3D view` : undefined}
        className="max-w-4xl"
      >
        {viewing && (
          <div className="relative h-[58vh] min-h-72 w-full bg-[#0b0f14]">
            <Suspense
              fallback={
                <div className="grid h-full place-items-center text-sm text-muted-foreground">
                  Loading viewer…
                </div>
              }
            >
              <PartViewer
                name={viewing.name}
                bytes={viewing.bytes}
                stock={null}
                beam={viewing.beam}
              />
            </Suspense>
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
        <span>
          UB {index + 1} · {ub.stockLength} mm
        </span>
        <Badge variant="default">×{quantity}</Badge>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onView} disabled={viewBusy}>
          <Eye />
          View
        </Button>
      </div>
      <TeeBarRow label="Left" bar={ub.teeBars[0]} />
      <TeeBarRow label="Right" bar={ub.teeBars[1]} />
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
            title={`leftover / trim ${bar.reserved} mm`}
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
        waste {Math.round(bar.waste)}
      </span>
    </div>
  )
}

function sectionDetail(designation: string): string {
  const ub = getUb(designation)
  if (!ub) return ''
  return `Parent UB ${ub.d}×${ub.b} mm · tf ${ub.tf} · tw ${ub.tw} · tee ≈ ${(ub.mass / 2).toFixed(1)} kg/m`
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-card px-3.5 py-3">
      <span className="text-2xl font-bold tracking-tight">{value}</span>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  )
}
