/**
 * Formula-driven cut / delivery tracking workbook built from the purchase plans.
 *
 * The operator marks Cut / Welded / Picked up with a 1 on the Parts sheet. Everything else is
 * Excel formulas: each beam counts its own cut parts, a beam is started when any part on it is
 * cut and complete when all of them are, and the Summary sheet rolls up parts, beams, length and
 * mass. The file is a normal .xlsx so it can be saved, shared and printed without this app.
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

const SUMMARY_SHEET = 'Summary'
const BUY_LIST_SHEET = 'Buy list'
const PARTS_SHEET = 'Parts'
const BEAMS_SHEET = 'Beams'

const PARTS_HEADER = [
  'Beam',
  'Mark',
  'Length mm',
  'Mass kg',
  'Cut (1)',
  'Welded (1)',
  'Picked up (1)',
  'Status',
  'Notes',
] as const

const BEAMS_HEADER = [
  'Beam',
  'Stock',
  'Stock length mm',
  'Stock mass kg',
  'Parts',
  'Pieces',
  'Cut parts',
  'Remaining',
  'Started',
  'Complete',
  'Cut length mm',
  'Cut mass kg',
  'Waste mm',
  'Notes',
] as const

export interface TrackerPartRow {
  beam: string
  mark: string
  length: number
  massKg: number
}

export interface TrackerBeamRow {
  beam: string
  stock: string
  stockLength: number
  stockMassKg: number
  parts: number
  pieces: string
  waste: number
}

export interface PurchaseTrackerModel {
  jobName: string
  parts: TrackerPartRow[]
  beams: TrackerBeamRow[]
}

/** Same defaults the purchase calculator starts from, so the tracker's beams match its first view. */
export const DEFAULT_TRACKER_PURCHASE_OPTIONS: PurchaseOptions = {
  stockLengthsMm: DEFAULT_STOCK_LENGTHS_MM,
  marginMm: DEFAULT_CHUCK_MARGIN_MM,
  onePersonKg: DEFAULT_ONE_PERSON_KG,
  twoPersonKg: DEFAULT_TWO_PERSON_KG,
  reusableOffcutMm: REUSABLE_OFFCUT_MM,
}

