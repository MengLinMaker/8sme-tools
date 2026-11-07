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
/** Shop practice: do not suggest using a substitute scrap longer than this. */
const MAX_SUBSTITUTE_SCRAP_MM = 6000
/** A substitute scrap should also be less than half of the beam length. */
const maxSubstituteScrapMm = (stockLengthMm: number) =>
  Math.min(MAX_SUBSTITUTE_SCRAP_MM, stockLengthMm * 0.5)

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

interface ScrapSuggestion {
  key: string
  stock: string
  stockLengthMm: number
  beamIndex: number
  lengthMm: number
  offcutMm: number
  unitsKey: string
}

interface AppliedScrap extends ScrapSuggestion {
  settingsKey: string
}

interface SuggestionRow {
  id: string
  type: 'stock' | 'scrap'
  applied: boolean
  key: string
  stock: string
  lengthMm: number
  stockLengthMm?: number
  offcutMm?: number
  suggestion?: ScrapSuggestion
}

interface AppliedStockSuggestion {
  key: string
  stock: string
  lengthMm: number
}

interface ScrapOptions {
  marginMm: number
  reusableOffcutMm: number
  onePersonKg: number
  twoPersonKg: number
}

function barUnitsKey(bar: PurchaseBar): string {
  return bar.units.map((unit) => `${unit.mark}@${unit.lengthMm}`).join(',')
}

function barsUnitsKey(bars: PurchaseBar[]): string {
  return bars.map(barUnitsKey).join(';')
}

function barLastStartMm(bar: PurchaseBar): number {
  const last = bar.units.at(-1)
  return last ? bar.usedMm - last.lengthMm : 0
}

function substituteScrapLengthMm(usedMm: number, lastStartMm: number, marginMm: number): number {
  return Math.max(usedMm + marginMm, lastStartMm + MACHINE.minEndSupportMm + 1)
}

function suggestScrapForPlan(plan: PurchasePlan, options: ScrapOptions): ScrapSuggestion | null {
  let bestWaste = -1
  let best: ScrapSuggestion | null = null
  if (plan.tee) {
    for (let i = 0; i < plan.bars.length; i += 2) {
      const left = plan.bars[i]
      const right = plan.bars[i + 1]
      if (left.scrap || right?.scrap) continue
      const waste = Math.max(left.wasteMm, right?.wasteMm ?? 0)
      if (waste < options.reusableOffcutMm) continue
      const usedMm = Math.max(left.usedMm, right?.usedMm ?? 0)
      const lastStartMm = Math.max(barLastStartMm(left), right ? barLastStartMm(right) : 0)
      const lengthMm = substituteScrapLengthMm(usedMm, lastStartMm, options.marginMm)
      if (lengthMm > maxSubstituteScrapMm(left.stockLengthMm)) continue
      if (waste > bestWaste) {
        bestWaste = waste
        best = {
          key: plan.key,
          stock: plan.stock,
          stockLengthMm: left.stockLengthMm,
          beamIndex: i / 2,
          lengthMm,
          offcutMm: waste,
          unitsKey: barsUnitsKey(right ? [left, right] : [left]),
        }
      }
    }
  } else {
    for (const [index, bar] of plan.bars.entries()) {
      if (bar.scrap || bar.wasteMm < options.reusableOffcutMm) continue
      const lengthMm = substituteScrapLengthMm(bar.usedMm, barLastStartMm(bar), options.marginMm)
      if (lengthMm > maxSubstituteScrapMm(bar.stockLengthMm)) continue
      if (bar.wasteMm > bestWaste) {
        bestWaste = bar.wasteMm
        best = {
          key: plan.key,
          stock: plan.stock,
          stockLengthMm: bar.stockLengthMm,
          beamIndex: index,
          lengthMm,
          offcutMm: bar.wasteMm,
          unitsKey: barUnitsKey(bar),
        }
      }
    }
  }
  return best
}

