/**
 * Formula-driven cut / pick-up tracker built from the purchase plans.
 *
 * Nesting sheet: type 1 in Cut on a beam. Every mark on that beam immediately shows Cut on the
 * Marks sheet, and Parts to buy counts the beams cut for each stock/length. Formulas only — no
 * macros, no percentages, no mass. The file is a normal .xlsx.
 */

import * as XLSX from 'xlsx'
import {
  DEFAULT_CHUCK_MARGIN_MM,
  DEFAULT_ONE_PERSON_KG,
  DEFAULT_STOCK_LENGTHS_MM,
  DEFAULT_TWO_PERSON_KG,
  type PurchaseBar,
  type PurchaseGroupInput,
  type PurchaseOptions,
  type PurchasePlan,
  planPurchases,
  REUSABLE_OFFCUT_MM,
} from './purchase'

const NESTING_SHEET = 'Nesting'
const MARKS_SHEET = 'Marks'
const BUY_LIST_SHEET = 'Parts to buy'

const NESTING_HEADER = ['Beam', 'Stock', 'Length mm', 'Marks', 'Cut (1)', 'Status'] as const
const MARKS_HEADER = ['Beam', 'Mark', 'Length mm', 'Cut', 'Picked up (1)', 'Status'] as const
const BUY_HEADER = ['Family', 'Size', 'Length (m)', 'Qty', 'Cut'] as const

export interface TrackerPartRow {
  beam: string
  mark: string
  length: number
}

export interface TrackerBeamRow {
  beam: string
  stock: string
  stockLength: number
  marks: string
}

export interface PurchaseTrackerModel {
  jobName: string
  parts: TrackerPartRow[]
  beams: TrackerBeamRow[]
}

/** Same defaults the purchase calculator starts from, so the tracker matches its first view. */
export const DEFAULT_TRACKER_PURCHASE_OPTIONS: PurchaseOptions = {
  stockLengthsMm: DEFAULT_STOCK_LENGTHS_MM,
  marginMm: DEFAULT_CHUCK_MARGIN_MM,
  onePersonKg: DEFAULT_ONE_PERSON_KG,
  twoPersonKg: DEFAULT_TWO_PERSON_KG,
  reusableOffcutMm: REUSABLE_OFFCUT_MM,
}

