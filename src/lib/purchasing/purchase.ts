/**
 * Stock purchasing: nest a profile's piece lengths into the standard lengths an Australian
 * supplier keeps on the rack, minimising the total length bought (and therefore the offcut).
 *
 * This is the cutting-stock problem with a small set of available bar lengths. The exact optimum
 * is NP-hard, so we combine two searches and keep the plan that buys the least material:
 *
 * - A beam search over small/medium groups (up to 48 pieces). It can open a different stock
 *   length for every beam, so it finds mixed-size plans that a fixed-size pass misses.
 * - First-fit-decreasing for every candidate bar length, then shrink each packed bar to the
 *   shortest stock that still fits it. This is the fast fallback for large jobs.
 *
 * For a T profile the stock is the parent UB: one purchased beam yields two independent T bars,
 * so the search opens two bars together and the purchases are counted per pair.
 */

import { MACHINE } from '@/lib/machine/profile'

/** Standard Australian structural-steel stock lengths (6 m is common retail stock). */
export const AU_STOCK_LENGTHS_MM = [
  6000, 9000, 10500, 12000, 13500, 15000, 16500, 18000, 20000,
] as const

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
   * Used for the offcut-weight metrics and the waste-removal priority.
   */
  massPerMetre?: number | null
  pieces: PurchasePieceInput[]
}

/** What the calculator should minimise when several nestings are possible. */
export type PurchasePriority = 'length' | 'weight' | 'waste-removal'

/** How hard the beam search looks for a better nesting. */
export type PurchaseSearchEffort = 'fast' | 'balanced' | 'thorough'

/** Default hard-ish limit for one offcut that has to be lifted off the machine. */
export const DEFAULT_WASTE_PIECE_KG = 30

/** Offcuts shorter than this are treated as bin waste, not reusable stock. */
export const REUSABLE_OFFCUT_MM = 2000

export interface PurchaseOptions {
  /** Bars the supplier keeps, in mm. */
  stockLengthsMm: readonly number[]
  /** Reserved at one end of every bar for the chuck and cut error (mm). */
  marginMm: number
  /** Material lost between adjacent pieces (mm). */
  kerfMm?: number
  /** Defaults to length wastage. */
  priority?: PurchasePriority
  /** Max weight of one leftover piece when `priority` is `waste-removal` (kg). */
  maxWastePieceKg?: number
  /** Beam-search effort. Defaults to balanced. */
  searchEffort?: PurchaseSearchEffort
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
  wasteMm: number
  /** Total offcut weight, or null when the section mass is unknown. */
  wasteKg: number | null
  /** Offcuts shorter than `REUSABLE_OFFCUT_MM` (they go in the bin, not the rack). */
  binWasteMm: number
  binWasteKg: number | null
  /** Offcuts long enough to keep as reusable stock. */
  reusableOffcutMm: number
  reusableOffcutKg: number | null
  /** Heaviest single offcut piece, or null when the section mass is unknown. */
  maxWastePieceKg: number | null
  /** Offcut pieces heavier than the waste-removal limit. */
  overLimitPieces: number
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

interface BeamBar {
  stockLengthMm: number
  usedMm: number
  units: PurchaseUnit[]
}

interface BeamState {
  bars: BeamBar[]
  purchasedMm: number
}

function beamKey(bars: BeamBar[]): string {
  return bars
    .map((bar) => `${bar.stockLengthMm}:${bar.usedMm}`)
    .sort()
    .join('|')
}

/**
 * Beam search is worth its cost only on the small groups (a handful of marks). Larger jobs use
 * the much faster first-fit plans below; the two are compared and the cheaper one wins.
 */
function beamWidthFor(pieceCount: number, effort: PurchaseSearchEffort): number {
  const widths = {
    fast: { small: 120, medium: 40, large: 0 },
    balanced: { small: 600, medium: 200, large: 0 },
    thorough: { small: 2000, medium: 800, large: 200 },
  }[effort]
  if (pieceCount <= 24) return widths.small
  if (pieceCount <= 48) return widths.medium
  if (effort === 'thorough' && pieceCount <= 72) return widths.large
  return 0
}

function packedFromBeam(state: BeamState, tee: boolean): PackedPlan {
  const counts = new Map<number, number>()
  for (const bar of state.bars) {
    counts.set(bar.stockLengthMm, (counts.get(bar.stockLengthMm) ?? 0) + 1)
  }
  if (tee) {
    for (const [length, count] of counts) counts.set(length, count / 2)
  }
  return {
    bars: state.bars.map((bar) => ({
      stockLengthMm: bar.stockLengthMm,
      units: bar.units,
      usedMm: bar.usedMm,
      wasteMm: bar.stockLengthMm - bar.usedMm,
    })),
    purchases: quantityList(counts),
    purchasedMm: state.purchasedMm,
  }
}

/**
 * Keeps the best few partial packings at each piece. Unlike the fixed-size first-fit pass this
 * may open a different stock length for each beam, which is where the mixed-size savings come
 * from.
 */
function beamSearch(
  units: PurchaseUnit[],
  lengths: number[],
  marginMm: number,
  kerfMm: number,
  tee: boolean,
  effort: PurchaseSearchEffort,
): PackedPlan | null {
  const width = beamWidthFor(units.length, effort)
  if (width <= 0 || units.length === 0 || lengths.length === 0) return null
  const maxCapacity = usableStockLengthMm(lengths[lengths.length - 1], marginMm)
  if (maxCapacity <= 0) return null
  const minStock = lengths[0]
  const factor = tee ? 2 : 1
  const suffix = new Array<number>(units.length + 1).fill(0)
  for (let i = units.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + units[i].lengthMm

  let states: BeamState[] = [{ bars: [], purchasedMm: 0 }]
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]
    const remaining = suffix[i + 1]
    const next = new Map<string, BeamState>()
    const add = (bars: BeamBar[], purchasedMm: number) => {
      const key = beamKey(bars)
      const previous = next.get(key)
      if (!previous || purchasedMm < previous.purchasedMm) next.set(key, { bars, purchasedMm })
    }

    for (const state of states) {
      for (let b = 0; b < state.bars.length; b++) {
        const bar = state.bars[b]
        const gap = bar.units.length > 0 ? kerfMm : 0
        const capacity = usableStockLengthMm(bar.stockLengthMm, marginMm)
        if (bar.usedMm + gap + unit.lengthMm > capacity) continue
        const bars = state.bars.map((item, index) =>
          index === b
            ? { ...item, usedMm: item.usedMm + gap + unit.lengthMm, units: [...item.units, unit] }
            : item,
        )
        add(bars, state.purchasedMm)
      }

      for (const length of lengths) {
        if (usableStockLengthMm(length, marginMm) < unit.lengthMm) continue
        const bars: BeamBar[] = [
          ...state.bars,
          { stockLengthMm: length, usedMm: unit.lengthMm, units: [unit] },
        ]
        if (tee) bars.push({ stockLengthMm: length, usedMm: 0, units: [] })
        add(bars, state.purchasedMm + length)
      }
    }

    const scored: { state: BeamState; score: number }[] = []
    for (const state of next.values()) {
      const free = state.bars.reduce(
        (sum, bar) =>
          sum + Math.max(0, usableStockLengthMm(bar.stockLengthMm, marginMm) - bar.usedMm),
        0,
      )
      const need = Math.max(0, remaining - free)
      const lower =
        need === 0
          ? 0
          : Math.max(need / factor, Math.ceil(need / (factor * maxCapacity)) * minStock)
      scored.push({ state, score: state.purchasedMm + lower })
    }
    scored.sort((a, b) => a.score - b.score)
    states = scored.slice(0, width).map((entry) => entry.state)
  }