function scrapSuggestionMatchesPlan(
  plan: PurchasePlan | undefined,
  applied: ScrapSuggestion,
): boolean {
  if (!plan) return false
  if (plan.tee) {
    const left = plan.bars[applied.beamIndex * 2]
    const right = plan.bars[applied.beamIndex * 2 + 1]
    return Boolean(
      left &&
        right &&
        left.stockLengthMm === applied.stockLengthMm &&
        right.stockLengthMm === applied.stockLengthMm &&
        barsUnitsKey([left, right]) === applied.unitsKey,
    )
  }
  const bar = plan.bars[applied.beamIndex]
  return Boolean(
    bar && bar.stockLengthMm === applied.stockLengthMm && barUnitsKey(bar) === applied.unitsKey,
  )
}

function summarizeAdjustedPlan(
  plan: PurchasePlan,
  bars: PurchaseBar[],
  group: PurchaseGroupInput,
  options: ScrapOptions,
): PurchasePlan {
  const massFactor = group.tee ? 0.5 : 1
  const kgPerMm = group.massPerMetre == null ? null : (group.massPerMetre / 1000) * massFactor
  const counts = new Map<number, number>()
  const purchasedWasteBars: PurchaseBar[] = []
  let purchasedMm = 0
  if (group.tee) {
    for (let i = 0; i < bars.length; i += 2) {
      const left = bars[i]
      const right = bars[i + 1]
      if (!left || left.scrap || right?.scrap) continue
      counts.set(left.stockLengthMm, (counts.get(left.stockLengthMm) ?? 0) + 1)
      purchasedMm += left.stockLengthMm
      purchasedWasteBars.push(left)
      if (right) purchasedWasteBars.push(right)
    }
  } else {
    for (const bar of bars) {
      if (bar.scrap) continue
      counts.set(bar.stockLengthMm, (counts.get(bar.stockLengthMm) ?? 0) + 1)
      purchasedMm += bar.stockLengthMm
      purchasedWasteBars.push(bar)
    }
  }
  const purchases = [...counts.entries()]
    .map(([lengthMm, count]) => ({ lengthMm, count }))
    .sort((a, b) => a.lengthMm - b.lengthMm)
  const purchasedKg = group.massPerMetre == null ? null : (purchasedMm / 1000) * group.massPerMetre
  const purchasedWasteMm = purchasedWasteBars.reduce((sum, bar) => sum + bar.wasteMm, 0)
  const capacityMm = group.tee ? purchasedMm * 2 : purchasedMm
  const coveredPurchasedMm = Math.max(0, capacityMm - purchasedWasteMm)
  const wasteMm = bars.reduce((sum, bar) => sum + bar.wasteMm, 0)
  const wasteKg =
    group.massPerMetre == null ? null : (wasteMm / 1000) * group.massPerMetre * massFactor
  let binWasteMm = 0
  let reusableOffcutMm = 0
  let carryOnePieces = 0
  let carryTwoPieces = 0
  let overTwoPieces = 0
  for (const bar of bars) {
    if (bar.wasteMm <= 0) continue
    if (bar.wasteMm < options.reusableOffcutMm) binWasteMm += bar.wasteMm
    else reusableOffcutMm += bar.wasteMm
    if (kgPerMm != null) {
      const kg = bar.wasteMm * kgPerMm
      if (kg <= options.onePersonKg) carryOnePieces++
      else if (kg <= options.twoPersonKg) carryTwoPieces++
      else overTwoPieces++
    }
  }
  const binWasteKg =
    group.massPerMetre == null ? null : (binWasteMm / 1000) * group.massPerMetre * massFactor
  const reusableOffcutKg =
    group.massPerMetre == null ? null : (reusableOffcutMm / 1000) * group.massPerMetre * massFactor
  let loadingOnePersonMoves = 0
  let loadingTwoPersonMoves = 0
  let loadingEquipmentMoves = 0
  for (const item of purchases) {
    if (item.lengthMm > MACHINE_MAX_MM) {
      loadingEquipmentMoves += item.count * 2
      continue
    }
    const weightKg = group.massPerMetre == null ? null : (item.lengthMm / 1000) * group.massPerMetre
    if (weightKg != null && weightKg > options.twoPersonKg) {
      loadingEquipmentMoves += item.count
    } else if (weightKg == null || weightKg > options.onePersonKg) {
      loadingTwoPersonMoves += item.count
    } else {
      loadingOnePersonMoves += item.count
    }
  }
  if (group.tee) {
    for (let i = 0; i < bars.length; i += 2) {
      if (bars[i]?.scrap || bars[i + 1]?.scrap) loadingEquipmentMoves++
    }
  } else {
    for (const bar of bars) {
      if (bar.scrap) loadingEquipmentMoves++
    }
  }
  return {
    ...plan,
    bars,
    purchases,
    purchasedMm,
    purchasedKg,
    wasteMm,
    wasteKg,
    binWasteMm,
    binWasteKg,
    reusableOffcutMm,
    reusableOffcutKg,
    carryOnePieces: kgPerMm == null ? null : carryOnePieces,
    carryTwoPieces: kgPerMm == null ? null : carryTwoPieces,
    overTwoPieces: kgPerMm == null ? null : overTwoPieces,
    reusableOffcuts: bars.filter((bar) => bar.wasteMm >= options.reusableOffcutMm).length,
    invalidSupportBars: bars.filter((bar) => !bar.supportOk).length,
    loadingOnePersonMoves,
    loadingTwoPersonMoves,
    loadingEquipmentMoves,
    utilisation: capacityMm > 0 ? coveredPurchasedMm / capacityMm : 0,
  }
}

