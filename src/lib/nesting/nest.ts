import type { AuditResult } from '@/lib/audit/types'
import { inferParentUb } from '@/lib/sections/infer'

export interface TeePart {
  mark: string
  section: string
  parentUb: string
  mass: number
  grade?: string
  /** nominal part length (mm) */
  length: number
  quantity: number
}

export interface TeeGroup {
  parentUb: string
  mass: number
  parts: TeePart[]
  teeCount: number
  totalLength: number
}

/** One T to cut (a single part instance). */
export interface TeeUnit {
  id: string
  mark: string
  length: number
}

/** One T bar — a half of a stock UB, nested and cut independently of the other half. */
export interface TeeBar {
  stockLength: number
  reserved: number
  units: TeeUnit[]
  used: number
  waste: number
}

/** One stock UB beam: split lengthwise into two independent T bars (left & right). */
export interface UbBar {
  stockLength: number
  reserved: number
  teeBars: [TeeBar, TeeBar]
}

/** count = how many bars of this length are available; Infinity = unlimited. */
export interface StockLength {
  length: number
  count: number
}

export interface NestOptions {
  stock: StockLength[]
  kerf: number
  /** leftover / trim / accuracy allowance reserved at one end (mm) */
  leftover?: number
  /** minimum spacing between cuts on opposite halves (mm); 0 disables the guard */
  minSeparation?: number
}

export interface NestResult {
  parentUb: string
  mass: number
  parts: TeePart[]
  stock: StockLength[]
  kerf: number
  leftover: number
  ubBars: UbBar[]
  ubCount: number
  teeBarCount: number
  totalTeeLength: number
  totalWaste: number
  utilisation: number
  oversized: TeeUnit[]
  /** cuts on opposite halves that are too close (would cut the same line twice) */
  cutConflicts: string[]
}

/** A part is a T if its cross-section resolves to a halved UB. */
export function collectTees(result: AuditResult): TeePart[] {
  const tees: TeePart[] = []
  for (const part of result.parts) {
    const nc = part.nc
    if (!nc) continue
    const match = inferParentUb(nc.dimensions)
    if (!match) continue
    const quantity = part.expected?.qty ?? nc.quantity
    const length = part.expected?.length ?? nc.length
    if (quantity === null || length === null || quantity <= 0) continue
    tees.push({
      mark: part.mark,
      section: nc.profile,
      parentUb: match.section.designation,
      mass: match.section.mass,
      grade: nc.grade,
      length,
      quantity,
    })
  }
  return tees
}

export function groupTees(parts: TeePart[]): TeeGroup[] {
  const map = new Map<string, TeeGroup>()
  for (const part of parts) {
    let group = map.get(part.parentUb)
    if (!group) {
      group = { parentUb: part.parentUb, mass: part.mass, parts: [], teeCount: 0, totalLength: 0 }
      map.set(part.parentUb, group)
    }
    group.parts.push(part)
    group.teeCount += part.quantity
    group.totalLength += part.quantity * part.length
  }
  return [...map.values()].sort((a, b) => a.parentUb.localeCompare(b.parentUb))
}

/** One unit per individual T to cut. */
export function buildTeeUnits(group: TeeGroup): TeeUnit[] {
  const units: TeeUnit[] = []
  let counter = 0
  for (const part of group.parts) {
    for (let i = 0; i < part.quantity; i++) {
      units.push({ id: `u-${counter++}`, mark: part.mark, length: part.length })
    }
  }
  return units
}

function freeSpace(bar: TeeBar, kerf: number): number {
  return bar.stockLength - bar.reserved - bar.used - (bar.units.length > 0 ? kerf : 0)
}

function finalize(bar: TeeBar, kerf: number): void {
  bar.units.sort((a, b) => a.length - b.length)
  bar.used = bar.units.reduce((sum, unit, index) => sum + unit.length + (index > 0 ? kerf : 0), 0)
  bar.waste = bar.stockLength - bar.used
}

