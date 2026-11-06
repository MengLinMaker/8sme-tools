/**
 * Stock purchasing: nest a profile's piece lengths into the standard lengths an Australian
 * supplier keeps on the rack, minimising the total length bought (and therefore the offcut).
 *
 * This is the cutting-stock problem with a small set of available bar lengths. The exact optimum
 * is NP-hard, so we run first-fit-decreasing for every candidate bar length, shrink each packed
 * bar to the shortest stock that still fits it, and keep the plan that buys the least material.
 * That is fast enough for a whole section (10,000 pieces is ~0.1 s) and is the unit of work:
 * sections are independent, so they can be solved in parallel.
 *
 * For a T profile the stock is the parent UB: one purchased beam yields two independent T bars,
 * so packed bars are paired before choosing the stock length.
 */

import { MACHINE } from '@/lib/machine/profile'

/** Standard Australian structural-steel stock lengths stocked by Surdex. */
export const AU_STOCK_LENGTHS_MM = [9000, 10500, 12000, 13500, 15000, 16500, 18000, 20000] as const

/**
 * Default selection: lengths the KL-90010-T can take in a single pass. Longer bars are still
 * offered, but the operator must cut them down before loading.
 */
export const DEFAULT_STOCK_LENGTHS_MM = AU_STOCK_LENGTHS_MM.filter(
  (length) => length <= MACHINE.envelope.maxLengthMm,
)

/** Room left at the end of every bar for the chuck, end trim and cut error. */
export const DEFAULT_CHUCK_MARGIN_MM = 150

/**
 * A stock length longer than the machine's single pass is cut in half before loading, so each
 * half is chucked separately and the allowance is reserved twice.
 */
export function marginForStockLength(stockLengthMm: number, marginMm: number): number {
  return stockLengthMm > MACHINE.envelope.maxLengthMm ? marginMm * 2 : marginMm
}

/** Usable length left after the chuck / error allowance for this stock length. */
export function usableStockLengthMm(stockLengthMm: number, marginMm: number): number {
  return stockLengthMm - marginForStockLength(stockLengthMm, marginMm)
}

export interface PurchasePieceInput {
  mark: string
  lengthMm: number
  quantity: number
}

export interface PurchaseGroupInput {
  /** Stable identity (e.g. the stock profile code). */
  key: string
  /** Profile to buy: the parent UB for a T group, otherwise the part profile. */
  stock: string
  /** Part profiles rolled into this stock (a T group can merge several BT codes). */
  sources: string[]
  /** A T group: each purchased beam yields two independent T bars. */
  tee: boolean
  /**
   * Section mass in kg/m. For a T group this is the **parent UB** mass; each T bar weighs half.
   * Used for the offcut-weight and carry metrics.
   */
  massPerMetre?: number | null
  pieces: PurchasePieceInput[]
}

/** Default weight one person can carry (kg). */
export const DEFAULT_ONE_PERSON_KG = 25

/** Default weight two people can carry (kg). */
export const DEFAULT_TWO_PERSON_KG = 50

/** Offcuts shorter than this are treated as bin waste, not reusable stock. */
export const REUSABLE_OFFCUT_MM = 2000

export interface PurchaseOptions {
  /** Bars the supplier keeps, in mm. */
  stockLengthsMm: readonly number[]
  /** Reserved at one end of every bar for the chuck and cut error (mm). */
  marginMm: number
  /** Material lost between adjacent pieces (mm). */
  kerfMm?: number
  /** Weight one person should lift when classifying offcuts (kg). */
  onePersonKg?: number
  /** Weight two people should lift when classifying offcuts (kg). */
  twoPersonKg?: number
}

export interface PurchaseUnit {
  mark: string
  lengthMm: number
}

export interface PurchaseBar {
  stockLengthMm: number
  units: PurchaseUnit[]
  usedMm: number
  /** Stock length minus the pieces on this bar (includes the reserved margin). */
  wasteMm: number
}

