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
import { profileFamily } from '@/lib/sections/canonical'

/** Beam / channel stock lengths (Surdex). */
export const BEAM_STOCK_LENGTHS_MM = [
  9000, 10500, 12000, 13500, 15000, 16500, 18000, 20000,
] as const

/** RHS / SHS stock lengths (Surdex: 8 m and 12 m). */
export const TUBE_STOCK_LENGTHS_MM = [8000, 12000] as const

/** Equal / unequal angle stock lengths. */
export const ANGLE_STOCK_LENGTHS_MM = [6000, 9000, 12000] as const

/** CHS stock lengths. */
export const CHS_STOCK_LENGTHS_MM = [6000, 9000] as const

/** Union of every family, used for the UI's length toggles. */
export const AU_STOCK_LENGTHS_MM = [
  6000, 8000, 9000, 10500, 12000, 13500, 15000, 16500, 18000, 20000,
] as const

/** Supplier lengths that actually apply to a section. */
export function stockLengthsForStock(stock: string): readonly number[] {
  switch (profileFamily(stock)) {
    case 'i':
    case 'channel':
    case 'tee':
      return BEAM_STOCK_LENGTHS_MM
    case 'tube':
      return TUBE_STOCK_LENGTHS_MM
    case 'angle':
      return ANGLE_STOCK_LENGTHS_MM
    case 'round':
      return CHS_STOCK_LENGTHS_MM
    default:
      return AU_STOCK_LENGTHS_MM
  }
}

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
  /** False when the last piece starts inside the final support zone. */
  supportOk: boolean
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
  /** Bars whose last piece starts inside the final support zone. */
  invalidSupportBars: number
  /** Purchased beams light enough for one person to load. */
  loadingOnePersonMoves: number
  /** Purchased beams needing two people to load (weight or length). */
  loadingTwoPersonMoves: number
  /** Purchased beams too heavy to load manually. */
  loadingEquipmentMoves: number
  utilisation: number
  oversized: PurchaseUnit[]
}

interface DraftBar {
  stockLengthMm: number
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
      bars.push({ stockLengthMm, units: [unit], usedMm: unit.lengthMm })
    }
  }
  return bars
}

type PackStrategy = 'smallest' | 'largest' | 'fit'

/**
 * Mixed-size best-fit: open whatever stock length fits, not one fixed primary length.
 * The finalise pass still re-shrinks every bar to the shortest support-valid stock.
 */
function packMixed(
  units: PurchaseUnit[],
  lengths: number[],
  marginMm: number,
  kerfMm: number,
  tee: boolean,
  strategy: PackStrategy,
): DraftBar[] | null {
  const bars: DraftBar[] = []

  for (let index = 0; index < units.length; index++) {
    const unit = units[index]
    let best = -1
    let bestFree = Number.POSITIVE_INFINITY
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]
      const gap = bar.units.length > 0 ? kerfMm : 0
      const free =
        usableStockLengthMm(bar.stockLengthMm, marginMm) - bar.usedMm - gap - unit.lengthMm
      if (free >= 0 && free < bestFree) {
        bestFree = free
        best = i
      }
    }
    if (best >= 0) {
      const bar = bars[best]
      bar.usedMm += (bar.units.length > 0 ? kerfMm : 0) + unit.lengthMm
      bar.units.push(unit)
      continue
    }

    const candidates = lengths.filter(
      (length) => usableStockLengthMm(length, marginMm) >= unit.lengthMm,
    )
    if (candidates.length === 0) return null

    let chosen = candidates[0]
    if (strategy === 'largest') {
      chosen = candidates[candidates.length - 1]
    } else if (strategy === 'fit') {
      let bestUsed = -1
      for (const length of candidates) {
        const capacity = usableStockLengthMm(length, marginMm)
        let used = unit.lengthMm
        let secondUsed = 0
        let onSecond = false
        for (const next of units.slice(index + 1)) {
          if (!onSecond) {
            const gap = used > 0 ? kerfMm : 0
            if (used + gap + next.lengthMm <= capacity) {
              used += gap + next.lengthMm
              continue
            }
            if (!tee) continue
            onSecond = true
          }
          const gap = secondUsed > 0 ? kerfMm : 0
          if (secondUsed + gap + next.lengthMm <= capacity) {
            secondUsed += gap + next.lengthMm
          }
        }
        const filled = tee ? used + secondUsed : used
        if (filled > bestUsed) {
          bestUsed = filled
          chosen = length
        }
      }
    }

    bars.push({ stockLengthMm: chosen, units: [unit], usedMm: unit.lengthMm })
    if (tee) bars.push({ stockLengthMm: chosen, units: [], usedMm: 0 })
  }

  return bars
}