function summarizeUnits(units: { mark: string; lengthMm: number }[]): string {
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

/** Pure model: one row per piece assigned to a physical stock beam. */
export function buildPurchaseTrackerModel(
  groups: PurchaseGroupInput[],
  plans: PurchasePlan[],
  jobName = '',
): PurchaseTrackerModel {
  const groupByKey = new Map(groups.map((group) => [group.key, group]))
  const parts: TrackerPartRow[] = []
  const beams: TrackerBeamRow[] = []
  let beamNo = 0

  for (const plan of plans) {
    if (plan.pieceCount === 0) continue
    const group = groupByKey.get(plan.key)
    const massPerMetre = group?.massPerMetre ?? null
    const pieceMassPerMm = massPerMetre == null ? 0 : (massPerMetre * (plan.tee ? 0.5 : 1)) / 1000

    for (const bars of beamBars(plan)) {
      const first = bars[0]
      if (!first) continue
      beamNo++
      const beam = `${plan.stock}-B${String(beamNo).padStart(2, '0')}`
      const units = bars.flatMap((bar) => bar.units)
      for (const unit of units) {
        parts.push({
          beam,
          mark: unit.mark,
          length: unit.lengthMm,
          massKg: unit.lengthMm * pieceMassPerMm,
        })
      }
      beams.push({
        beam,
        stock: plan.stock,
        stockLength: first.stockLengthMm,
        stockMassKg: massPerMetre == null ? 0 : (massPerMetre * first.stockLengthMm) / 1000,
        parts: units.length,
        pieces: summarizeUnits(units),
        waste: bars.reduce((sum, bar) => sum + bar.wasteMm, 0),
      })
    }
  }

  return { jobName, parts, beams }
}

type FormulaKind = 'n' | 's'

function setFormula(
  sheet: XLSX.WorkSheet,
  row: number,
  col: number,
  formula: string,
  kind: FormulaKind = 'n',
  format?: string,
): void {
  const cell: XLSX.CellObject = { t: kind, f: formula }
  if (format) cell.z = format
  sheet[XLSX.utils.encode_cell({ r: row, c: col })] = cell
}

function partsSheet(model: PurchaseTrackerModel): XLSX.WorkSheet {
  const rows = [
    [...PARTS_HEADER],
    ...model.parts.map((part) => [
      part.beam,
      part.mark,
      part.length,
      Number(part.massKg.toFixed(3)),
      0,
      0,
      0,
      '',
      '',
    ]),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  model.parts.forEach((_, index) => {
    const row = index + 2
    setFormula(
      sheet,
      row - 1,
      7,
      `IF(I${row}=1,"Picked up",IF(H${row}=1,"Welded",IF(G${row}=1,"Cut","Pending")))`,
      's',
    )
  })
  sheet['!cols'] = [
    { wch: 16 },
    { wch: 13 },
    { wch: 11 },
    { wch: 10 },
    { wch: 8 },
    { wch: 9 },
    { wch: 10 },
    { wch: 11 },
    { wch: 26 },
  ]
  sheet['!autofilter'] = { ref: `A1:I${Math.max(1, rows.length)}` }
  return sheet
}

function beamsSheet(model: PurchaseTrackerModel, partsLastRow: number): XLSX.WorkSheet {
  const rows = [
    [...BEAMS_HEADER],
    ...model.beams.map((beam) => [
      beam.beam,
      beam.stock,
      beam.stockLength,
      Number(beam.stockMassKg.toFixed(3)),
      beam.parts,
      beam.pieces,
      '',
      '',
      '',
      '',
      '',
      '',
      beam.waste,
      '',
    ]),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  model.beams.forEach((_, index) => {
    const row = index + 2
    setFormula(
      sheet,
      row - 1,
      6,
      `SUMIF(Parts!$A$2:$A$${partsLastRow},$A${row},Parts!$G$2:$G$${partsLastRow})`,
    )
    setFormula(sheet, row - 1, 7, `E${row}-G${row}`)
    setFormula(sheet, row - 1, 8, `IF(G${row}>0,1,0)`)
    setFormula(sheet, row - 1, 9, `IF(E${row}>0,IF(G${row}=E${row},1,0),0)`)
    setFormula(
      sheet,
      row - 1,
      10,
      `SUMIFS(Parts!$C$2:$C$${partsLastRow},Parts!$A$2:$A$${partsLastRow},$A${row},Parts!$G$2:$G$${partsLastRow},1)`,
    )
    setFormula(
      sheet,
      row - 1,
      11,
      `SUMIFS(Parts!$D$2:$D$${partsLastRow},Parts!$A$2:$A$${partsLastRow},$A${row},Parts!$G$2:$G$${partsLastRow},1)`,
    )
  })
  sheet['!cols'] = [
    { wch: 16 },
    { wch: 16 },
    { wch: 12 },
    { wch: 11 },
    { wch: 7 },
    { wch: 34 },
    { wch: 9 },
    { wch: 9 },
    { wch: 8 },
    { wch: 9 },
    { wch: 12 },
    { wch: 11 },
    { wch: 10 },
    { wch: 26 },
  ]
  sheet['!autofilter'] = { ref: `A1:N${Math.max(1, rows.length)}` }
  return sheet
}

/** The old CSV buy list, now with completion formulas from the Beams sheet. */
function buyListSheet(model: PurchaseTrackerModel): XLSX.WorkSheet {
  const grouped = new Map<string, { stock: string; length: number; bars: number }>()
  for (const beam of model.beams) {
    const key = `${beam.stock}|${beam.stockLength}`
    const found = grouped.get(key)
    if (found) found.bars++
    else grouped.set(key, { stock: beam.stock, length: beam.stockLength, bars: 1 })
  }
  const buys = [...grouped.values()].sort(
    (a, b) => a.stock.localeCompare(b.stock) || a.length - b.length,
  )
  const rows = [
    ['Stock', 'Length mm', 'Bars to buy', 'Bars complete', 'Bars remaining', 'Notes'],
    ...buys.map((buy) => [buy.stock, buy.length, buy.bars, '', '', '']),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const beamsLastRow = Math.max(2, model.beams.length + 1)
  buys.forEach((_, index) => {
    const row = index + 2
    setFormula(
      sheet,
      row - 1,
      3,
      `COUNTIFS(Beams!$B$2:$B$${beamsLastRow},$A${row},Beams!$C$2:$C$${beamsLastRow},$B${row},Beams!$J$2:$J$${beamsLastRow},1)`,
      'n',
      '0',
    )
    setFormula(sheet, row - 1, 4, `C${row}-D${row}`, 'n', '0')
  })
  sheet['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 15 }, { wch: 26 }]
  sheet['!autofilter'] = { ref: `A1:F${Math.max(1, rows.length)}` }
  return sheet
}

function summarySheet(model: PurchaseTrackerModel): XLSX.WorkSheet {
  const partsLastRow = Math.max(2, model.parts.length + 1)
  const beamsLastRow = Math.max(2, model.beams.length + 1)
  const rows: (string | number)[][] = [
    ['Cut & delivery tracker'],
    ['Job', model.jobName],
    ['Generated', new Date().toISOString().slice(0, 10)],
    [
      'How to use',
      'Type 1 in Cut / Welded / Picked up on the Parts sheet. Beams and the metrics below update automatically.',
    ],
    [],
    ['Metric', 'Value'],
  ]
  const push = (label: string, value: string | number = '') => {
    rows.push([label, value])
    return rows.length
  }

  const totalParts = push('Total parts')
  const cutParts = push('Cut parts')
  const weldedParts = push('Welded parts')
  const pickedUpParts = push('Picked up parts')
  const remainingParts = push('Remaining parts')
  const cutProgress = push('Cut progress')
  const totalPartLength = push('Total part length (m)')
  const cutPartLength = push('Cut part length (m)')
  const totalPartMass = push('Total part mass (kg)')
  const cutPartMass = push('Cut part mass (kg)')
  const totalBeams = push('Total stock beams')
  const startedBeams = push('Beams started (any part cut)')
  const completeBeams = push('Beams complete (all parts cut)')
  const stockProgress = push('Stock progress')
  const totalStockLength = push('Stock length total (m)')
  const usedStockLength = push('Stock length used (m)')
  const stockMassUsed = push('Stock mass used (kg)')
  const stockLeft = push('Stock length left (m)')
  const waste = push('Waste (m)')

  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const p = 'Parts!$'
  const b = 'Beams!$'
  const put = (row: number, formula: string, format?: string) =>
    setFormula(sheet, row - 1, 1, formula, 'n', format)

  put(totalParts, `COUNTA(${p}B$2:$B$${partsLastRow})`, '0')
  put(cutParts, `SUM(${p}G$2:$G$${partsLastRow})`, '0')
  put(weldedParts, `SUM(${p}H$2:$H$${partsLastRow})`, '0')
  put(pickedUpParts, `SUM(${p}I$2:$I$${partsLastRow})`, '0')
  put(remainingParts, `B${totalParts}-B${cutParts}`, '0')
  put(cutProgress, `IF(B${totalParts}>0,B${cutParts}/B${totalParts},0)`, '0.0%')
  put(totalPartLength, `SUM(${p}C$2:$C$${partsLastRow})/1000`, '0.0')
  put(cutPartLength, `SUMIF(${p}G$2:$G$${partsLastRow},1,${p}C$2:$C$${partsLastRow})/1000`, '0.0')
  put(totalPartMass, `SUM(${p}D$2:$D$${partsLastRow})`, '0.0')
  put(cutPartMass, `SUMIF(${p}G$2:$G$${partsLastRow},1,${p}D$2:$D$${partsLastRow})`, '0.0')
  put(totalBeams, `COUNTA(${b}A$2:$A$${beamsLastRow})`, '0')
  put(startedBeams, `SUM(${b}I$2:$I$${beamsLastRow})`, '0')
  put(completeBeams, `SUM(${b}J$2:$J$${beamsLastRow})`, '0')
  put(stockProgress, `IF(B${totalBeams}>0,B${completeBeams}/B${totalBeams},0)`, '0.0%')
  put(totalStockLength, `SUM(${b}C$2:$C$${beamsLastRow})/1000`, '0.0')
  put(usedStockLength, `SUMIF(${b}J$2:$J$${beamsLastRow},1,${b}C$2:$C$${beamsLastRow})/1000`, '0.0')
  put(stockMassUsed, `SUMIF(${b}J$2:$J$${beamsLastRow},1,${b}D$2:$D$${beamsLastRow})`, '0.0')
  put(stockLeft, `B${totalStockLength}-B${usedStockLength}`, '0.0')
  put(waste, `SUM(${b}M$2:$M$${beamsLastRow})/1000`, '0.0')

  sheet['!cols'] = [{ wch: 34 }, { wch: 24 }]
  return sheet
}

/** Builds the .xlsx workbook bytes from the plans currently shown in the purchase dialog. */
export function buildPurchaseTrackerWorkbook(
  groups: PurchaseGroupInput[],
  plans: PurchasePlan[],
  jobName = 'job',
): ArrayBuffer {
  const model = buildPurchaseTrackerModel(groups, plans, jobName)
  const partsLastRow = Math.max(2, model.parts.length + 1)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, summarySheet(model), SUMMARY_SHEET)
  XLSX.utils.book_append_sheet(workbook, buyListSheet(model), BUY_LIST_SHEET)
  XLSX.utils.book_append_sheet(workbook, partsSheet(model), PARTS_SHEET)
  XLSX.utils.book_append_sheet(workbook, beamsSheet(model, partsLastRow), BEAMS_SHEET)
  // Formula cells carry no cached value, so Excel / LibreOffice calculate them on open.
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
  return buildPurchaseTrackerWorkbook(groups, plans, jobName)
}