function applyScrapToPlan(
  plan: PurchasePlan,
  suggestion: ScrapSuggestion,
  group: PurchaseGroupInput,
  options: ScrapOptions,
): PurchasePlan {
  const bars = plan.bars.map((bar) => ({ ...bar, units: [...bar.units] }))
  const indices = plan.tee
    ? [suggestion.beamIndex * 2, suggestion.beamIndex * 2 + 1]
    : [suggestion.beamIndex]
  for (const index of indices) {
    const bar = bars[index]
    if (!bar) continue
    const last = bar.units.at(-1)
    bars[index] = {
      ...bar,
      stockLengthMm: suggestion.lengthMm,
      wasteMm: Math.max(0, suggestion.lengthMm - bar.usedMm),
      supportOk:
        !last || bar.usedMm - last.lengthMm < suggestion.lengthMm - MACHINE.minEndSupportMm,
      scrap: true,
    }
  }
  return summarizeAdjustedPlan(plan, bars, group, options)
}

export function PurchaseDialog({ open, onClose, groups, jobName }: PurchaseDialogProps) {
  const { t } = useTranslation()
  const [marginMm, setMarginMm] = useState(DEFAULT_CHUCK_MARGIN_MM)
  const [stockLengthsMm, setStockLengthsMm] = useState<number[]>([...DEFAULT_STOCK_LENGTHS_MM])
  const [onePersonKg, setOnePersonKg] = useState(DEFAULT_ONE_PERSON_KG)
  const [twoPersonKg, setTwoPersonKg] = useState(DEFAULT_TWO_PERSON_KG)
  const [reusableOffcutMm, setReusableOffcutMm] = useState(REUSABLE_OFFCUT_MM)
  const [appliedScraps, setAppliedScraps] = useState<AppliedScrap[]>([])
  const [appliedStockSuggestions, setAppliedStockSuggestions] = useState<AppliedStockSuggestion[]>(
    [],
  )

  const plans = useMemo(
    () =>
      stockLengthsMm.length === 0
        ? []
        : planPurchases(groups, {
            stockLengthsMm,
            marginMm: Math.max(0, marginMm),
            onePersonKg,
            twoPersonKg,
            reusableOffcutMm: Math.max(0, reusableOffcutMm),
          }),
    [groups, marginMm, onePersonKg, reusableOffcutMm, stockLengthsMm, twoPersonKg],
  )

  const groupsByKey = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups])
  const settingsKey = useMemo(
    () => `${marginMm}|${reusableOffcutMm}|${onePersonKg}|${twoPersonKg}`,
    [marginMm, onePersonKg, reusableOffcutMm, twoPersonKg],
  )
  const activeAppliedScraps = useMemo(() => {
    const plansByKey = new Map(plans.map((plan) => [plan.key, plan]))
    return appliedScraps.filter(
      (applied) =>
        applied.settingsKey === settingsKey &&
        scrapSuggestionMatchesPlan(plansByKey.get(applied.key), applied),
    )
  }, [appliedScraps, plans, settingsKey])
  const appliedScrapKeys = useMemo(
    () => new Set(activeAppliedScraps.map((applied) => applied.key)),
    [activeAppliedScraps],
  )
  const activeAppliedStockSuggestions = useMemo(
    () => appliedStockSuggestions.filter((applied) => stockLengthsMm.includes(applied.lengthMm)),
    [appliedStockSuggestions, stockLengthsMm],
  )
  const appliedStockKeys = useMemo(
    () => new Set(activeAppliedStockSuggestions.map((applied) => applied.key)),
    [activeAppliedStockSuggestions],
  )
  const scrapOptions = useMemo(
    () => ({
      marginMm: Math.max(0, marginMm),
      reusableOffcutMm: Math.max(0, reusableOffcutMm),
      onePersonKg,
      twoPersonKg,
    }),
    [marginMm, onePersonKg, reusableOffcutMm, twoPersonKg],
  )
  const displayPlans = useMemo(
    () =>
      plans.map((plan) => {
        const applied = activeAppliedScraps.find((item) => item.key === plan.key)
        const group = groupsByKey.get(plan.key)
        if (!applied || !group) return plan
        return applyScrapToPlan(plan, applied, group, scrapOptions)
      }),
    [activeAppliedScraps, groupsByKey, plans, scrapOptions],
  )

  const buyable = displayPlans.filter((plan) => plan.pieceCount > 0)
  const totalPurchasedKg = displayPlans.every((plan) => plan.purchasedKg != null)
    ? displayPlans.reduce((sum, plan) => sum + (plan.purchasedKg ?? 0), 0)
    : null
  const totalWasteKg = displayPlans.every((plan) => plan.wasteKg != null)
    ? displayPlans.reduce((sum, plan) => sum + (plan.wasteKg ?? 0), 0)
    : null
  const totalBinWasteKg = displayPlans.every((plan) => plan.binWasteKg != null)
    ? displayPlans.reduce((sum, plan) => sum + (plan.binWasteKg ?? 0), 0)
    : null
  const minChuckMm = useMemo(() => {
    const wastes = displayPlans.flatMap((plan) => plan.bars.map((bar) => bar.wasteMm))
    return wastes.length > 0 ? Math.min(...wastes) : null
  }, [displayPlans])
  const totalCarryOne = displayPlans.every((plan) => plan.carryOnePieces != null)
    ? displayPlans.reduce((sum, plan) => sum + (plan.carryOnePieces ?? 0), 0)
    : null
  const totalCarryTwo = displayPlans.every((plan) => plan.carryTwoPieces != null)
    ? displayPlans.reduce((sum, plan) => sum + (plan.carryTwoPieces ?? 0), 0)
    : null
  const totalOverTwo = displayPlans.every((plan) => plan.overTwoPieces != null)
    ? displayPlans.reduce((sum, plan) => sum + (plan.overTwoPieces ?? 0), 0)
    : null
  const invalidSupportBars = displayPlans.reduce((sum, plan) => sum + plan.invalidSupportBars, 0)
  const totalLoadingOne = displayPlans.reduce((sum, plan) => sum + plan.loadingOnePersonMoves, 0)
  const totalLoadingTwo = displayPlans.reduce((sum, plan) => sum + plan.loadingTwoPersonMoves, 0)
  const totalLoadingEquipment = displayPlans.reduce(
    (sum, plan) => sum + plan.loadingEquipmentMoves,
    0,
  )
  const oversized = displayPlans.flatMap((plan) => plan.oversized)
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
    for (const plan of displayPlans) {
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
  }, [displayPlans])

  const largerStockSuggestions = useMemo(() => {
    const map = new Map<string, number>()
    if (stockLengthsMm.length === 0) return map
    const selectedMax = Math.max(...stockLengthsMm)
    const selected = new Set(stockLengthsMm)
    for (const group of groups) {
      if (appliedScrapKeys.has(group.key) || appliedStockKeys.has(group.key)) continue
      const current = plans.find((plan) => plan.key === group.key)
      if (!current || current.reusableOffcuts === 0) continue
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
          reusableOffcutMm: Math.max(0, reusableOffcutMm),
        })
        if (alt.reusableOffcuts !== 0 || !alt.purchases.some((item) => item.lengthMm === length)) {
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
  }, [
    appliedScrapKeys,
    appliedStockKeys,
    groups,
    marginMm,
    onePersonKg,
    plans,
    reusableOffcutMm,
    stockLengthsMm,
    twoPersonKg,
  ])

  const scrapSuggestions = useMemo(() => {
    const map = new Map<string, ScrapSuggestion>()
    for (const plan of plans) {
      if (appliedScrapKeys.has(plan.key)) continue
      const suggestion = suggestScrapForPlan(plan, scrapOptions)
      if (suggestion) map.set(plan.key, suggestion)
    }
    return map
  }, [appliedScrapKeys, plans, scrapOptions])

  const suggestionRows = useMemo(() => {
    const rows: SuggestionRow[] = []
    const appliedStockByKey = new Map(
      activeAppliedStockSuggestions.map((applied) => [applied.key, applied]),
    )
    const stockKeys = new Set([...largerStockSuggestions.keys(), ...appliedStockByKey.keys()])
    for (const key of stockKeys) {
      const applied = appliedStockByKey.get(key)
      const group = groupsByKey.get(key)
      const lengthMm = applied?.lengthMm ?? largerStockSuggestions.get(key)
      const stock = applied?.stock ?? group?.stock
      if (lengthMm == null || stock == null) continue
      rows.push({
        id: `stock:${key}`,
        type: 'stock',
        applied: Boolean(applied),
        key,
        stock,
        lengthMm,
      })
    }

    const appliedScrapByKey = new Map(activeAppliedScraps.map((applied) => [applied.key, applied]))
    const scrapKeys = new Set([...scrapSuggestions.keys(), ...appliedScrapByKey.keys()])
    for (const key of scrapKeys) {
      const applied = appliedScrapByKey.get(key)
      const suggestion = applied ?? scrapSuggestions.get(key)
      if (!suggestion) continue
      rows.push({
        id: `scrap:${key}`,
        type: 'scrap',
        applied: Boolean(applied),
        key,
        stock: suggestion.stock,
        lengthMm: suggestion.lengthMm,
        stockLengthMm: suggestion.stockLengthMm,
        offcutMm: suggestion.offcutMm,
        suggestion,
      })
    }
    return rows.sort((a, b) => a.stock.localeCompare(b.stock) || a.type.localeCompare(b.type))
  }, [
    activeAppliedScraps,
    activeAppliedStockSuggestions,
    groupsByKey,
    largerStockSuggestions,
    scrapSuggestions,
  ])

  const nestingPriorityKeys = useMemo(
    () =>
      new Set([
        ...largerStockSuggestions.keys(),
        ...scrapSuggestions.keys(),
        ...activeAppliedScraps.map((applied) => applied.key),
        ...activeAppliedStockSuggestions.map((applied) => applied.key),
      ]),
    [activeAppliedScraps, activeAppliedStockSuggestions, largerStockSuggestions, scrapSuggestions],
  )

  const applyStockSuggestion = (row: SuggestionRow) => {
    setStockLengthsMm((current) =>
      current.includes(row.lengthMm) ? current : [...current, row.lengthMm].sort((a, b) => a - b),
    )
    setAppliedStockSuggestions((current) => [
      ...current.filter((item) => item.key !== row.key),
      { key: row.key, stock: row.stock, lengthMm: row.lengthMm },
    ])
  }

  const undoStockSuggestion = (key: string) => {
    const applied = appliedStockSuggestions.find((item) => item.key === key)
    if (!applied) return
    const remaining = appliedStockSuggestions.filter((item) => item.key !== key)
    setAppliedStockSuggestions(remaining)
    if (!remaining.some((item) => item.lengthMm === applied.lengthMm)) {
      setStockLengthsMm((current) => current.filter((length) => length !== applied.lengthMm))
    }
  }

  const applyScrapSuggestion = (suggestion: ScrapSuggestion) => {
    setAppliedScraps((current) => [
      ...current.filter((item) => item.key !== suggestion.key),
      { ...suggestion, settingsKey },
    ])
  }

  const undoScrapSuggestion = (key: string) => {
    setAppliedScraps((current) => current.filter((item) => item.key !== key))
  }

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
                reusableOffcutMm={reusableOffcutMm}
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
                  {t('preflight.purchase.reusableFrom')}
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={reusableOffcutMm}
                    onChange={(event) => {
                      const value = Number(event.target.value) || 0
                      setReusableOffcutMm(value)
                    }}
                    className="h-8 w-24 rounded-md border border-input bg-transparent px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span className="text-xs text-muted-foreground">mm</span>
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

            <SuggestionsTable
              rows={suggestionRows}
              onApplyStock={applyStockSuggestion}
              onUndoStock={undoStockSuggestion}
              onApplyScrap={applyScrapSuggestion}
              onUndoScrap={undoScrapSuggestion}
            />

            <BuyList rows={buyRows} jobName={jobName} />

            <div className="text-sm font-medium">{t('preflight.purchase.nestingTitle')}</div>

            <NestingSolution
              plans={buyable}
              onePersonKg={onePersonKg}
              twoPersonKg={twoPersonKg}
              marginMm={marginMm}
              reusableOffcutMm={reusableOffcutMm}
              stockSuggestions={largerStockSuggestions}
              scrapSuggestions={scrapSuggestions}
              priorityKeys={nestingPriorityKeys}
            />
          </>
        )}
      </div>
    </Dialog>
  )
}