export interface PurchaseQuantity {
  lengthMm: number
  count: number
}

export interface PurchasePlan {
  key: string
  stock: string
  sources: string[]
  tee: boolean
  pieceCount: number
  requiredMm: number
  bars: PurchaseBar[]
  purchases: PurchaseQuantity[]
  purchasedMm: number
  /** Weight of the stock to buy (kg), for payload / storage planning. */
  purchasedKg: number | null
  wasteMm: number

  /** Total offcut weight, or null when the section mass is unknown. */
  wasteKg: number | null
  /** Offcuts shorter than `REUSABLE_OFFCUT_MM` (they go in the bin, not the rack). */
  binWasteMm: number
  binWasteKg: number | null
  /** Offcuts long enough to keep as reusable stock. */
  reusableOffcutMm: number
  reusableOffcutKg: number | null
  /** Offcuts one person can lift. */
  carryOnePieces: number | null
  /** Offcuts that need two people. */
  carryTwoPieces: number | null
  /** Offcuts that need lifting equipment. */
  overTwoPieces: number | null
  utilisation: number
  oversized: PurchaseUnit[]
}

interface DraftBar {
  units: PurchaseUnit[]
  usedMm: number
}

function expandPieces(pieces: PurchasePieceInput[]): PurchaseUnit[] {
  const units: PurchaseUnit[] = []
  for (const piece of pieces) {
    const quantity = Math.floor(piece.quantity)
    if (piece.lengthMm <= 0 || quantity <= 0) continue
    for (let i = 0; i < quantity; i++) {
      units.push({ mark: piece.mark, lengthMm: piece.lengthMm })
    }
  }
  return units.sort((a, b) => b.lengthMm - a.lengthMm)
}

/** First-fit decreasing into fixed-length bars; `null` when a piece is too long for this bar. */
function packFixed(
  units: PurchaseUnit[],
  stockLengthMm: number,
  marginMm: number,
  kerfMm: number,
): DraftBar[] | null {
  const capacity = usableStockLengthMm(stockLengthMm, marginMm)
  if (capacity <= 0) return null
  const bars: DraftBar[] = []

  for (const unit of units) {
    if (unit.lengthMm > capacity) return null
    let best = -1
    let bestFree = Number.POSITIVE_INFINITY
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]
      const gap = bar.units.length > 0 ? kerfMm : 0
      const free = capacity - bar.usedMm - gap - unit.lengthMm
      if (free >= 0 && free < bestFree) {
        bestFree = free
        best = i
      }
    }
    if (best >= 0) {
      const bar = bars[best]
      bar.usedMm += (bar.units.length > 0 ? kerfMm : 0) + unit.lengthMm
      bar.units.push(unit)
    } else {
      bars.push({ units: [unit], usedMm: unit.lengthMm })
    }
  }
  return bars
}

/** Shortest available bar that still fits `usedMm` with the margin reserved. */
function stockFor(usedMm: number, lengths: number[], marginMm: number): number | null {
  for (const length of lengths) {
    if (usableStockLengthMm(length, marginMm) >= usedMm) return length
  }
  return null
}

function quantityList(counts: Map<number, number>): PurchaseQuantity[] {
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lengthMm, count]) => ({ lengthMm, count }))
}

interface PackedPlan {
  bars: PurchaseBar[]
  purchases: PurchaseQuantity[]
  purchasedMm: number
}

function finalizeLinear(
  drafts: DraftBar[],
  lengths: number[],
  marginMm: number,
): PackedPlan | null {
  const bars: PurchaseBar[] = []
  const counts = new Map<number, number>()
  let purchasedMm = 0

  for (const draft of drafts) {
    const stockLengthMm = stockFor(draft.usedMm, lengths, marginMm)
    if (stockLengthMm == null) return null
    bars.push({
      stockLengthMm,
      units: draft.units,
      usedMm: draft.usedMm,
      wasteMm: stockLengthMm - draft.usedMm,
    })
    counts.set(stockLengthMm, (counts.get(stockLengthMm) ?? 0) + 1)
    purchasedMm += stockLengthMm
  }

  return { bars, purchases: quantityList(counts), purchasedMm }
}