  let winner = states[0]
  for (const state of states) {
    if (state.purchasedMm < winner.purchasedMm) winner = state
  }
  return packedFromBeam(winner, tee)
}

function massFactor(group: PurchaseGroupInput): number {
  return group.tee ? 0.5 : 1
}

function planWasteKg(plan: PackedPlan, group: PurchaseGroupInput): number | null {
  if (group.massPerMetre == null) return null
  const wasteMm = plan.bars.reduce((sum, bar) => sum + bar.wasteMm, 0)
  return (wasteMm / 1000) * group.massPerMetre * massFactor(group)
}

function planMaxWastePieceKg(plan: PackedPlan, group: PurchaseGroupInput): number | null {
  if (group.massPerMetre == null) return null
  const maxWasteMm = plan.bars.reduce((max, bar) => Math.max(max, bar.wasteMm), 0)
  return (maxWasteMm / 1000) * group.massPerMetre * massFactor(group)
}

function planOverLimit(
  plan: PackedPlan,
  group: PurchaseGroupInput,
  limitKg: number | null,
): number {
  if (group.massPerMetre == null || limitKg == null) return 0
  const kgPerMm = (group.massPerMetre / 1000) * massFactor(group)
  return plan.bars.filter((bar) => bar.wasteMm * kgPerMm > limitKg).length
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

function betterPlan(
  candidate: PackedPlan,
  current: PackedPlan | null,
  group: PurchaseGroupInput,
  priority: PurchasePriority,
  limitKg: number | null,
): boolean {
  if (!current) return true

  if (priority === 'waste-removal') {
    const candidateOver = planOverLimit(candidate, group, limitKg)
    const currentOver = planOverLimit(current, group, limitKg)
    if (candidateOver !== currentOver) return candidateOver < currentOver
    if (candidate.purchasedMm !== current.purchasedMm) {
      return candidate.purchasedMm < current.purchasedMm
    }
    const candidateMax = planMaxWastePieceKg(candidate, group)
    const currentMax = planMaxWastePieceKg(current, group)
    if (candidateMax != null && currentMax != null && candidateMax !== currentMax) {
      return candidateMax < currentMax
    }
    return lengthBetter(candidate, current)
  }

  if (priority === 'weight') {
    const candidateKg = planWasteKg(candidate, group)
    const currentKg = planWasteKg(current, group)
    if (candidateKg != null && currentKg != null && candidateKg !== currentKg) {
      return candidateKg < currentKg
    }
  }

  return lengthBetter(candidate, current)
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

  const priority = options.priority ?? 'length'
  const limitKg = options.maxWastePieceKg == null ? DEFAULT_WASTE_PIECE_KG : options.maxWastePieceKg

  const searchEffort = options.searchEffort ?? 'balanced'
  let best = beamSearch(fittable, lengths, marginMm, kerfMm, group.tee, searchEffort)
  for (const length of lengths) {
    const drafts = packFixed(fittable, length, marginMm, kerfMm)
    if (!drafts) continue
    const packed = group.tee
      ? finalizeTee(drafts, lengths, marginMm)
      : finalizeLinear(drafts, lengths, marginMm)
    if (packed && betterPlan(packed, best, group, priority, limitKg)) best = packed
  }

  const purchases = best?.purchases ?? []
  const purchasedMm = best?.purchasedMm ?? 0
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
  const maxWastePieceKg = best ? planMaxWastePieceKg(best, group) : null
  const overLimitPieces = best ? planOverLimit(best, group, limitKg) : 0

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
    wasteMm,
    wasteKg,
    binWasteMm,
    binWasteKg,
    reusableOffcutMm,
    reusableOffcutKg,
    maxWastePieceKg,
    overLimitPieces,
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
