/**
 * Purchase-length calculator for the preflight Profiles table.
 *
 * The operator wants to know which standard Australian beam lengths to buy so the job's pieces
 * nest with the least offcut. A T profile is bought as its parent UB (one beam yields two T
 * bars), and every bar keeps a margin for the chuck / end trim / cutting error.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { downloadText, fileStem } from '@/lib/download'
import { MACHINE } from '@/lib/machine/profile'
import {
  AU_STOCK_LENGTHS_MM,
  DEFAULT_CHUCK_MARGIN_MM,
  DEFAULT_ONE_PERSON_KG,
  DEFAULT_STOCK_LENGTHS_MM,
  DEFAULT_TWO_PERSON_KG,
  type PurchaseBar,
  type PurchaseGroupInput,
  type PurchasePlan,
  planPurchases,
  REUSABLE_OFFCUT_MM,
  totalCapacityMm,
  usableStockLengthMm,
} from '@/lib/purchasing/purchase'
import { cn } from '@/lib/utils'

const MACHINE_MAX_MM = MACHINE.envelope.maxLengthMm

const MARGIN_PRESETS = [100, 150, 200]

function metres(mm: number, digits = 1): string {
  return `${(mm / 1000).toFixed(digits)} m`
}

function kilograms(kg: number | null, digits = 1): string {
  return kg == null ? '—' : `${kg.toFixed(digits)} kg`
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function splitStock(stock: string): { family: string; size: string } {
  const clean = stock.trim().replace(/\s+/g, '')
  if (!clean || clean === '—') return { family: '—', size: stock }

  const numeric = clean.match(/^(\d+(?:\.\d+)?)(UB|WB|WC|UC|TFB)(.*)$/i)
  if (numeric) {
    const suffix = numeric[3].replace(/^\*/, '')
    return {
      family: numeric[2].toUpperCase(),
      size: suffix ? `${numeric[1]} (${suffix})` : numeric[1],
    }
  }

  const numericChannel = clean.match(/^(\d+(?:\.\d+)?)(PFC|TFC)(.*)$/i)
  if (numericChannel) {
    const suffix = numericChannel[3].replace(/^\*/, '')
    return {
      family: numericChannel[2].toUpperCase(),
      size: suffix ? `${numericChannel[1]}*${suffix}` : numericChannel[1],
    }
  }

  const prefix = clean.match(
    /^(RHS|SHS|CHS|PFC|TFC|BT|EA|UA|RA|TFB|UC|WB|WC|UB|FLT|PLT|ROD|PIPE)(.*)$/i,
  )
  if (prefix) {
    const size = prefix[2].replace(/^\*/, '')
    return { family: prefix[1].toUpperCase(), size: size || clean }
  }

  return { family: 'Other', size: stock }
}

interface BuySizeGroup {
  size: string
  tee: boolean
  rows: BuyRow[]
}

interface BuyFamilyGroup {
  family: string
  sizes: BuySizeGroup[]
}

function groupBuyRows(rows: BuyRow[]): BuyFamilyGroup[] {
  const families = new Map<string, Map<string, BuySizeGroup>>()
  for (const row of rows) {
    const { family, size } = splitStock(row.stock)
    let sizes = families.get(family)
    if (!sizes) {
      sizes = new Map()
      families.set(family, sizes)
    }
    let group = sizes.get(size)
    if (!group) {
      group = { size, tee: row.tee, rows: [] }
      sizes.set(size, group)
    }
    group.rows.push(row)
    group.tee ||= row.tee
  }

  return [...families.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, sizes]) => ({
      family,
      sizes: [...sizes.values()]
        .sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }))
        .map((group) => ({
          ...group,
          rows: [...group.rows].sort((a, b) => a.lengthMm - b.lengthMm),
        })),
    }))
}

function keyed<T>(items: readonly T[], base: (item: T) => string): { id: string; item: T }[] {
  const counts = new Map<string, number>()
  return items.map((item) => {
    const key = base(item)
    const count = counts.get(key) ?? 0
    counts.set(key, count + 1)
    return { id: `${key}#${count}`, item }
  })
}

export interface PurchaseDialogProps {
  open: boolean
  onClose: () => void
  groups: PurchaseGroupInput[]
  jobName?: string
}

