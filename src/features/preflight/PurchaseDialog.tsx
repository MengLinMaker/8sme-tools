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
import { MACHINE } from '@/lib/machine/profile'
import {
  AU_STOCK_LENGTHS_MM,
  DEFAULT_CHUCK_MARGIN_MM,
  DEFAULT_STOCK_LENGTHS_MM,
  DEFAULT_WASTE_PIECE_KG,
  type PurchaseBar,
  type PurchaseGroupInput,
  type PurchasePlan,
  type PurchasePriority,
  planPurchases,
  totalCapacityMm,
  totalPurchasedMm,
  totalRequiredMm,
  totalWasteMm,
  usableStockLengthMm,
} from '@/lib/purchasing/purchase'
import { cn } from '@/lib/utils'

const MACHINE_MAX_MM = MACHINE.envelope.maxLengthMm

const MARGIN_PRESETS = [100, 150, 200]
const WASTE_LIMIT_PRESETS = [25, 30]

const PRIORITIES: { id: PurchasePriority; labelKey: string }[] = [
  { id: 'waste-removal', labelKey: 'preflight.purchase.priorities.wasteRemoval' },
  { id: 'length', labelKey: 'preflight.purchase.priorities.length' },
  { id: 'weight', labelKey: 'preflight.purchase.priorities.weight' },
]

function metres(mm: number, digits = 1): string {
  return `${(mm / 1000).toFixed(digits)} m`
}

