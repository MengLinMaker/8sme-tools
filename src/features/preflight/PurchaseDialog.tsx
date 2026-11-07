/**
 * Purchase-length calculator for the preflight Profiles table.
 *
 * The operator wants to know which standard Australian beam lengths to buy so the job's pieces
 * nest with the least offcut. A T profile is bought as its parent UB (one beam yields two T
 * bars), and every bar keeps a margin for the chuck / end trim / cutting error.
 */

import { HelpCircle } from 'lucide-react'
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
  LARGE_REUSABLE_OFFCUT_MM,
  type PurchaseBar,
  type PurchaseGroupInput,
  type PurchasePlan,
  planPurchase,
  planPurchases,
  REUSABLE_OFFCUT_MM,
  stockLengthsForStock,
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
  const totalPurchasedKg = plans.every((plan) => plan.purchasedKg != null)
    ? plans.reduce((sum, plan) => sum + (plan.purchasedKg ?? 0), 0)
    : null
  const totalWasteKg = plans.every((plan) => plan.wasteKg != null)
    ? plans.reduce((sum, plan) => sum + (plan.wasteKg ?? 0), 0)
    : null
  const totalBinWasteKg = plans.every((plan) => plan.binWasteKg != null)
    ? plans.reduce((sum, plan) => sum + (plan.binWasteKg ?? 0), 0)
    : null
  const minChuckMm = useMemo(() => {
    const wastes = plans.flatMap((plan) => plan.bars.map((bar) => bar.wasteMm))
    return wastes.length > 0 ? Math.min(...wastes) : null
  }, [plans])
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

  const largerStockSuggestions = useMemo(() => {
    const map = new Map<string, number>()
    if (stockLengthsMm.length === 0) return map
    const selectedMax = Math.max(...stockLengthsMm)
    const selected = new Set(stockLengthsMm)
    for (const group of groups) {
      const current = plans.find((plan) => plan.key === group.key)
      if (!current || current.largeOffcuts === 0) continue
      const beamCount = current.purchases.reduce((sum, item) => sum + item.count, 0)
      if (beamCount <= 1) continue
      const larger = stockLengthsForStock(group.stock)
        .filter((length) => length > selectedMax && !selected.has(length))
        .slice(0, 2)
      let best: { lengthMm: number; purchasedMm: number } | null = null
      for (const length of larger) {
        const alt = planPurchase(group, {
          stockLengthsMm: [...stockLengthsMm, length],
          marginMm: Math.max(0, marginMm),
          onePersonKg,
          twoPersonKg,
        })
        if (alt.largeOffcuts !== 0 || !alt.purchases.some((item) => item.lengthMm === length)) {
          continue
        }
        if (
          !best ||
          alt.purchasedMm < best.purchasedMm ||
          (alt.purchasedMm === best.purchasedMm && length < best.lengthMm)
        ) {
          best = { lengthMm: length, purchasedMm: alt.purchasedMm }
        }
      }
      if (best) map.set(group.key, best.lengthMm)
    }
    return map
  }, [groups, marginMm, onePersonKg, plans, stockLengthsMm, twoPersonKg])

  const toggleStock = (length: number) => {
    setStockLengthsMm((current) =>
      current.includes(length)
        ? current.filter((item) => item !== length)
        : [...current, length].sort((a, b) => a - b),
    )
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('preflight.purchase.title')} fullscreen>
      <div className="flex flex-col gap-4 p-5">
        <div className="sticky top-0 z-20 -mx-5 -mt-5 border-b border-border bg-card px-5 pb-3 pt-5">
          {buyable.length > 0 && (
            <div className="grid gap-3 md:grid-cols-[minmax(10rem,2fr)_minmax(0,3fr)]">
              <OverallStatsTable
                purchasedKg={totalPurchasedKg}
                wasteKg={totalWasteKg}
                binKg={totalBinWasteKg}
                minChuckMm={minChuckMm}
              />
              <MovementTable
                loadingOne={totalLoadingOne}
                loadingTwo={totalLoadingTwo}
                loadingEquipment={totalLoadingEquipment}
                wasteOne={totalCarryOne}
                wasteTwo={totalCarryTwo}
                wasteEquipment={totalOverTwo}
              />
            </div>
          )}

          <div className="mt-3">
            <details className="rounded-lg border border-border bg-muted/20">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
                {t('preflight.purchase.settings')}
              </summary>
              <div className="grid gap-3 border-t border-border p-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-x-4">
                <span className="text-sm text-muted-foreground">
                  {t('preflight.purchase.margin')}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    step={10}
                    value={marginMm}
                    onChange={(event) => setMarginMm(Number(event.target.value) || 0)}
                    className="h-8 w-24 rounded-md border border-input bg-transparent px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {MARGIN_PRESETS.map((preset) => (
                    <Button
                      key={preset}
                      variant={marginMm === preset ? 'default' : 'outline'}
                      size="sm"
                      className="h-8 min-w-18"
                      onClick={() => setMarginMm(preset)}
                    >
                      {preset} mm
                    </Button>
                  ))}
                </div>

                <span className="text-sm text-muted-foreground">
                  {t('preflight.purchase.carryLimits')}
                </span>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      {t('preflight.purchase.onePerson')}
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
                      className="h-8 w-20 rounded-md border border-input bg-transparent px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      {t('preflight.purchase.twoPerson')}
                    </span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={twoPersonKg}
                      onChange={(event) =>
                        setTwoPersonKg(Math.max(onePersonKg, Number(event.target.value) || 0))
                      }
                      className="h-8 w-20 rounded-md border border-input bg-transparent px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                </div>

                <span className="text-sm text-muted-foreground">
                  {t('preflight.purchase.stockLengths')}
                </span>
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap gap-1.5">
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
                            'inline-flex h-8 min-w-14 items-center justify-center rounded-md border px-2 font-mono text-xs transition-colors',
                            selected
                              ? needsPreCut
                                ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                                : 'border-primary bg-primary/15 text-foreground'
                              : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                          )}
                        >
                          {(length / 1000).toFixed(1)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </details>
          </div>
        </div>

        {stockLengthsMm.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('preflight.purchase.noStock')}</p>
        ) : buyable.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('preflight.purchase.noLengths')}</p>
        ) : (
          <>
            {totalWasteKg == null && (
              <p className="text-xs text-muted-foreground">{t('preflight.purchase.noMass')}</p>
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

            <BuyList rows={buyRows} jobName={jobName} />

            <div className="text-sm font-medium">{t('preflight.purchase.nestingTitle')}</div>

            <NestingSolution
              plans={buyable}
              onePersonKg={onePersonKg}
              twoPersonKg={twoPersonKg}
              marginMm={marginMm}
              suggestions={largerStockSuggestions}
            />
          </>
        )}
      </div>
    </Dialog>
  )
}