interface BuyRow {
  stock: string
  lengthMm: number
  count: number
  tee: boolean
}

export function PurchaseDialog({ open, onClose, groups, jobName }: PurchaseDialogProps) {
  const { t } = useTranslation()
  const [marginMm, setMarginMm] = useState(DEFAULT_CHUCK_MARGIN_MM)
  const [stockLengthsMm, setStockLengthsMm] = useState<number[]>([...DEFAULT_STOCK_LENGTHS_MM])
  const [onePersonKg, setOnePersonKg] = useState(DEFAULT_ONE_PERSON_KG)
  const [twoPersonKg, setTwoPersonKg] = useState(DEFAULT_TWO_PERSON_KG)
  const [view, setView] = useState<'buy' | 'optimise'>('buy')
  const [showNesting, setShowNesting] = useState(false)

  const plans = useMemo(
    () =>
      stockLengthsMm.length === 0
        ? []
        : planPurchases(groups, {
            stockLengthsMm,
            marginMm: Math.max(0, marginMm),
            onePersonKg,
            twoPersonKg,
          }),
    [groups, marginMm, onePersonKg, stockLengthsMm, twoPersonKg],
  )

  const buyable = plans.filter((plan) => plan.pieceCount > 0)
  const capacity = totalCapacityMm(plans)
  const totalPurchasedKg = plans.every((plan) => plan.purchasedKg != null)
    ? plans.reduce((sum, plan) => sum + (plan.purchasedKg ?? 0), 0)
    : null
  const totalWasteKg = plans.every((plan) => plan.wasteKg != null)
    ? plans.reduce((sum, plan) => sum + (plan.wasteKg ?? 0), 0)
    : null
  const totalBinWasteKg = plans.every((plan) => plan.binWasteKg != null)
    ? plans.reduce((sum, plan) => sum + (plan.binWasteKg ?? 0), 0)
    : null
  const totalCarryOne = plans.every((plan) => plan.carryOnePieces != null)
    ? plans.reduce((sum, plan) => sum + (plan.carryOnePieces ?? 0), 0)
    : null
  const totalCarryTwo = plans.every((plan) => plan.carryTwoPieces != null)
    ? plans.reduce((sum, plan) => sum + (plan.carryTwoPieces ?? 0), 0)
    : null
  const totalOverTwo = plans.every((plan) => plan.overTwoPieces != null)
    ? plans.reduce((sum, plan) => sum + (plan.overTwoPieces ?? 0), 0)
    : null
  const invalidSupportBars = plans.reduce((sum, plan) => sum + plan.invalidSupportBars, 0)
  const totalLoadingOne = plans.reduce((sum, plan) => sum + plan.loadingOnePersonMoves, 0)
  const totalLoadingTwo = plans.reduce((sum, plan) => sum + plan.loadingTwoPersonMoves, 0)
  const totalLoadingEquipment = plans.reduce((sum, plan) => sum + plan.loadingEquipmentMoves, 0)
  const oversized = plans.flatMap((plan) => plan.oversized)
  const coveredMm = Math.max(
    0,
    plans.reduce((sum, plan) => sum + plan.requiredMm, 0) -
      oversized.reduce((sum, unit) => sum + unit.lengthMm, 0),
  )
  const overall = capacity > 0 ? coveredMm / capacity : 0
  const oversizedCount = oversized.length
  const machineTooLong = groups.reduce(
    (sum, group) =>
      sum +
      group.pieces.reduce(
        (count, piece) => count + (piece.lengthMm > MACHINE_MAX_MM ? piece.quantity : 0),
        0,
      ),
    0,
  )
  const preCutSelected = stockLengthsMm.some((length) => length > MACHINE_MAX_MM)
  const preCutPurchased = plans.some((plan) =>
    plan.purchases.some((item) => item.lengthMm > MACHINE_MAX_MM),
  )
  const buyRows = useMemo(() => {
    const map = new Map<string, BuyRow>()
    for (const plan of plans) {
      if (plan.pieceCount === 0) continue
      for (const item of plan.purchases) {
        const key = `${plan.tee ? 't' : 'l'}|${plan.stock}|${item.lengthMm}`
        const row = map.get(key)
        if (row) row.count += item.count
        else
          map.set(key, {
            stock: plan.stock,
            lengthMm: item.lengthMm,
            count: item.count,
            tee: plan.tee,
          })
      }
    }
    return [...map.values()].sort(
      (a, b) => a.stock.localeCompare(b.stock) || a.lengthMm - b.lengthMm,
    )
  }, [plans])

  const toggleStock = (length: number) => {
    setStockLengthsMm((current) =>
      current.includes(length)
        ? current.filter((item) => item !== length)
        : [...current, length].sort((a, b) => a - b),
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('preflight.purchase.title')}
      className="max-w-4xl"
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-border bg-muted/20 p-0.5">
            <Button
              variant={view === 'buy' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setView('buy')}
            >
              {t('preflight.purchase.viewBuy')}
            </Button>
            <Button
              variant={view === 'optimise' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setView('optimise')}
            >
              {t('preflight.purchase.viewOptimise')}
            </Button>
          </div>
        </div>

        {stockLengthsMm.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('preflight.purchase.noStock')}</p>
        ) : buyable.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('preflight.purchase.noLengths')}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Summary
                label={t('preflight.purchase.totalWeight')}
                value={kilograms(totalPurchasedKg)}
              />
              <Summary
                label={t('preflight.purchase.wasteWeight')}
                value={kilograms(totalWasteKg)}
              />
              <Summary
                label={t('preflight.purchase.binWaste')}
                value={kilograms(totalBinWasteKg)}
              />
            </div>

            <MovementTable
              loadingOne={totalLoadingOne}
              loadingTwo={totalLoadingTwo}
              loadingEquipment={totalLoadingEquipment}
              wasteOne={totalCarryOne}
              wasteTwo={totalCarryTwo}
              wasteEquipment={totalOverTwo}
            />

            {totalWasteKg == null && (
              <p className="text-xs text-muted-foreground">{t('preflight.purchase.noMass')}</p>
            )}

            {preCutPurchased && (
              <p className="text-xs text-amber-300">{t('preflight.purchase.preCutPurchased')}</p>
            )}

            {machineTooLong > 0 && (
              <p className="text-xs text-destructive">
                {t('preflight.purchase.machineTooLong', {
                  count: machineTooLong,
                  length: metres(MACHINE_MAX_MM),
                })}
              </p>
            )}

            {oversizedCount > 0 && (
              <p className="text-xs text-destructive">
                {t('preflight.purchase.oversizedTotal', { count: oversizedCount })}
              </p>
            )}

            {invalidSupportBars > 0 && (
              <p className="text-xs text-destructive">
                {t('preflight.purchase.supportWarning', { count: invalidSupportBars })}
              </p>
            )}

            {view === 'buy' ? (
              <BuyList rows={buyRows} jobName={jobName} />
            ) : (
              <>
                <details className="rounded-lg border border-border bg-muted/20">
                  <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
                    {t('preflight.purchase.settings')}
                  </summary>
                  <div className="flex flex-col gap-3 border-t border-border p-3">
                    <div className="flex flex-wrap items-end gap-4">
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">
                          {t('preflight.purchase.margin')}
                        </span>
                        <input
                          type="number"
                          min={0}
                          step={10}
                          value={marginMm}
                          onChange={(event) => setMarginMm(Number(event.target.value) || 0)}
                          className="h-9 w-32 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </label>
                      <div className="flex flex-wrap gap-1.5 pb-1">
                        {MARGIN_PRESETS.map((preset) => (
                          <Button
                            key={preset}
                            variant={marginMm === preset ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setMarginMm(preset)}
                          >
                            {preset} mm
                          </Button>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">
                          {t('preflight.purchase.onePersonCarry')}
                        </span>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={onePersonKg}
                          onChange={(event) => {
                            const value = Number(event.target.value) || 0
                            setOnePersonKg(value)
                            setTwoPersonKg((current) => Math.max(current, value))
                          }}
                          className="h-9 w-28 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">
                          {t('preflight.purchase.twoPersonCarry')}
                        </span>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={twoPersonKg}
                          onChange={(event) =>
                            setTwoPersonKg(Math.max(onePersonKg, Number(event.target.value) || 0))
                          }
                          className="h-9 w-28 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </label>
                      <p className="pb-2 text-xs text-muted-foreground">
                        {t('preflight.purchase.wasteRemovalHint')}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 text-sm text-muted-foreground">
                        {t('preflight.purchase.stockLengths')}
                      </span>
                      {AU_STOCK_LENGTHS_MM.map((length) => {
                        const selected = stockLengthsMm.includes(length)
                        const needsPreCut = length > MACHINE_MAX_MM
                        return (
                          <button
                            key={length}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => toggleStock(length)}
                            title={needsPreCut ? t('preflight.purchase.preCutShort') : undefined}
                            className={cn(
                              'rounded-md border px-2.5 py-1 font-mono text-xs transition-colors',
                              selected
                                ? needsPreCut
                                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                                  : 'border-primary bg-primary/15 text-foreground'
                                : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                            )}
                          >
                            {metres(length)}
                            {needsPreCut ? '*' : ''}
                          </button>
                        )
                      })}
                    </div>

                    <div className="flex flex-col gap-0.5">
                      <p className="text-xs text-muted-foreground">
                        {t('preflight.purchase.stockHint')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('preflight.purchase.marginHint')}
                      </p>
                      {preCutSelected && (
                        <p className="text-xs text-amber-300">
                          {t('preflight.purchase.preCutNote')}
                        </p>
                      )}
                    </div>
                  </div>
                </details>

                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>{t('preflight.purchase.stock')}</TableHead>
                        <TableHead>{t('preflight.purchase.buy')}</TableHead>
                        <TableHead className="text-right">
                          {t('preflight.purchase.wasteWeight')}
                        </TableHead>
                        <TableHead className="text-right">
                          {t('preflight.purchase.binWaste')}
                        </TableHead>
                        <TableHead className="text-right">
                          {t('preflight.purchase.carry')}
                        </TableHead>
                        <TableHead className="text-right">{t('preflight.purchase.use')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {buyable.map((plan) => (
                        <TableRow key={plan.key}>
                          <TableCell className="align-top">
                            <div className="font-mono text-xs">{plan.stock}</div>
                            {plan.tee ? (
                              <div className="text-[11px] text-muted-foreground">
                                {t('preflight.purchase.tee')}
                                {plan.sources.length > 0 ? ` · ${plan.sources.join(', ')}` : ''}
                              </div>
                            ) : null}
                            <div className="text-[11px] text-muted-foreground">
                              {t('preflight.purchase.pieceRequired', {
                                count: plan.pieceCount,
                                length: metres(plan.requiredMm),
                              })}
                            </div>
                            {plan.oversized.length > 0 ? (
                              <div className="mt-1 text-[11px] text-destructive">
                                {t('preflight.purchase.oversized', {
                                  count: plan.oversized.length,
                                  length: metres(
                                    usableStockLengthMm(Math.max(...stockLengthsMm), marginMm),
                                  ),
                                })}
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell className="align-top">
                            {plan.purchases.length === 0 ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              <div className="flex flex-col gap-0.5 font-mono text-xs">
                                {plan.purchases.map((item) => (
                                  <span
                                    key={item.lengthMm}
                                    className={cn(
                                      item.lengthMm > MACHINE_MAX_MM && 'text-amber-300',
                                    )}
                                  >
                                    {item.count} × {metres(item.lengthMm)}
                                    {item.lengthMm > MACHINE_MAX_MM ? '*' : ''}
                                  </span>
                                ))}
                                <span className="text-[11px] text-muted-foreground">
                                  {metres(plan.purchasedMm)} total
                                </span>
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right align-top font-mono text-xs">
                            {plan.purchasedMm > 0 ? (
                              <>
                                <div>{kilograms(plan.wasteKg)}</div>
                                <div className="text-[11px] text-muted-foreground">
                                  {metres(plan.wasteMm)}
                                </div>
                              </>
                            ) : (
                              '—'
                            )}
                          </TableCell>
                          <TableCell className="text-right align-top font-mono text-xs">
                            {plan.purchasedMm > 0 ? (
                              <>
                                <div>{kilograms(plan.binWasteKg)}</div>
                                <div className="text-[11px] text-muted-foreground">
                                  {t('preflight.purchase.reusableShort', {
                                    weight: kilograms(plan.reusableOffcutKg),
                                  })}
                                </div>
                              </>
                            ) : (
                              '—'
                            )}
                          </TableCell>
                          <TableCell className="text-right align-top font-mono text-xs">
                            {plan.carryOnePieces == null
                              ? '—'
                              : `${plan.carryOnePieces} · ${plan.carryTwoPieces ?? 0} · ${plan.overTwoPieces ?? 0}`}
                          </TableCell>
                          <TableCell className="text-right align-top font-mono text-xs">
                            {plan.purchasedMm > 0 ? `${(plan.utilisation * 100).toFixed(0)}%` : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {t('preflight.purchase.overallUse', { pct: (overall * 100).toFixed(0) })}
                  </span>
                  <span>{t('preflight.purchase.teeNote')}</span>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">
                      {t('preflight.purchase.nestingTitle')}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('preflight.purchase.nestingHint')}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowNesting((value) => !value)}
                  >
                    {showNesting
                      ? t('preflight.purchase.hideNesting')
                      : t('preflight.purchase.showNesting')}
                  </Button>
                </div>

                {showNesting && (
                  <NestingSolution
                    plans={buyable}
                    onePersonKg={onePersonKg}
                    twoPersonKg={twoPersonKg}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}

function BuyList({ rows, jobName }: { rows: BuyRow[]; jobName?: string }) {
  const { t } = useTranslation()
  const groups = useMemo(() => groupBuyRows(rows), [rows])
  const tableRows = useMemo(
    () =>
      groups.flatMap((family) => {
        const familyRowSpan = family.sizes.reduce((sum, size) => sum + size.rows.length, 0)
        let firstOfFamily = true
        return family.sizes.flatMap((size) =>
          size.rows.map((row, index) => {
            const showFamily = firstOfFamily
            firstOfFamily = false
            return {
              key: `${family.family}-${size.size}-${row.lengthMm}-${row.tee ? 't' : 'l'}`,
              family: family.family,
              familyRowSpan,
              showFamily,
              size: size.size,
              sizeRowSpan: size.rows.length,
              showSize: index === 0,
              tee: size.tee,
              lengthMm: row.lengthMm,
              count: row.count,
            }
          }),
        )
      }),
    [groups],
  )
  const download = () => {
    const header = [
      t('preflight.purchase.section'),
      t('preflight.purchase.size'),
      t('preflight.purchase.lengthM'),
      t('preflight.purchase.qtyShort'),
    ]
    const body = rows.map((row) => {
      const { family, size } = splitStock(row.stock)
      return [family, size, (row.lengthMm / 1000).toFixed(1), String(row.count)]
    })
    const csv = [header, ...body].map((line) => line.map(csvCell).join(',')).join('\r\n')
    downloadText(`${fileStem(jobName ?? 'job')}-purchase-list.csv`, `${csv}\r\n`, 'text/csv')
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t('preflight.purchase.buyListTitle')}</span>
        <Button variant="outline" size="sm" onClick={download} disabled={rows.length === 0}>
          {t('preflight.purchase.downloadCsv')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table className="[&_td]:border-r [&_td]:border-border/50 [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-border/50 [&_th:last-child]:border-r-0">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('preflight.purchase.section')}</TableHead>
              <TableHead>{t('preflight.purchase.size')}</TableHead>
              <TableHead className="text-right">{t('preflight.purchase.length')}</TableHead>
              <TableHead className="text-right">{t('preflight.purchase.qtyShort')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tableRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-sm text-muted-foreground">
                  —
                </TableCell>
              </TableRow>
            ) : (
              tableRows.map((row) => (
                <TableRow key={row.key}>
                  {row.showFamily && (
                    <TableCell
                      rowSpan={row.familyRowSpan}
                      className="align-top bg-muted/20 font-mono text-xs font-semibold uppercase tracking-wide"
                    >
                      {row.family}
                    </TableCell>
                  )}
                  {row.showSize && (
                    <TableCell rowSpan={row.sizeRowSpan} className="align-top">
                      <div className="font-mono text-sm">{row.size}</div>
                      {row.tee ? (
                        <div className="text-[11px] text-muted-foreground">
                          {t('preflight.purchase.teeShort')}
                        </div>
                      ) : null}
                    </TableCell>
                  )}
                  <TableCell
                    className={cn(
                      'text-right font-mono text-sm',
                      row.lengthMm > MACHINE_MAX_MM && 'text-amber-300',
                    )}
                  >
                    {metres(row.lengthMm)}
                    {row.lengthMm > MACHINE_MAX_MM ? '*' : ''}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{row.count}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {rows.some((row) => row.tee) && (
        <p className="text-xs text-muted-foreground">{t('preflight.purchase.teeNote')}</p>
      )}
    </div>
  )
}

function NestingSolution({
  plans,
  onePersonKg,
  twoPersonKg,
}: {
  plans: PurchasePlan[]
  onePersonKg: number
  twoPersonKg: number
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-slate-600" />
          {t('preflight.purchase.beamPieces')}
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-emerald-500/70" />
          {t('preflight.purchase.onePerson')}
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-amber-500/70" />
          {t('preflight.purchase.twoPerson')}
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-red-500/70" />
          {t('preflight.purchase.equipment')}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground">
        {t('preflight.purchase.wastePatternLegend')}
      </p>
      {plans.map((plan) => {
        const kgPerMm =
          plan.wasteKg != null && plan.wasteMm > 0 ? plan.wasteKg / plan.wasteMm : null
        const beamList: { stockLengthMm: number; bars: PurchaseBar[] }[] = []
        if (plan.tee) {
          for (let i = 0; i < plan.bars.length; i += 2) {
            const pair = plan.bars.slice(i, i + 2)
            beamList.push({ stockLengthMm: plan.bars[i].stockLengthMm, bars: pair })
          }
        } else {
          for (const bar of plan.bars) {
            beamList.push({ stockLengthMm: bar.stockLengthMm, bars: [bar] })
          }
        }
        beamList.sort(
          (a, b) =>
            a.bars.reduce((sum, bar) => sum + bar.wasteMm, 0) -
            b.bars.reduce((sum, bar) => sum + bar.wasteMm, 0),
        )
        const beams = keyed(
          beamList,
          (beam) =>
            `${beam.stockLengthMm}|${beam.bars
              .map((bar) => bar.units.map((unit) => `${unit.mark}@${unit.lengthMm}`).join(','))
              .join(';')}`,
        )

        return (
          <div key={plan.key} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-xs font-medium">{plan.stock}</span>
              <span className="text-[11px] text-muted-foreground">
                {t('preflight.purchase.nestingPieces', { count: plan.pieceCount })} ·{' '}
                {t('preflight.purchase.nestingPurchased', {
                  length: metres(plan.purchasedMm),
                })}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {beams.map(({ id: beamId, item: beam }, index) => {
                const sides = keyed(
                  beam.bars,
                  (bar) =>
                    `${bar.stockLengthMm}|${bar.usedMm}|${bar.units
                      .map((unit) => `${unit.mark}@${unit.lengthMm}`)
                      .join(',')}`,
                )
                return (
                  <div key={beamId} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
                      <span
                        className={
                          beam.stockLengthMm > MACHINE_MAX_MM ? 'text-amber-300' : undefined
                        }
                      >
                        {plan.tee
                          ? t('preflight.purchase.nestingBeamT', {
                              index: index + 1,
                              length: metres(beam.stockLengthMm),
                            })
                          : t('preflight.purchase.nestingBeam', {
                              index: index + 1,
                              length: metres(beam.stockLengthMm),
                            })}
                      </span>
                    </div>
                    {sides.map(({ id: sideId, item: bar }, side) => (
                      <div key={sideId} className="flex flex-col gap-0.5">
                        {plan.tee && (
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {t('preflight.purchase.nestingSide', { index: side + 1 })}
                          </span>
                        )}
                        <BarStrip
                          bar={bar}
                          kgPerMm={kgPerMm}
                          onePersonKg={onePersonKg}
                          twoPersonKg={twoPersonKg}
                        />
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function BarStrip({
  bar,
  kgPerMm,
  onePersonKg,
  twoPersonKg,
}: {
  bar: PurchaseBar
  kgPerMm: number | null
  onePersonKg: number
  twoPersonKg: number
}) {
  const total = bar.stockLengthMm
  const wasteKg = kgPerMm == null ? null : bar.wasteMm * kgPerMm
  const wasteTone =
    wasteKg == null
      ? 'bg-amber-500/20 text-amber-200'
      : wasteKg <= onePersonKg
        ? 'bg-emerald-500/25 text-emerald-200'
        : wasteKg <= twoPersonKg
          ? 'bg-amber-500/25 text-amber-200'
          : 'bg-red-500/25 text-red-200'
  let cursor = 0
  const units = keyed(bar.units, (unit) => `${unit.mark}|${unit.lengthMm}`)
  return (
    <div className="relative h-6 w-full overflow-hidden rounded border border-border bg-muted/40">
      {units.map(({ id, item: unit }) => {
        const left = (cursor / total) * 100
        const width = (unit.lengthMm / total) * 100
        cursor += unit.lengthMm
        return (
          <div
            key={id}
            style={{ left: `${left}%`, width: `${width}%` }}
            className="absolute inset-y-0 flex items-center overflow-hidden border-r border-background/70 bg-slate-700/70 px-1 text-slate-100"
            title={`${unit.mark} · ${metres(unit.lengthMm, 2)}`}
          >
            <span className="truncate text-[9px] leading-none">{unit.mark}</span>
          </div>
        )
      })}
      {bar.wasteMm > 0 && (
        <div
          style={{
            left: `${(bar.usedMm / total) * 100}%`,
            width: `${(bar.wasteMm / total) * 100}%`,
            backgroundImage:
              bar.wasteMm < REUSABLE_OFFCUT_MM
                ? 'repeating-linear-gradient(45deg, rgba(255,255,255,0.28) 0 2px, transparent 2px 6px)'
                : undefined,
          }}
          className={cn(
            'absolute inset-y-0 flex items-center justify-end overflow-hidden px-1 text-[9px]',
            wasteTone,
          )}
        >
          <span className="truncate">{metres(bar.wasteMm, 2)}</span>
        </div>
      )}
    </div>
  )
}

function MovementTable({
  loadingOne,
  loadingTwo,
  loadingEquipment,
  wasteOne,
  wasteTwo,
  wasteEquipment,
}: {
  loadingOne: number
  loadingTwo: number
  loadingEquipment: number
  wasteOne: number | null
  wasteTwo: number | null
  wasteEquipment: number | null
}) {
  const { t } = useTranslation()
  const loadingTotal = loadingOne + loadingTwo + loadingEquipment
  const wasteKnown = wasteOne != null && wasteTwo != null && wasteEquipment != null
  const wasteTotal = wasteKnown ? wasteOne + wasteTwo + wasteEquipment : null
  const totalOne = wasteOne == null ? null : loadingOne + wasteOne
  const totalTwo = wasteTwo == null ? null : loadingTwo + wasteTwo
  const totalEquipment = wasteEquipment == null ? null : loadingEquipment + wasteEquipment
  const grandTotal = wasteTotal == null ? null : loadingTotal + wasteTotal
  const count = (value: number | null) => (value == null ? '—' : String(value))

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium">{t('preflight.purchase.movement')}</div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('preflight.purchase.movement')}</TableHead>
              <TableHead className="text-right">{t('preflight.purchase.onePerson')}</TableHead>
              <TableHead className="text-right">{t('preflight.purchase.twoPerson')}</TableHead>
              <TableHead className="text-right">{t('preflight.purchase.equipment')}</TableHead>
              <TableHead className="text-right">{t('preflight.purchase.total')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>{t('preflight.purchase.loading')}</TableCell>
              <TableCell className="text-right font-mono text-xs">{loadingOne}</TableCell>
              <TableCell className="text-right font-mono text-xs">{loadingTwo}</TableCell>
              <TableCell className="text-right font-mono text-xs">{loadingEquipment}</TableCell>
              <TableCell className="text-right font-mono text-xs">{loadingTotal}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>{t('preflight.purchase.waste')}</TableCell>
              <TableCell className="text-right font-mono text-xs">{count(wasteOne)}</TableCell>
              <TableCell className="text-right font-mono text-xs">{count(wasteTwo)}</TableCell>
              <TableCell className="text-right font-mono text-xs">
                {count(wasteEquipment)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">{count(wasteTotal)}</TableCell>
            </TableRow>
            <TableRow className="font-semibold">
              <TableCell>{t('preflight.purchase.total')}</TableCell>
              <TableCell className="text-right font-mono text-xs">{count(totalOne)}</TableCell>
              <TableCell className="text-right font-mono text-xs">{count(totalTwo)}</TableCell>
              <TableCell className="text-right font-mono text-xs">
                {count(totalEquipment)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">{count(grandTotal)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  )
}