function SuggestionsTable({
  rows,
  onApplyStock,
  onUndoStock,
  onApplyScrap,
  onUndoScrap,
}: {
  rows: SuggestionRow[]
  onApplyStock: (row: SuggestionRow) => void
  onUndoStock: (key: string) => void
  onApplyScrap: (suggestion: ScrapSuggestion) => void
  onUndoScrap: (key: string) => void
}) {
  const { t } = useTranslation()
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium">{t('preflight.purchase.suggestionsTitle')}</div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('preflight.purchase.section')}</TableHead>
              <TableHead>{t('preflight.purchase.suggestion')}</TableHead>
              <TableHead className="w-20 text-right">{t('preflight.purchase.action')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const suggestion = row.suggestion
              return (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.stock}</TableCell>
                  <TableCell className={row.applied ? 'text-xs text-emerald-300' : 'text-xs'}>
                    {row.type === 'stock' ? (
                      t('preflight.purchase.suggestionStock', {
                        length: metres(row.lengthMm, row.lengthMm % 1000 === 0 ? 0 : 1),
                      })
                    ) : (
                      <>
                        {t('preflight.purchase.suggestionScrap', {
                          scrap: metres(row.lengthMm, 2),
                          stock: metres(row.stockLengthMm ?? 0, 1),
                        })}
                        {row.offcutMm != null && (
                          <>
                            {' '}
                            ·{' '}
                            {t('preflight.purchase.suggestionOffcut', {
                              offcut: metres(row.offcutMm, 2),
                            })}
                          </>
                        )}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="w-20 text-right">
                    {row.applied ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-14"
                        onClick={() =>
                          row.type === 'stock' ? onUndoStock(row.key) : onUndoScrap(row.key)
                        }
                      >
                        {t('preflight.purchase.undo')}
                      </Button>
                    ) : row.type === 'stock' ? (
                      <Button size="sm" className="h-7 w-14" onClick={() => onApplyStock(row)}>
                        {t('preflight.purchase.apply')}
                      </Button>
                    ) : suggestion ? (
                      <Button
                        size="sm"
                        className="h-7 w-14"
                        onClick={() => onApplyScrap(suggestion)}
                      >
                        {t('preflight.purchase.apply')}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
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
  reusableOffcutMm,
  stockSuggestions,
  scrapSuggestions,
  priorityKeys,
}: {
  plans: PurchasePlan[]
  onePersonKg: number
  twoPersonKg: number
  marginMm: number
  reusableOffcutMm: number
  stockSuggestions: Map<string, number>
  scrapSuggestions: Map<string, ScrapSuggestion>
  priorityKeys: Set<string>
}) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<'all' | 'one' | 'two' | 'crane' | 'reusable'>('all')
  const kgPerMmFor = (plan: PurchasePlan) =>
    plan.wasteKg != null && plan.wasteMm > 0 ? plan.wasteKg / plan.wasteMm : null
  const attention = (bars: PurchaseBar[], kgPerMm: number | null) => {
    let priority = 0
    let amount = 0
    for (const bar of bars) {
      if (bar.wasteMm <= 0) continue
      const kg = kgPerMm == null ? 0 : bar.wasteMm * kgPerMm
      if (bar.wasteMm >= reusableOffcutMm) {
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
      (max, bar) => (bar.wasteMm >= reusableOffcutMm ? Math.max(max, bar.wasteMm) : max),
      0,
    )
  const orderedPlans = [...plans].sort((a, b) => {
    const priorityDelta = Number(priorityKeys.has(b.key)) - Number(priorityKeys.has(a.key))
    if (priorityDelta !== 0) return priorityDelta
    return filter === 'reusable'
      ? longestReusable(b.bars) - longestReusable(a.bars)
      : attention(b.bars, kgPerMmFor(b)) - attention(a.bars, kgPerMmFor(a))
  })
  const visiblePlans = orderedPlans.filter((plan) => {
    if (filter === 'all') return true
    if (filter === 'reusable') {
      return plan.bars.some((bar) => bar.wasteMm >= reusableOffcutMm)
    }
    const kgPerMm = kgPerMmFor(plan)
    return plan.bars.some((bar) => {
      if (bar.wasteMm <= 0 || bar.wasteMm >= reusableOffcutMm) return false
      const kg = kgPerMm == null ? 0 : bar.wasteMm * kgPerMm
      if (filter === 'one') return kg <= onePersonKg
      if (filter === 'two') return kg > onePersonKg && kg <= twoPersonKg
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
            {t('preflight.purchase.binLegend', {
              threshold: metres(reusableOffcutMm, 1),
            })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ['all', 'filterAll'],
              ['one', 'onePerson'],
              ['two', 'twoPerson'],
              ['crane', 'equipment'],
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
            if (filter === 'reusable') return bar.wasteMm >= reusableOffcutMm
            if (bar.wasteMm >= reusableOffcutMm) return false
            const kg = kgPerMm == null ? 0 : bar.wasteMm * kgPerMm
            if (filter === 'one') return kg <= onePersonKg
            if (filter === 'two') return kg > onePersonKg && kg <= twoPersonKg
            return kg > twoPersonKg
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
        const stockSuggestion = stockSuggestions.get(plan.key)
        const scrapSuggestion = scrapSuggestions.get(plan.key)
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
                {stockSuggestion != null ? (
                  <span className="whitespace-nowrap rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">
                    {t('preflight.purchase.largerStockSuggestion', {
                      length: metres(stockSuggestion, stockSuggestion % 1000 === 0 ? 0 : 1),
                    })}
                  </span>
                ) : scrapSuggestion != null ? (
                  <span className="whitespace-nowrap rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                    {t('preflight.purchase.substituteBadge', {
                      length: metres(scrapSuggestion.lengthMm, 2),
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
                const isScrap = beam.bars.some((bar) => bar.scrap)
                return (
                  <div key={beamId} className="flex items-start gap-2">
                    <span
                      className={cn(
                        'w-24 shrink-0 pt-1 text-[10px] leading-tight text-muted-foreground',
                        beam.stockLengthMm > MACHINE_MAX_MM && 'text-amber-300',
                        isScrap && 'text-sky-300',
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
                      {isScrap && ` · ${t('preflight.purchase.scrapTag')}`}
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
                              reusableOffcutMm={reusableOffcutMm}
                              showScrapLine={scrapSuggestion?.beamIndex === index}
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
  reusableOffcutMm,
  showScrapLine,
}: {
  bar: PurchaseBar
  kgPerMm: number | null
  onePersonKg: number
  twoPersonKg: number
  marginMm: number
  reusableOffcutMm: number
  showScrapLine: boolean
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
    <div
      className={cn(
        'relative h-6 w-full overflow-hidden rounded border border-border bg-muted/40',
        bar.scrap && 'border-sky-500/60',
      )}
    >
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
              bar.wasteMm < reusableOffcutMm
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
      {showScrapLine && bar.wasteMm >= reusableOffcutMm && (
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
  reusableOffcutMm,
}: {
  purchasedKg: number | null
  wasteKg: number | null
  binKg: number | null
  minChuckMm: number | null
  reusableOffcutMm: number
}) {
  const { t } = useTranslation()
  const rows: [string, string][] = [
    [t('preflight.purchase.totalWeight'), kilograms(purchasedKg)],
    [t('preflight.purchase.wasteWeight'), kilograms(wasteKg)],
    [
      t('preflight.purchase.binWaste', { threshold: metres(reusableOffcutMm, 1) }),
      kilograms(binKg),
    ],
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