/**
 * Shortest available bar that fits the pieces and keeps the last piece's start out of the final
 * support zone. `lastStartMm` is the start of the last piece in cut order (or -Infinity for an
 * empty bar).
 */
function stockFor(
  usedMm: number,
  lastStartMm: number,
  lengths: number[],
  marginMm: number,
): number | null {
  for (const length of lengths) {
    if (usableStockLengthMm(length, marginMm) < usedMm) continue
    if (lastStartMm < length - MACHINE.minEndSupportMm) return length
  }
  return null
}

/** Fallback when no length can satisfy the support zone: shortest bar that fits the pieces. */
function stockForUsed(usedMm: number, lengths: number[], marginMm: number): number | null {
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

function supportOk(bar: PurchaseBar): boolean {
  const last = bar.units.at(-1)
  if (!last) return true
  const start = bar.usedMm - last.lengthMm
  return start < bar.stockLengthMm - MACHINE.minEndSupportMm
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
    const units = [...draft.units].sort((a, b) => a.lengthMm - b.lengthMm)
    const lastStartMm =
      units.length > 0 ? draft.usedMm - units[units.length - 1].lengthMm : -Infinity
    const stockLengthMm =
      stockFor(draft.usedMm, lastStartMm, lengths, marginMm) ??
      stockForUsed(draft.usedMm, lengths, marginMm)
    if (stockLengthMm == null) return null
    const bar: PurchaseBar = {
      stockLengthMm,
      units,
      usedMm: draft.usedMm,
      wasteMm: stockLengthMm - draft.usedMm,
      supportOk: true,
    }
    bar.supportOk = supportOk(bar)
    bars.push(bar)
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
    left.units.sort((a, b) => a.lengthMm - b.lengthMm)
    right?.units.sort((a, b) => a.lengthMm - b.lengthMm)
    const leftStart =
      left.units.length > 0 ? left.usedMm - left.units[left.units.length - 1].lengthMm : -Infinity
    const rightStart =
      right && right.units.length > 0
        ? right.usedMm - right.units[right.units.length - 1].lengthMm
        : -Infinity
    const usedMm = Math.max(left.usedMm, right?.usedMm ?? 0)
    const stockLengthMm =
      stockFor(usedMm, Math.max(leftStart, rightStart), lengths, marginMm) ??
      stockForUsed(usedMm, lengths, marginMm)
    if (stockLengthMm == null) return null
    counts.set(stockLengthMm, (counts.get(stockLengthMm) ?? 0) + 1)
    purchasedMm += stockLengthMm
    const leftBar: PurchaseBar = {
      stockLengthMm,
      units: [...left.units].sort((a, b) => a.lengthMm - b.lengthMm),
      usedMm: left.usedMm,
      wasteMm: stockLengthMm - left.usedMm,
      supportOk: true,
    }
    leftBar.supportOk = supportOk(leftBar)
    bars.push(leftBar)
    if (right) {
      const rightBar: PurchaseBar = {
        stockLengthMm,
        units: [...right.units].sort((a, b) => a.lengthMm - b.lengthMm),
        usedMm: right.usedMm,
        wasteMm: stockLengthMm - right.usedMm,
        supportOk: true,
      }
      rightBar.supportOk = supportOk(rightBar)
      bars.push(rightBar)
    } else {
      bars.push({ stockLengthMm, units: [], usedMm: 0, wasteMm: stockLengthMm, supportOk: true })
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

function planWasteSquareSum(plan: PackedPlan): number {
  return plan.bars.reduce((sum, bar) => sum + bar.wasteMm * bar.wasteMm, 0)
}

function planBinCarryCounts(
  plan: PackedPlan,
  group: PurchaseGroupInput,
  onePersonKg: number,
  twoPersonKg: number,
): CarryCounts | null {
  if (group.massPerMetre == null) return null
  const kgPerMm = (group.massPerMetre / 1000) * massFactor(group)
  const counts: CarryCounts = { one: 0, two: 0, over: 0 }
  for (const bar of plan.bars) {
    if (bar.wasteMm <= 0 || bar.wasteMm >= REUSABLE_OFFCUT_MM) continue
    const kg = bar.wasteMm * kgPerMm
    if (kg <= onePersonKg) counts.one++
    else if (kg <= twoPersonKg) counts.two++
    else counts.over++
  }
  return counts
}

function betterPlan(
  candidate: PackedPlan,
  current: PackedPlan | null,
  group: PurchaseGroupInput,
  onePersonKg: number,
  twoPersonKg: number,
): boolean {
  if (!current) return true

  // Phase 1: minimum purchased length = minimum waste weight.
  if (candidate.purchasedMm !== current.purchasedMm) {
    return candidate.purchasedMm < current.purchasedMm
  }

  // Phase 2: concentrate waste onto as few beams as possible.
  const candidateSquares = planWasteSquareSum(candidate)
  const currentSquares = planWasteSquareSum(current)
  if (candidateSquares !== currentSquares) return candidateSquares > currentSquares

  // Phase 3: for non-reusable (bin) waste, prefer more 1-person then 2-person pieces.
  const candidateCounts = planBinCarryCounts(candidate, group, onePersonKg, twoPersonKg)
  const currentCounts = planBinCarryCounts(current, group, onePersonKg, twoPersonKg)
  if (candidateCounts && currentCounts) {
    if (candidateCounts.one !== currentCounts.one) {
      return candidateCounts.one > currentCounts.one
    }
    if (candidateCounts.two !== currentCounts.two) {
      return candidateCounts.two > currentCounts.two
    }
    if (candidateCounts.over !== currentCounts.over) {
      return candidateCounts.over < currentCounts.over
    }
  }

  return lengthBetter(candidate, current)
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

function planFromBars(bars: PurchaseBar[]): PackedPlan {
  const counts = new Map<number, number>()
  let purchasedMm = 0
  for (const bar of bars) {
    counts.set(bar.stockLengthMm, (counts.get(bar.stockLengthMm) ?? 0) + 1)
    purchasedMm += bar.stockLengthMm
  }
  return { bars, purchases: quantityList(counts), purchasedMm }
}

function repackLinear(
  units: PurchaseUnit[],
  lengths: number[],
  marginMm: number,
  kerfMm: number,
  group: PurchaseGroupInput,
  onePersonKg: number,
  twoPersonKg: number,
): PackedPlan | null {
  const sorted = [...units].sort((a, b) => b.lengthMm - a.lengthMm)
  let best: PackedPlan | null = null
  const consider = (packed: PackedPlan | null) => {
    if (packed && betterPlan(packed, best, group, onePersonKg, twoPersonKg)) best = packed
  }
  for (const length of lengths) {
    const drafts = packFixed(sorted, length, marginMm, kerfMm)
    if (!drafts) continue
    consider(finalizeLinear(drafts, lengths, marginMm))
  }
  for (const strategy of ['smallest', 'largest', 'fit'] as const) {
    const drafts = packMixed(sorted, lengths, marginMm, kerfMm, false, strategy)
    if (!drafts) continue
    consider(finalizeLinear(drafts, lengths, marginMm))
  }
  return best
}

function rebuildBar(bar: PurchaseBar, units: PurchaseUnit[], kerfMm: number): PurchaseBar {
  const sorted = [...units].sort((a, b) => a.lengthMm - b.lengthMm)
  const usedMm = sorted.reduce(
    (sum, unit, index) => sum + unit.lengthMm + (index > 0 ? kerfMm : 0),
    0,
  )
  const last = sorted.at(-1)
  return {
    ...bar,
    units: sorted,
    usedMm,
    wasteMm: bar.stockLengthMm - usedMm,
    supportOk: !last || usedMm - last.lengthMm < bar.stockLengthMm - MACHINE.minEndSupportMm,
  }
}

/** Move one small piece to a bar with space; keep the change if the objective improves. */
function tryMovePieces(
  plan: PackedPlan,
  marginMm: number,
  kerfMm: number,
  group: PurchaseGroupInput,
  onePersonKg: number,
  twoPersonKg: number,
): PackedPlan {
  let best = plan
  for (let pass = 0; pass < 2; pass++) {
    const sources = best.bars
      .map((bar, index) => ({ bar, index }))
      .filter(({ bar }) => bar.wasteMm > 0 && bar.units.length > 0)
      .sort((a, b) => b.bar.wasteMm - a.bar.wasteMm)
      .slice(0, 20)
    const destinations = best.bars
      .map((bar, index) => ({ bar, index }))
      .sort((a, b) => b.bar.wasteMm - a.bar.wasteMm)
      .slice(0, 20)
    let improved = false
    let attempts = 0
    for (let s = 0; s < sources.length && !improved && attempts < 400; s++) {
      const source = sources[s]
      const units = [...source.bar.units].sort((a, b) => a.lengthMm - b.lengthMm).slice(0, 5)
      for (const unit of units) {
        if (improved || attempts >= 400) break
        for (const destination of destinations) {
          if (improved || attempts >= 400) break
          if (destination.index === source.index) continue
          const destBar = best.bars[destination.index]
          const gap = destBar.units.length > 0 ? kerfMm : 0
          if (
            destBar.usedMm + gap + unit.lengthMm >
            usableStockLengthMm(destBar.stockLengthMm, marginMm)
          ) {
            continue
          }
          attempts++
          const bars = best.bars.map((bar) => ({ ...bar, units: [...bar.units] }))
          bars[source.index] = rebuildBar(
            bars[source.index],
            bars[source.index].units.filter((candidate) => candidate !== unit),
            kerfMm,
          )
          bars[destination.index] = rebuildBar(
            bars[destination.index],
            [...bars[destination.index].units, unit],
            kerfMm,
          )
          const finalBars = bars.filter((bar) => bar.units.length > 0)
          const candidate = planFromBars(finalBars)
          const currentInvalid = best.bars.some((bar) => !bar.supportOk)
          if (!currentInvalid && candidate.bars.some((bar) => !bar.supportOk)) continue
          if (betterPlan(candidate, best, group, onePersonKg, twoPersonKg)) {
            best = candidate
            improved = true
          }
        }
      }
    }
    if (!improved) break
  }
  return best
}

/** Small local search: repack pairs of waste-bearing bars, keeping the rest fixed. */
function improveLinearPlan(
  plan: PackedPlan,
  lengths: number[],
  marginMm: number,
  kerfMm: number,
  group: PurchaseGroupInput,
  onePersonKg: number,
  twoPersonKg: number,
): PackedPlan {
  let best = plan
  for (let pass = 0; pass < 2; pass++) {
    const candidates = best.bars
      .map((bar, index) => ({ bar, index }))
      .filter(({ bar }) => bar.wasteMm > 0)
      .sort((a, b) => b.bar.wasteMm - a.bar.wasteMm)
      .slice(0, 30)
    let improved = false
    for (let a = 0; a < candidates.length && !improved; a++) {
      for (let b = a + 1; b < candidates.length && !improved; b++) {
        const first = candidates[a].index
        const second = candidates[b].index
        const units = [...best.bars[first].units, ...best.bars[second].units]
        const repacked = repackLinear(
          units,
          lengths,
          marginMm,
          kerfMm,
          group,
          onePersonKg,
          twoPersonKg,
        )
        if (!repacked) continue
        const bars = best.bars.filter((_, index) => index !== first && index !== second)
        const candidate = planFromBars([...bars, ...repacked.bars])
        const currentInvalid = best.bars.some((bar) => !bar.supportOk)
        if (!currentInvalid && candidate.bars.some((bar) => !bar.supportOk)) continue
        if (betterPlan(candidate, best, group, onePersonKg, twoPersonKg)) {
          best = candidate
          improved = true
        }
      }
    }
    if (!improved) break
  }
  return tryMovePieces(best, marginMm, kerfMm, group, onePersonKg, twoPersonKg)
}

export function planPurchase(group: PurchaseGroupInput, options: PurchaseOptions): PurchasePlan {
  const allowed = new Set(stockLengthsForStock(group.stock))
  const lengths = [...new Set(options.stockLengthsMm)]
    .filter((length) => length > 0 && allowed.has(length))
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

  let bestValid: PackedPlan | null = null
  let bestInvalid: PackedPlan | null = null
  const consider = (packed: PackedPlan | null) => {
    if (!packed) return
    const invalid = packed.bars.some((bar) => !bar.supportOk)
    if (invalid) {
      if (betterPlan(packed, bestInvalid, group, onePersonKg, twoPersonKg)) {
        bestInvalid = packed
      }
    } else if (betterPlan(packed, bestValid, group, onePersonKg, twoPersonKg)) {
      bestValid = packed
    }
  }

  // A tighter selected margin can otherwise miss plans found at a larger reserve. Pack with
  // the selected margin and the standard larger reserves, then re-shrink with the selected one.
  const reserves = [marginMm]
  for (const reserve of [150, 200]) {
    const candidate = Math.max(marginMm, reserve)
    if (!reserves.includes(candidate)) reserves.push(candidate)
  }

  for (const reserve of reserves) {
    for (const length of lengths) {
      const drafts = packFixed(fittable, length, reserve, kerfMm)
      if (!drafts) continue
      consider(
        group.tee
          ? finalizeTee(drafts, lengths, marginMm)
          : finalizeLinear(drafts, lengths, marginMm),
      )
    }

    for (const strategy of ['smallest', 'largest', 'fit'] as const) {
      const drafts = packMixed(fittable, lengths, reserve, kerfMm, group.tee, strategy)
      if (!drafts) continue
      consider(
        group.tee
          ? finalizeTee(drafts, lengths, marginMm)
          : finalizeLinear(drafts, lengths, marginMm),
      )
    }
  }

  const initialBest = (bestValid ?? bestInvalid) as PackedPlan | null
  const best =
    initialBest && !group.tee
      ? improveLinearPlan(initialBest, lengths, marginMm, kerfMm, group, onePersonKg, twoPersonKg)
      : initialBest

  const purchases = best?.purchases ?? []
  const purchasedMm = best?.purchasedMm ?? 0
  let loadingOnePersonMoves = 0
  let loadingTwoPersonMoves = 0
  let loadingEquipmentMoves = 0
  for (const item of purchases) {
    if (item.lengthMm > MACHINE.envelope.maxLengthMm) {
      // Cut in half before machining, so it is moved to the chuck twice.
      loadingEquipmentMoves += item.count * 2
      continue
    }
    const weightKg = group.massPerMetre == null ? null : (item.lengthMm / 1000) * group.massPerMetre
    if (weightKg != null && weightKg > twoPersonKg) {
      loadingEquipmentMoves += item.count
    } else if (weightKg == null || weightKg > onePersonKg) {
      loadingTwoPersonMoves += item.count
    } else {
      loadingOnePersonMoves += item.count
    }
  }
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
  const invalidSupportBars = (best?.bars ?? []).filter((bar) => !bar.supportOk).length

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
    invalidSupportBars,
    loadingOnePersonMoves,
    loadingTwoPersonMoves,
    loadingEquipmentMoves,
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