function finalizeTee(drafts: DraftBar[], lengths: number[], marginMm: number): PackedPlan | null {
  // Largest bars first: pairing the two biggest minimises the sum of the pair maxima.
  const sorted = [...drafts].sort((a, b) => b.usedMm - a.usedMm)
  const bars: PurchaseBar[] = []
  const counts = new Map<number, number>()
  let purchasedMm = 0

  for (let i = 0; i < sorted.length; i += 2) {
    const left = sorted[i]
    const right = sorted[i + 1] as DraftBar | undefined
    const stockLengthMm = stockFor(Math.max(left.usedMm, right?.usedMm ?? 0), lengths, marginMm)
    if (stockLengthMm == null) return null
    counts.set(stockLengthMm, (counts.get(stockLengthMm) ?? 0) + 1)
    purchasedMm += stockLengthMm
    bars.push({
      stockLengthMm,
      units: left.units,
      usedMm: left.usedMm,
      wasteMm: stockLengthMm - left.usedMm,
    })
    if (right) {
      bars.push({
        stockLengthMm,
        units: right.units,
        usedMm: right.usedMm,
        wasteMm: stockLengthMm - right.usedMm,
      })
    } else {
      bars.push({ stockLengthMm, units: [], usedMm: 0, wasteMm: stockLengthMm })
    }
  }

  return { bars, purchases: quantityList(counts), purchasedMm }
}

function massFactor(group: PurchaseGroupInput): number {
  return group.tee ? 0.5 : 1
}

interface CarryCounts {
  one: number
  two: number
  over: number
}

function planCarryCounts(
  plan: PackedPlan,
  group: PurchaseGroupInput,
  onePersonKg: number,
  twoPersonKg: number,
): CarryCounts | null {
  if (group.massPerMetre == null) return null
  const kgPerMm = (group.massPerMetre / 1000) * massFactor(group)
  const counts: CarryCounts = { one: 0, two: 0, over: 0 }
  for (const bar of plan.bars) {
    const kg = bar.wasteMm * kgPerMm
    if (kg <= 0) continue
    if (kg <= onePersonKg) counts.one++
    else if (kg <= twoPersonKg) counts.two++
    else counts.over++
  }
  return counts
}

function lengthBetter(candidate: PackedPlan, current: PackedPlan): boolean {
  if (candidate.purchasedMm !== current.purchasedMm) {
    return candidate.purchasedMm < current.purchasedMm
  }
  const candidateBars = candidate.bars.filter((bar) => bar.units.length > 0).length
  const currentBars = current.bars.filter((bar) => bar.units.length > 0).length
  if (candidateBars !== currentBars) return candidateBars < currentBars
  const candidateStock = candidate.purchases.reduce((sum, item) => sum + item.count, 0)
  const currentStock = current.purchases.reduce((sum, item) => sum + item.count, 0)
  return candidateStock < currentStock
}