export function nestGroup(group: TeeGroup, options: NestOptions): NestResult {
  const { stock, kerf } = options
  const leftover = Math.max(0, options.leftover ?? 0)
  const available = stock.map((item) => ({ ...item }))
  const maxCapacity = available.reduce((max, item) => Math.max(max, item.length - leftover), 0)

  const units = buildTeeUnits(group).sort((a, b) => b.length - a.length)
  const oversized: TeeUnit[] = []
  const teeBars: TeeBar[] = []
  const ubBars: UbBar[] = []

  for (const unit of units) {
    // Best-fit into an existing T bar (independent per side).
    let best = -1
    let bestLeftover = Number.POSITIVE_INFINITY
    for (let i = 0; i < teeBars.length; i++) {
      const room = freeSpace(teeBars[i], kerf) - unit.length
      if (room >= 0 && room < bestLeftover) {
        bestLeftover = room
        best = i
      }
    }
    if (best >= 0) {
      teeBars[best].used += unit.length + (teeBars[best].units.length > 0 ? kerf : 0)
      teeBars[best].units.push(unit)
      continue
    }

    if (unit.length > maxCapacity) {
      oversized.push(unit)
      continue
    }
    let chosen = -1
    for (let i = 0; i < available.length; i++) {
      if (available[i].count <= 0) continue
      if (available[i].length - leftover < unit.length) continue
      if (chosen === -1 || available[i].length < available[chosen].length) chosen = i
    }
    if (chosen === -1) {
      oversized.push(unit)
      continue
    }
    available[chosen].count -= 1
    const length = available[chosen].length
    const left: TeeBar = {
      stockLength: length,
      reserved: leftover,
      units: [unit],
      used: unit.length,
      waste: 0,
    }
    const right: TeeBar = { stockLength: length, reserved: leftover, units: [], used: 0, waste: 0 }
    teeBars.push(left, right)
    ubBars.push({ stockLength: length, reserved: leftover, teeBars: [left, right] })
  }

  for (const bar of teeBars) finalize(bar, kerf)

  const totalStock = teeBars.reduce((sum, bar) => sum + bar.stockLength, 0)
  const totalWaste = teeBars.reduce((sum, bar) => sum + bar.waste, 0)

  // Cut-collision guard: left and right cuts must not land on (or near) the same line.
  const minSeparation = Math.max(0, options.minSeparation ?? 0)
  const cutConflicts: string[] = []
  if (minSeparation > 0) {
    const cutsOf = (bar: TeeBar): number[] => {
      const positions: number[] = []
      let cursor = 0
      bar.units.forEach((unit, index) => {
        cursor += unit.length + (index > 0 ? kerf : 0)
        positions.push(cursor)
      })
      return positions
    }
    for (const ub of ubBars) {
      for (const left of cutsOf(ub.teeBars[0])) {
        for (const right of cutsOf(ub.teeBars[1])) {
          const delta = Math.abs(left - right)
          if (delta < minSeparation) {
            cutConflicts.push(
              `left cut ${Math.round(left)}mm vs right cut ${Math.round(right)}mm (${Math.round(delta)}mm apart)`,
            )
          }
        }
      }
    }
  }

  return {
    parentUb: group.parentUb,
    mass: group.mass,
    parts: group.parts,
    stock,
    kerf,
    leftover,
    ubBars,
    ubCount: ubBars.length,
    teeBarCount: teeBars.length,
    totalTeeLength: group.totalLength,
    totalWaste,
    utilisation: totalStock > 0 ? (totalStock - totalWaste) / totalStock : 0,
    oversized,
    cutConflicts,
  }
}

export interface UbLayout {
  ubBar: UbBar
  quantity: number
}

function layoutKey(ub: UbBar): string {
  const side = (bar: TeeBar) =>
    bar.units.map((unit) => `${unit.mark}:${Math.round(unit.length)}`).join(',')
  return `${ub.stockLength}|${side(ub.teeBars[0])}|${side(ub.teeBars[1])}`
}

/** Groups identical stock beams so repeated layouts are reported once with a quantity. */
export function ubLayouts(result: NestResult): UbLayout[] {
  const map = new Map<string, UbLayout>()
  for (const ubBar of result.ubBars) {
    const key = layoutKey(ubBar)
    const found = map.get(key)
    if (found) found.quantity += 1
    else map.set(key, { ubBar, quantity: 1 })
  }
  return [...map.values()]
}

export function nestingToCsv(results: NestResult[]): string {
  const rows: string[][] = [
    ['parentUb', 'ub', 'qty', 'side', 'position', 'mark', 'length', 'waste'],
  ]
  for (const result of results) {
    ubLayouts(result).forEach((layout, ubIndex) => {
      const sides: [string, TeeBar][] = [
        ['left', layout.ubBar.teeBars[0]],
        ['right', layout.ubBar.teeBars[1]],
      ]
      for (const [side, bar] of sides) {
        bar.units.forEach((unit, position) => {
          rows.push([
            result.parentUb,
            String(ubIndex + 1),
            String(layout.quantity),
            side,
            String(position + 1),
            unit.mark,
            unit.length.toFixed(0),
            bar.waste.toFixed(0),
          ])
        })
      }
    })
  }
  return `${rows.map((row) => row.join(',')).join('\r\n')}\r\n`
}