function summarizeMarks(units: { mark: string }[]): string {
  const counts = new Map<string, number>()
  for (const unit of units) counts.set(unit.mark, (counts.get(unit.mark) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([mark, quantity]) => `${mark} ×${quantity}`)
    .join(' | ')
}

/** A T plan stores two cutting bars per purchased stock beam; every other plan is one bar. */
function beamBars(plan: PurchasePlan): PurchaseBar[][] {
  if (!plan.tee) return plan.bars.map((bar) => [bar])
  const pairs: PurchaseBar[][] = []
  for (let index = 0; index < plan.bars.length; index += 2) {
    pairs.push(plan.bars.slice(index, index + 2))
  }
  return pairs
}

/** One row per T piece and one row per physical stock beam. */
export function buildPurchaseTrackerModel(
  plans: PurchasePlan[],
  jobName = '',
): PurchaseTrackerModel {
  const parts: TrackerPartRow[] = []
  const beams: TrackerBeamRow[] = []
  let beamNo = 0

  for (const plan of plans) {
    if (plan.pieceCount === 0) continue
    for (const bars of beamBars(plan)) {
      const first = bars[0]
      if (!first) continue
      beamNo++
      const beam = `${plan.stock}-B${String(beamNo).padStart(2, '0')}`
      const units = bars.flatMap((bar) => bar.units)
      for (const unit of units) {
        parts.push({ beam, mark: unit.mark, length: unit.lengthMm })
      }
      beams.push({
        beam,
        stock: plan.stock,
        stockLength: first.stockLengthMm,
        marks: summarizeMarks(units),
      })
    }
  }

  // Group the sheets by stock/length so repeated labels can be merged into one cell.
  const sortedBeams = [...beams].sort(
    (a, b) =>
      a.stock.localeCompare(b.stock) ||
      a.stockLength - b.stockLength ||
      a.beam.localeCompare(b.beam, undefined, { numeric: true }),
  )
  const beamRank = new Map(sortedBeams.map((beam, index) => [beam.beam, index]))
  const sortedParts = [...parts].sort(
    (a, b) =>
      (beamRank.get(a.beam) ?? 0) - (beamRank.get(b.beam) ?? 0) ||
      a.mark.localeCompare(b.mark, undefined, { numeric: true }) ||
      a.length - b.length,
  )
  return { jobName, parts: sortedParts, beams: sortedBeams }
}

/** Merge runs of identical values so repeated stock/size labels read as one group. */
function addRunMerges(sheet: XLSX.WorkSheet, values: string[], col: number): void {
  const merges = sheet['!merges'] ?? []
  let start = 0
  for (let index = 1; index <= values.length; index++) {
    if (index === values.length || values[index] !== values[start]) {
      const end = index - 1
      if (end > start) {
        merges.push({ s: { r: start + 1, c: col }, e: { r: end + 1, c: col } })
      }
      start = index
    }
  }
  sheet['!merges'] = merges
}

type FormulaKind = 'n' | 's'

function setFormula(
  sheet: XLSX.WorkSheet,
  row: number,
  col: number,
  formula: string,
  kind: FormulaKind = 'n',
): void {
  sheet[XLSX.utils.encode_cell({ r: row, c: col })] = { t: kind, f: formula }
}

/** The sheet the shop works on: one row per stock beam, tick Cut when that beam is cut. */
function nestingSheet(model: PurchaseTrackerModel): XLSX.WorkSheet {
  const rows = [
    [...NESTING_HEADER],
    ...model.beams.map((beam) => [beam.beam, beam.stock, beam.stockLength, beam.marks, 0, '']),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  model.beams.forEach((_, index) => {
    const row = index + 2
    setFormula(sheet, row - 1, 5, `IF(E${row}=1,"Cut","Pending")`, 's')
  })
  sheet['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 40 }, { wch: 9 }, { wch: 11 }]
  sheet['!autofilter'] = { ref: `A1:F${Math.max(1, rows.length)}` }
  addRunMerges(
    sheet,
    model.beams.map((beam) => beam.stock),
    1,
  )
  addRunMerges(
    sheet,
    model.beams.map((beam) => `${beam.stock}|${beam.stockLength}`),
    2,
  )
  return sheet
}

/** One row per piece; Cut follows the beam automatically, Picked up is ticked by hand. */
function marksSheet(model: PurchaseTrackerModel): XLSX.WorkSheet {
  const rows = [
    [...MARKS_HEADER],
    ...model.parts.map((part) => [part.beam, part.mark, part.length, '', 0, '']),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const nestingLastRow = Math.max(2, model.beams.length + 1)
  model.parts.forEach((_, index) => {
    const row = index + 2
    setFormula(
      sheet,
      row - 1,
      3,
      `IF(SUMIF(Nesting!$A$2:$A$${nestingLastRow},$A${row},Nesting!$E$2:$E$${nestingLastRow})>0,1,0)`,
    )
    setFormula(sheet, row - 1, 5, `IF(E${row}=1,"Picked up",IF(D${row}=1,"Cut","Pending"))`, 's')
  })
  sheet['!cols'] = [{ wch: 16 }, { wch: 13 }, { wch: 11 }, { wch: 8 }, { wch: 12 }, { wch: 11 }]
  sheet['!autofilter'] = { ref: `A1:F${Math.max(1, rows.length)}` }
  addRunMerges(
    sheet,
    model.parts.map((part) => `${part.beam}|${part.mark}`),
    1,
  )
  return sheet
}

/** Split a stock label into the same family / size hierarchy the buy-list UI uses. */
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
  const channel = clean.match(/^(\d+(?:\.\d+)?)(PFC|TFC)(.*)$/i)
  if (channel) {
    const suffix = channel[3].replace(/^\*/, '')
    return {
      family: channel[2].toUpperCase(),
      size: suffix ? `${channel[1]}*${suffix}` : channel[1],
    }
  }
  const tube = clean.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(RHS|SHS)$/i)
  if (tube) {
    return { family: tube[4].toUpperCase(), size: `${tube[1]}×${tube[2]}×${tube[3]}` }
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

/** Quantity to buy per stock/length, with the number of those beams already cut. */
function buyListSheet(model: PurchaseTrackerModel): XLSX.WorkSheet {
  const grouped = new Map<
    string,
    { stock: string; family: string; size: string; length: number; qty: number }
  >()
  for (const beam of model.beams) {
    const key = `${beam.stock}|${beam.stockLength}`
    const found = grouped.get(key)
    if (found) found.qty++
    else {
      const { family, size } = splitStock(beam.stock)
      grouped.set(key, { stock: beam.stock, family, size, length: beam.stockLength, qty: 1 })
    }
  }
  const buys = [...grouped.values()].sort(
    (a, b) =>
      a.family.localeCompare(b.family) ||
      a.size.localeCompare(b.size, undefined, { numeric: true }) ||
      a.length - b.length,
  )
  const rows = [
    [...BUY_HEADER],
    ...buys.map((buy) => [buy.family, buy.size, (buy.length / 1000).toFixed(1), buy.qty, '']),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const nestingLastRow = Math.max(2, model.beams.length + 1)
  buys.forEach((buy, index) => {
    const row = index + 2
    // Count by beam id, not the merged Stock/Length display cells.
    const formula =
      model.beams
        .filter((beam) => beam.stock === buy.stock && beam.stockLength === buy.length)
        .map((beam) => {
          const id = beam.beam.replace(/"/g, '""')
          return `SUMIF(Nesting!$A$2:$A$${nestingLastRow},"${id}",Nesting!$E$2:$E$${nestingLastRow})`
        })
        .join('+') || '0'
    setFormula(sheet, row - 1, 4, formula)
  })
  sheet['!cols'] = [{ wch: 10 }, { wch: 16 }, { wch: 11 }, { wch: 8 }, { wch: 8 }]
  sheet['!autofilter'] = { ref: `A1:E${Math.max(1, rows.length)}` }
  addRunMerges(
    sheet,
    buys.map((buy) => buy.family),
    0,
  )
  addRunMerges(
    sheet,
    buys.map((buy) => `${buy.family}|${buy.size}`),
    1,
  )
  return sheet
}

/** Builds the .xlsx workbook from the plans currently shown in the purchase dialog. */
export function buildPurchaseTrackerWorkbook(plans: PurchasePlan[], jobName = 'job'): ArrayBuffer {
  const model = buildPurchaseTrackerModel(plans, jobName)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, nestingSheet(model), NESTING_SHEET)
  XLSX.utils.book_append_sheet(workbook, marksSheet(model), MARKS_SHEET)
  XLSX.utils.book_append_sheet(workbook, buyListSheet(model), BUY_LIST_SHEET)
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

/** Convenience for callers that only have the groups (default purchase settings). */
export function buildPurchaseTrackerWorkbookForGroups(
  groups: PurchaseGroupInput[],
  jobName = 'job',
): ArrayBuffer {
  const plans =
    DEFAULT_TRACKER_PURCHASE_OPTIONS.stockLengthsMm.length > 0
      ? planPurchases(groups, DEFAULT_TRACKER_PURCHASE_OPTIONS)
      : []
  return buildPurchaseTrackerWorkbook(plans, jobName)
}