export function planPurchase(group: PurchaseGroupInput, options: PurchaseOptions): PurchasePlan {
  const lengths = [...new Set(options.stockLengthsMm)]
    .filter((length) => length > 0)
    .sort((a, b) => a - b)
  const marginMm = Math.max(0, options.marginMm)
  const kerfMm = Math.max(0, options.kerfMm ?? 0)
  const units = expandPieces(group.pieces)
  const requiredMm = units.reduce((sum, unit) => sum + unit.lengthMm, 0)

  const maxCapacity =
    lengths.length > 0 ? usableStockLengthMm(lengths[lengths.length - 1], marginMm) : 0
  const oversized = maxCapacity > 0 ? units.filter((unit) => unit.lengthMm > maxCapacity) : units
  const fittable = maxCapacity > 0 ? units.filter((unit) => unit.lengthMm <= maxCapacity) : []

  const onePersonKg = Math.max(0, options.onePersonKg ?? DEFAULT_ONE_PERSON_KG)
  const twoPersonKg = Math.max(onePersonKg, options.twoPersonKg ?? DEFAULT_TWO_PERSON_KG)

  let best: PackedPlan | null = null
  for (const length of lengths) {
    const drafts = packFixed(fittable, length, marginMm, kerfMm)
    if (!drafts) continue
    const packed = group.tee
      ? finalizeTee(drafts, lengths, marginMm)
      : finalizeLinear(drafts, lengths, marginMm)
    if (packed && (!best || lengthBetter(packed, best))) best = packed
  }

  const purchases = best?.purchases ?? []
  const purchasedMm = best?.purchasedMm ?? 0
  const purchasedKg = group.massPerMetre == null ? null : (purchasedMm / 1000) * group.massPerMetre
  const capacityMm = group.tee ? purchasedMm * 2 : purchasedMm
  const oversizedMm = oversized.reduce((sum, unit) => sum + unit.lengthMm, 0)
  const coveredMm = Math.max(0, requiredMm - oversizedMm)
  const wasteMm = Math.max(0, capacityMm - coveredMm)
  const wasteKg =
    group.massPerMetre == null ? null : (wasteMm / 1000) * group.massPerMetre * massFactor(group)
  let binWasteMm = 0
  let reusableOffcutMm = 0
  for (const bar of best?.bars ?? []) {
    if (bar.wasteMm <= 0) continue
    if (bar.wasteMm < REUSABLE_OFFCUT_MM) binWasteMm += bar.wasteMm
    else reusableOffcutMm += bar.wasteMm
  }
  const binWasteKg =
    group.massPerMetre == null ? null : (binWasteMm / 1000) * group.massPerMetre * massFactor(group)
  const reusableOffcutKg =
    group.massPerMetre == null
      ? null
      : (reusableOffcutMm / 1000) * group.massPerMetre * massFactor(group)
  const carryCounts = best ? planCarryCounts(best, group, onePersonKg, twoPersonKg) : null

  return {
    key: group.key,
    stock: group.stock,
    sources: group.sources,
    tee: group.tee,
    pieceCount: units.length,
    requiredMm,
    bars: best?.bars ?? [],
    purchases,
    purchasedMm,
    purchasedKg,
    wasteMm,
    wasteKg,
    binWasteMm,
    binWasteKg,
    reusableOffcutMm,
    reusableOffcutKg,
    carryOnePieces: carryCounts?.one ?? null,
    carryTwoPieces: carryCounts?.two ?? null,
    overTwoPieces: carryCounts?.over ?? null,
    utilisation: capacityMm > 0 ? coveredMm / capacityMm : 0,
    oversized,
  }
}

export function planPurchases(
  groups: PurchaseGroupInput[],
  options: PurchaseOptions,
): PurchasePlan[] {
  return groups.map((group) => planPurchase(group, options))
}

/** Total length bought across plans (not doubled for T groups). */
export function totalPurchasedMm(plans: PurchasePlan[]): number {
  return plans.reduce((sum, plan) => sum + plan.purchasedMm, 0)
}

/** Total usable length across plans (a T beam supplies two bars). */
export function totalCapacityMm(plans: PurchasePlan[]): number {
  return plans.reduce((sum, plan) => sum + (plan.tee ? plan.purchasedMm * 2 : plan.purchasedMm), 0)
}

export function totalRequiredMm(plans: PurchasePlan[]): number {
  return plans.reduce((sum, plan) => sum + plan.requiredMm, 0)
}

export function totalWasteMm(plans: PurchasePlan[]): number {
  return plans.reduce((sum, plan) => sum + plan.wasteMm, 0)
}