function kilograms(kg: number | null, digits = 1): string {
  return kg == null ? '—' : `${kg.toFixed(digits)} kg`
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

function capacityMm(plan: PurchasePlan): number {
  return plan.tee ? plan.purchasedMm * 2 : plan.purchasedMm
}

export interface PurchaseDialogProps {
  open: boolean
  onClose: () => void
  groups: PurchaseGroupInput[]
}

export function PurchaseDialog({ open, onClose, groups }: PurchaseDialogProps) {
  const { t } = useTranslation()
  const [marginMm, setMarginMm] = useState(DEFAULT_CHUCK_MARGIN_MM)
  const [stockLengthsMm, setStockLengthsMm] = useState<number[]>([...DEFAULT_STOCK_LENGTHS_MM])
  const [priority, setPriority] = useState<PurchasePriority>('waste-removal')
  const [wasteLimitKg, setWasteLimitKg] = useState(DEFAULT_WASTE_PIECE_KG)
  const [showNesting, setShowNesting] = useState(true)

  const plans = useMemo(
    () =>
      stockLengthsMm.length === 0
        ? []
        : planPurchases(groups, {
            stockLengthsMm,
            marginMm: Math.max(0, marginMm),
            priority,
            maxWastePieceKg: wasteLimitKg,
          }),
    [groups, marginMm, stockLengthsMm, priority, wasteLimitKg],
  )

  const buyable = plans.filter((plan) => plan.pieceCount > 0)
  const purchasedMm = totalPurchasedMm(plans)
  const requiredMm = totalRequiredMm(plans)
  const capacity = totalCapacityMm(plans)
  const wasteMm = totalWasteMm(plans)
  const totalWasteKg = plans.every((plan) => plan.wasteKg != null)
    ? plans.reduce((sum, plan) => sum + (plan.wasteKg ?? 0), 0)
    : null
  const largestWasteKg = plans.reduce<number | null>((max, plan) => {
    if (plan.maxWastePieceKg == null) return max
    return max == null ? plan.maxWastePieceKg : Math.max(max, plan.maxWastePieceKg)
  }, null)
  const overLimitPieces = plans.reduce((sum, plan) => sum + plan.overLimitPieces, 0)
  const oversized = plans.flatMap((plan) => plan.oversized)
  const coveredMm = Math.max(
    0,
    requiredMm - oversized.reduce((sum, unit) => sum + unit.lengthMm, 0),
  )
  const overall = capacity > 0 ? coveredMm / capacity : 0
  const wastePct = capacity > 0 ? (wasteMm / capacity) * 100 : 0
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
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('preflight.purchase.margin')}</span>
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

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-sm text-muted-foreground">
              {t('preflight.purchase.priority')}
            </span>
            {PRIORITIES.map((item) => (
              <Button
                key={item.id}
                variant={priority === item.id ? 'default' : 'outline'}
                size="sm"
                onClick={() => setPriority(item.id)}
              >
                {t(item.labelKey)}
              </Button>
            ))}
          </div>

          {priority === 'waste-removal' && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">
                  {t('preflight.purchase.maxWastePiece')}
                </span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={wasteLimitKg}
                  onChange={(event) => setWasteLimitKg(Number(event.target.value) || 0)}
                  className="h-9 w-28 rounded-md border border-input bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <div className="flex flex-wrap gap-1.5 pb-1">
                {WASTE_LIMIT_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    variant={wasteLimitKg === preset ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setWasteLimitKg(preset)}
                  >
                    {preset} kg
                  </Button>
                ))}
              </div>
              <p className="pb-2 text-xs text-muted-foreground">
                {t('preflight.purchase.wasteRemovalHint')}
              </p>
            </div>
          )}

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
            <p className="text-xs text-muted-foreground">{t('preflight.purchase.stockHint')}</p>
            <p className="text-xs text-muted-foreground">{t('preflight.purchase.marginHint')}</p>
            {preCutSelected && (
              <p className="text-xs text-amber-300">{t('preflight.purchase.preCutNote')}</p>
            )}
          </div>
        </div>

        {stockLengthsMm.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('preflight.purchase.noStock')}</p>
        ) : buyable.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('preflight.purchase.noLengths')}</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('preflight.purchase.stock')}</TableHead>
                    <TableHead className="text-right">{t('preflight.purchase.pieces')}</TableHead>
                    <TableHead className="text-right">{t('preflight.purchase.required')}</TableHead>
                    <TableHead>{t('preflight.purchase.buy')}</TableHead>
                    <TableHead className="text-right">{t('preflight.purchase.waste')}</TableHead>
                    <TableHead className="text-right">
                      {t('preflight.purchase.largestPiece')}
                    </TableHead>
                    <TableHead className="text-right">{t('preflight.purchase.use')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buyable.map((plan) => {
                    const planWastePct = capacityMm(plan) > 0 ? plan.wasteMm / capacityMm(plan) : 0
                    return (
                      <TableRow key={plan.key}>
                        <TableCell className="align-top">
                          <div className="font-mono text-xs">{plan.stock}</div>
                          {plan.tee ? (
                            <div className="text-[11px] text-muted-foreground">
                              {t('preflight.purchase.tee')}
                              {plan.sources.length > 0 ? ` · ${plan.sources.join(', ')}` : ''}
                            </div>
                          ) : null}
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
                        <TableCell className="text-right align-top font-mono text-xs">
                          {plan.pieceCount}
                        </TableCell>
                        <TableCell className="text-right align-top font-mono text-xs">
                          {metres(plan.requiredMm)}
                        </TableCell>
                        <TableCell className="align-top">
                          {plan.purchases.length === 0 ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <div className="flex flex-col gap-0.5 font-mono text-xs">
                              {plan.purchases.map((item) => (
                                <span key={item.lengthMm}>
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
                              <div>{metres(plan.wasteMm)}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {kilograms(plan.wasteKg)} · {(planWastePct * 100).toFixed(0)}%
                              </div>
                            </>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right align-top font-mono text-xs',
                            priority === 'waste-removal' &&
                              plan.maxWastePieceKg != null &&
                              plan.maxWastePieceKg > wasteLimitKg &&
                              'text-destructive',
                          )}
                        >
                          {plan.purchasedMm > 0 ? kilograms(plan.maxWastePieceKg) : '—'}
                        </TableCell>
                        <TableCell className="text-right align-top font-mono text-xs">
                          {plan.purchasedMm > 0 ? `${(plan.utilisation * 100).toFixed(0)}%` : '—'}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Summary label={t('preflight.purchase.profiles')} value={String(buyable.length)} />
              <Summary label={t('preflight.purchase.required')} value={metres(requiredMm)} />
              <Summary label={t('preflight.purchase.buy')} value={metres(purchasedMm)} />
              <Summary
                label={t('preflight.purchase.waste')}
                value={`${metres(wasteMm)} (${wastePct.toFixed(0)}%)`}
              />
              <Summary
                label={t('preflight.purchase.wasteWeight')}
                value={kilograms(totalWasteKg)}
              />
              <Summary
                label={t('preflight.purchase.largestPiece')}
                value={kilograms(largestWasteKg)}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t('preflight.purchase.overallUse', { pct: (overall * 100).toFixed(0) })}</span>
              <span>{t('preflight.purchase.teeNote')}</span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{t('preflight.purchase.nestingTitle')}</div>
                <div className="text-xs text-muted-foreground">
                  {t('preflight.purchase.nestingHint')}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowNesting((value) => !value)}>
                {showNesting
                  ? t('preflight.purchase.hideNesting')
                  : t('preflight.purchase.showNesting')}
              </Button>
            </div>

            {showNesting && <NestingSolution plans={buyable} />}

            {priority === 'waste-removal' && overLimitPieces > 0 && (
              <p className="text-xs text-amber-300">
                {t('preflight.purchase.overLimit', {
                  count: overLimitPieces,
                  limit: wasteLimitKg,
                })}
              </p>
            )}

            {priority !== 'length' && totalWasteKg == null && (
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
          </>
        )}
      </div>
    </Dialog>
  )
}

function NestingSolution({ plans }: { plans: PurchasePlan[] }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
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
                      <span>
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
                        <BarStrip bar={bar} />
                        <div className="flex flex-wrap justify-between gap-2 text-[10px] text-muted-foreground">
                          <span className="font-mono">
                            {bar.units.length > 0
                              ? bar.units
                                  .map((unit) => `${unit.mark} ${metres(unit.lengthMm, 2)}`)
                                  .join(' · ')
                              : t('preflight.purchase.nestingEmpty')}
                          </span>
                          <span className="font-mono">
                            {t('preflight.purchase.nestingWaste', {
                              length: metres(bar.wasteMm, 2),
                              weight: kilograms(kgPerMm == null ? null : bar.wasteMm * kgPerMm),
                            })}
                          </span>
                        </div>
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

function BarStrip({ bar }: { bar: PurchaseBar }) {
  const total = bar.stockLengthMm
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
            className="absolute inset-y-0 flex items-center overflow-hidden border-r border-background/70 bg-primary/30 px-1"
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
          }}
          className="absolute inset-y-0 flex items-center justify-end overflow-hidden bg-amber-500/20 px-1 text-[9px] text-amber-200"
        >
          <span className="truncate">{metres(bar.wasteMm, 2)}</span>
        </div>
      )}
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