function BuyList({ rows, jobName }: { rows: BuyRow[]; jobName?: string }) {
  const { t } = useTranslation()
  const [showOptimiserHelp, setShowOptimiserHelp] = useState(false)
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
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{t('preflight.purchase.buyListTitle')}</span>
          <button
            type="button"
            onClick={() => setShowOptimiserHelp((value) => !value)}
            aria-expanded={showOptimiserHelp}
            aria-label={t('preflight.purchase.optimiserHelp')}
            title={t('preflight.purchase.optimiserHelp')}
            className="inline-flex size-6 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <HelpCircle className="size-3.5" />
          </button>
        </div>
        <Button variant="outline" size="sm" onClick={download} disabled={rows.length === 0}>
          {t('preflight.purchase.downloadCsv')}
        </Button>
      </div>
      {showOptimiserHelp && (
        <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
          <div className="font-medium text-foreground">
            {t('preflight.purchase.optimiserTitle')}
          </div>
          <ol className="mt-1 list-decimal space-y-1 pl-4 text-muted-foreground">
            <li>{t('preflight.purchase.optimiserStep1')}</li>
            <li>{t('preflight.purchase.optimiserStep2')}</li>
            <li>{t('preflight.purchase.optimiserStep3')}</li>
            <li>{t('preflight.purchase.optimiserStep4')}</li>
          </ol>
          <p className="mt-2 text-muted-foreground">{t('preflight.purchase.optimiserNote')}</p>
        </div>
      )}
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
  marginMm,
  suggestions,
}: {
  plans: PurchasePlan[]
  onePersonKg: number
  twoPersonKg: number
  marginMm: number
  suggestions: Map<string, number>
}) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<'all' | 'heavy' | 'reusable' | 'large'>('all')
  const kgPerMmFor = (plan: PurchasePlan) =>
    plan.wasteKg != null && plan.wasteMm > 0 ? plan.wasteKg / plan.wasteMm : null
  const attention = (bars: PurchaseBar[], kgPerMm: number | null) => {
    let priority = 0
    let amount = 0
    for (const bar of bars) {
      if (bar.wasteMm <= 0) continue
      const kg = kgPerMm == null ? 0 : bar.wasteMm * kgPerMm
      if (bar.wasteMm >= REUSABLE_OFFCUT_MM) {
        priority = Math.max(priority, 2)
      } else if (kg > twoPersonKg) {
        priority = Math.max(priority, 3)
      } else if (kg > onePersonKg) {
        priority = Math.max(priority, 1)
      }
      amount = Math.max(amount, bar.wasteMm)
    }
    return priority * 1_000_000_000 + amount
  }
  const longestReusable = (bars: PurchaseBar[]) =>
    bars.reduce(
      (max, bar) => (bar.wasteMm >= REUSABLE_OFFCUT_MM ? Math.max(max, bar.wasteMm) : max),
      0,
    )
  const suggestedScrapMm = (plan: PurchasePlan) => {
    let bestWaste = -1
    let bestUsed = 0
    if (plan.tee) {
      for (let i = 0; i < plan.bars.length; i += 2) {
        const left = plan.bars[i]
        const right = plan.bars[i + 1]
        const waste = Math.max(left?.wasteMm ?? 0, right?.wasteMm ?? 0)
        if (waste < LARGE_REUSABLE_OFFCUT_MM) continue
        const used = Math.max(
          left.stockLengthMm - left.wasteMm,
          right ? right.stockLengthMm - right.wasteMm : 0,
        )
        if (waste > bestWaste) {
          bestWaste = waste
          bestUsed = used
        }
      }
    } else {
      for (const bar of plan.bars) {
        if (bar.wasteMm < LARGE_REUSABLE_OFFCUT_MM) continue
        if (bar.wasteMm > bestWaste) {
          bestWaste = bar.wasteMm
          bestUsed = bar.stockLengthMm - bar.wasteMm
        }
      }
    }
    return bestWaste >= 0 ? bestUsed + marginMm : null
  }
  const hasSubstitute = (bars: PurchaseBar[]) =>
    bars.some((bar) => bar.wasteMm >= LARGE_REUSABLE_OFFCUT_MM)
  const orderedPlans = [...plans].sort((a, b) => {
    const substituteDelta = Number(hasSubstitute(b.bars)) - Number(hasSubstitute(a.bars))
    if (substituteDelta !== 0) return substituteDelta
    return filter === 'reusable' || filter === 'large'
      ? longestReusable(b.bars) - longestReusable(a.bars)
      : attention(b.bars, kgPerMmFor(b)) - attention(a.bars, kgPerMmFor(a))
  })
  const visiblePlans = orderedPlans.filter((plan) => {
    if (filter === 'all') return true
    if (filter === 'reusable') {
      return plan.bars.some((bar) => bar.wasteMm >= REUSABLE_OFFCUT_MM)
    }
    if (filter === 'large') {
      return plan.bars.some((bar) => bar.wasteMm >= LARGE_REUSABLE_OFFCUT_MM)
    }
    const kgPerMm = kgPerMmFor(plan)
    return plan.bars.some((bar) => {
      if (bar.wasteMm <= 0 || bar.wasteMm >= REUSABLE_OFFCUT_MM) return false
      const kg = kgPerMm == null ? 0 : bar.wasteMm * kgPerMm
      return kg > twoPersonKg
    })
  })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-3.5 rounded-full bg-slate-600" />
            {t('preflight.purchase.beamPieces')}
          </span>
          <span className="flex items-center gap-1">
            <span className="size-3.5 rounded-full bg-emerald-500/70" />
            {t('preflight.purchase.onePerson')}
          </span>
          <span className="flex items-center gap-1">
            <span className="size-3.5 rounded-full bg-amber-500/70" />
            {t('preflight.purchase.twoPerson')}
          </span>
          <span className="flex items-center gap-1">
            <span className="size-3.5 rounded-full bg-red-500/70" />
            {t('preflight.purchase.equipment')}
          </span>
          <span className="flex items-center gap-1">
            <span
              className="size-3.5 rounded-sm bg-slate-400/50"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(45deg, rgba(255,255,255,0.55) 0 2px, transparent 2px 4px)',
              }}
            />
            {t('preflight.purchase.binLegend')}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ['all', 'filterAll'],
              ['heavy', 'filterHeavyBin'],
              ['reusable', 'filterReusable'],
            ] as const
          ).map(([value, key]) => (
            <Button
              key={value}
              variant={filter === value ? 'default' : 'outline'}
              size="sm"
              className="h-7 px-2 text-[10px]"
              onClick={() => setFilter(value)}
            >
              {t(`preflight.purchase.${key}`)}
            </Button>
          ))}
        </div>
      </div>
      {visiblePlans.length === 0 && <p className="text-sm text-muted-foreground">—</p>}
      {visiblePlans.map((plan) => {
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
        const matchingBeams = beamList.filter((beam) => {
          if (filter === 'all') return true
          return beam.bars.some((bar) => {
            if (bar.wasteMm <= 0) return false
            if (filter === 'reusable') return bar.wasteMm >= REUSABLE_OFFCUT_MM
            if (filter === 'large') return bar.wasteMm >= LARGE_REUSABLE_OFFCUT_MM
            const kg = kgPerMm == null ? 0 : bar.wasteMm * kgPerMm
            return bar.wasteMm < REUSABLE_OFFCUT_MM && kg > twoPersonKg
          })
        })
        matchingBeams.sort((a, b) => attention(b.bars, kgPerMm) - attention(a.bars, kgPerMm))
        const beams = keyed(
          matchingBeams,
          (beam) =>
            `${beam.stockLengthMm}|${beam.bars
              .map((bar) => bar.units.map((unit) => `${unit.mark}@${unit.lengthMm}`).join(','))
              .join(';')}`,
        )
        const scrapMm = suggestedScrapMm(plan)
        const suggestion = suggestions.get(plan.key)
        const minChuckMm = plan.bars.length
          ? Math.min(...plan.bars.map((bar) => bar.wasteMm))
          : null

        return (
          <div key={plan.key} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  className="w-24 shrink-0 truncate font-mono text-xs font-medium"
                  title={plan.stock}
                >
                  {plan.stock}
                </span>
                {suggestion != null ? (
                  <span className="whitespace-nowrap rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">
                    {t('preflight.purchase.largerStockSuggestion', {
                      length: metres(suggestion, suggestion % 1000 === 0 ? 0 : 1),
                    })}
                  </span>
                ) : scrapMm != null ? (
                  <span className="whitespace-nowrap rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                    {t('preflight.purchase.largeReusableBadge', {
                      length: metres(scrapMm),
                    })}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                <span>
                  {t('preflight.purchase.nestingMetrics', {
                    bin: kilograms(plan.binWasteKg),
                    reusable: kilograms(plan.reusableOffcutKg),
                    chuck: minChuckMm == null ? '—' : metres(minChuckMm, 2),
                  })}
                </span>
              </div>
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
                  <div key={beamId} className="flex items-start gap-2">
                    <span
                      className={cn(
                        'w-24 shrink-0 pt-1 text-[10px] leading-tight text-muted-foreground',
                        beam.stockLengthMm > MACHINE_MAX_MM && 'text-amber-300',
                      )}
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
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {sides.map(({ id: sideId, item: bar }, side) => (
                        <div key={sideId} className="flex items-center gap-1">
                          {plan.tee && (
                            <span
                              className="w-4 shrink-0 text-center text-[9px] text-muted-foreground"
                              title={t('preflight.purchase.nestingSide', { index: side + 1 })}
                            >
                              {side + 1}
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <BarStrip
                              bar={bar}
                              kgPerMm={kgPerMm}
                              onePersonKg={onePersonKg}
                              twoPersonKg={twoPersonKg}
                              marginMm={marginMm}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
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
  marginMm,
}: {
  bar: PurchaseBar
  kgPerMm: number | null
  onePersonKg: number
  twoPersonKg: number
  marginMm: number
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
      {bar.wasteMm >= LARGE_REUSABLE_OFFCUT_MM && (
        <div
          className="absolute inset-y-0 z-10 w-px bg-yellow-400"
          style={{
            left: `${(Math.min(bar.stockLengthMm, bar.usedMm + marginMm) / total) * 100}%`,
          }}
        />
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
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table className="[&_tr]:h-9">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead />
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
            <TableCell className="text-right font-mono text-xs">{count(wasteEquipment)}</TableCell>
            <TableCell className="text-right font-mono text-xs">{count(wasteTotal)}</TableCell>
          </TableRow>
          <TableRow className="font-semibold">
            <TableCell>{t('preflight.purchase.total')}</TableCell>
            <TableCell className="text-right font-mono text-xs">{count(totalOne)}</TableCell>
            <TableCell className="text-right font-mono text-xs">{count(totalTwo)}</TableCell>
            <TableCell className="text-right font-mono text-xs">{count(totalEquipment)}</TableCell>
            <TableCell className="text-right font-mono text-xs">{count(grandTotal)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  )
}

function OverallStatsTable({
  purchasedKg,
  wasteKg,
  binKg,
  minChuckMm,
}: {
  purchasedKg: number | null
  wasteKg: number | null
  binKg: number | null
  minChuckMm: number | null
}) {
  const { t } = useTranslation()
  const rows: [string, string][] = [
    [t('preflight.purchase.totalWeight'), kilograms(purchasedKg)],
    [t('preflight.purchase.wasteWeight'), kilograms(wasteKg)],
    [t('preflight.purchase.binWaste'), kilograms(binKg)],
    [t('preflight.purchase.minChuck'), minChuckMm == null ? '—' : `${Math.round(minChuckMm)} mm`],
  ]
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table className="[&_tr]:h-9">
        <TableBody>
          {rows.map(([label, value]) => (
            <TableRow key={label}>
              <TableCell className="text-xs text-muted-foreground">{label}</TableCell>
              <TableCell className="text-right font-mono text-xs">{value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
