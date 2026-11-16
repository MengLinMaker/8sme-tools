/**
 * Formula-driven cut / pick-up tracker built from the purchase plans.
 *
 * Identical beams are grouped into layouts with a quantity. On the Nesting sheet enter how many
 * of that layout have been cut; every mark on it gets that many pieces counted as Cut on the Marks
 * sheet, and Parts to buy sums the cut beams per stock/length. No per-piece rows, no macros.
 */

import { unzipSync, zipSync } from 'fflate'
import type { CellStyle } from 'xlsx-js-style'
import * as XLSX from 'xlsx-js-style'
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

const NESTING_HEADER = ['Layout', 'Stock', 'Length mm', 'Marks', 'Qty', 'Cut'] as const
const MARKS_HEADER = ['Mark', 'Qty', 'Cut', 'Picked up', 'Status'] as const
const BUY_HEADER = ['Family', 'Size', 'Length (m)', 'Qty', 'Cut'] as const

export interface TrackerMarkCount {
  mark: string
  count: number
}

export interface TrackerLayoutRow {
  layout: string
  stock: string
  stockLength: number
  marks: string
  qty: number
  perMark: TrackerMarkCount[]
}

export interface TrackerMarkRow {
  mark: string
  qty: number
  contributions: { layout: string; perBeam: number }[]
}

export interface PurchaseTrackerModel {
  jobName: string
  layouts: TrackerLayoutRow[]
  marks: TrackerMarkRow[]
}

/** Same defaults the purchase calculator starts from, so the tracker matches its first view. */
export const DEFAULT_TRACKER_PURCHASE_OPTIONS: PurchaseOptions = {
  stockLengthsMm: DEFAULT_STOCK_LENGTHS_MM,
  marginMm: DEFAULT_CHUCK_MARGIN_MM,
  onePersonKg: DEFAULT_ONE_PERSON_KG,
  twoPersonKg: DEFAULT_TWO_PERSON_KG,
  reusableOffcutMm: REUSABLE_OFFCUT_MM,
}

function markCounts(units: { mark: string }[]): TrackerMarkCount[] {
  const counts = new Map<string, number>()
  for (const unit of units) counts.set(unit.mark, (counts.get(unit.mark) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([mark, count]) => ({ mark, count }))
}

function summarize(perMark: TrackerMarkCount[]): string {
  return perMark.map(({ mark, count }) => `${mark} ×${count}`).join(' | ')
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

/** Group identical beams into layouts, then roll every layout into mark totals. */
export function buildPurchaseTrackerModel(
  plans: PurchasePlan[],
  jobName = '',
): PurchaseTrackerModel {
  const byLayout = new Map<string, TrackerLayoutRow>()
  let layoutNo = 0

  for (const plan of plans) {
    if (plan.pieceCount === 0) continue
    for (const bars of beamBars(plan)) {
      const first = bars[0]
      if (!first) continue
      const units = bars.flatMap((bar) => bar.units)
      const perMark = markCounts(units)
      const key = `${plan.stock}|${first.stockLengthMm}|${perMark
        .map(({ mark, count }) => `${mark}:${count}`)
        .join(',')}`
      const found = byLayout.get(key)
      if (found) {
        found.qty++
        continue
      }
      layoutNo++
      byLayout.set(key, {
        layout: `${plan.stock}-L${String(layoutNo).padStart(2, '0')}`,
        stock: plan.stock,
        stockLength: first.stockLengthMm,
        marks: summarize(perMark),
        qty: 1,
        perMark,
      })
    }
  }

  const layouts = [...byLayout.values()].sort(
    (a, b) =>
      a.stock.localeCompare(b.stock) ||
      a.stockLength - b.stockLength ||
      a.layout.localeCompare(b.layout, undefined, { numeric: true }),
  )

  const byMark = new Map<string, TrackerMarkRow>()
  for (const layout of layouts) {
    for (const { mark, count } of layout.perMark) {
      const found = byMark.get(mark) ?? { mark, qty: 0, contributions: [] }
      found.qty += count * layout.qty
      found.contributions.push({ layout: layout.layout, perBeam: count })
      byMark.set(mark, found)
    }
  }

  const marks = [...byMark.values()].sort((a, b) =>
    a.mark.localeCompare(b.mark, undefined, { numeric: true }),
  )
  return { jobName, layouts, marks }
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

const BORDER = { color: { rgb: 'BFBFBF' }, style: 'thin' as const }

const HEADER_STYLE: CellStyle = {
  font: { bold: true, color: { rgb: 'FFFFFF' } },
  fill: { fgColor: { rgb: '1F4E78' } },
  alignment: { horizontal: 'center', vertical: 'center' },
  border: { bottom: BORDER },
}

const GROUP_STYLE: CellStyle = {
  font: { bold: true, color: { rgb: '1F4E78' } },
  fill: { fgColor: { rgb: 'DDEBF7' } },
  alignment: { vertical: 'center' },
}

const INPUT_STYLE: CellStyle = {
  fill: { fgColor: { rgb: 'FFF2CC' } },
  font: { bold: true },
  alignment: { horizontal: 'center' },
  border: { bottom: BORDER, top: BORDER, left: BORDER, right: BORDER },
}

const CALC_STYLE: CellStyle = {
  fill: { fgColor: { rgb: 'F2F2F2' } },
  alignment: { horizontal: 'center' },
  border: { bottom: BORDER, top: BORDER, left: BORDER, right: BORDER },
}

const STATUS_STYLE: CellStyle = {
  fill: { fgColor: { rgb: 'E7E6E6' } },
  font: { bold: true, color: { rgb: '404040' } },
  alignment: { horizontal: 'center' },
  border: { bottom: BORDER, top: BORDER, left: BORDER, right: BORDER },
}

const TOTAL_STYLE: CellStyle = {
  font: { bold: true, color: { rgb: '1F1F1F' } },
  fill: { fgColor: { rgb: 'C6E0B4' } },
  border: { top: { color: { rgb: '375623' }, style: 'medium' }, bottom: BORDER },
}

function styleCell(sheet: XLSX.WorkSheet, row: number, col: number, style: CellStyle): void {
  const address = XLSX.utils.encode_cell({ r: row, c: col })
  const cell = (sheet[address] ?? { t: 's', v: '' }) as XLSX.CellObject
  cell.s = style
  sheet[address] = cell
}

function styleRow(
  sheet: XLSX.WorkSheet,
  row: number,
  cols: number,
  style: CellStyle,
  from = 0,
): void {
  for (let col = from; col < cols; col++) styleCell(sheet, row, col, style)
}

/** The sheet the shop works on: Qty is the number of identical beams; enter how many are cut. */
function nestingSheet(model: PurchaseTrackerModel): XLSX.WorkSheet {
  const dataLast = model.layouts.length + 1
  const totalRow = dataLast + 1
  const rows: (string | number)[][] = [
    [...NESTING_HEADER],
    ...model.layouts.map((layout) => [
      layout.layout,
      layout.stock,
      layout.stockLength,
      layout.marks,
      layout.qty,
      0,
    ]),
    ['TOTAL', '', '', '', '', ''],
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  setFormula(sheet, totalRow - 1, 4, `SUM(E2:E${dataLast})`)
  setFormula(sheet, totalRow - 1, 5, `SUM(F2:F${dataLast})`)
  sheet['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 40 }, { wch: 8 }, { wch: 8 }]
  sheet['!autofilter'] = { ref: `A1:F${Math.max(1, dataLast)}` }
  addRunMerges(
    sheet,
    model.layouts.map((layout) => layout.stock),
    1,
  )
  addRunMerges(
    sheet,
    model.layouts.map((layout) => `${layout.stock}|${layout.stockLength}`),
    2,
  )

  styleRow(sheet, 0, 6, HEADER_STYLE)
  model.layouts.forEach((_, index) => {
    const row = index + 1
    styleCell(sheet, row, 1, GROUP_STYLE)
    styleCell(sheet, row, 2, GROUP_STYLE)
    styleCell(sheet, row, 4, CALC_STYLE)
    styleCell(sheet, row, 5, INPUT_STYLE)
  })
  styleRow(sheet, totalRow - 1, 6, TOTAL_STYLE)
  return sheet
}

/** One row per mark: Qty total, Cut auto-counted from the layouts, Picked up by hand. */
function marksSheet(model: PurchaseTrackerModel): XLSX.WorkSheet {
  const dataLast = model.marks.length + 1
  const totalRow = dataLast + 1
  const rows: (string | number)[][] = [
    [...MARKS_HEADER],
    ...model.marks.map((mark) => [mark.mark, mark.qty, '', 0, '']),
    ['TOTAL', '', '', '', ''],
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const nestingLastRow = Math.max(2, model.layouts.length + 1)
  model.marks.forEach((mark, index) => {
    const row = index + 2
    const cut =
      mark.contributions
        .map(
          ({ layout, perBeam }) =>
            `SUMIF(Nesting!$A$2:$A$${nestingLastRow},"${layout}",Nesting!$F$2:$F$${nestingLastRow})*${perBeam}`,
        )
        .join('+') || '0'
    setFormula(sheet, row - 1, 2, cut)
    setFormula(
      sheet,
      row - 1,
      4,
      `IF(D${row}>=B${row},"Picked up",IF(C${row}>=B${row},"Cut",IF(C${row}>0,"In progress","Pending")))`,
      's',
    )
  })
  setFormula(sheet, totalRow - 1, 1, `SUM(B2:B${dataLast})`)
  setFormula(sheet, totalRow - 1, 2, `SUM(C2:C${dataLast})`)
  setFormula(sheet, totalRow - 1, 3, `SUM(D2:D${dataLast})`)
  sheet['!cols'] = [{ wch: 16 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 11 }]
  sheet['!autofilter'] = { ref: `A1:E${Math.max(1, dataLast)}` }

  styleRow(sheet, 0, 5, HEADER_STYLE)
  model.marks.forEach((_, index) => {
    const row = index + 1
    styleCell(sheet, row, 1, CALC_STYLE)
    styleCell(sheet, row, 2, CALC_STYLE)
    styleCell(sheet, row, 3, INPUT_STYLE)
    styleCell(sheet, row, 4, STATUS_STYLE)
  })
  styleRow(sheet, totalRow - 1, 5, TOTAL_STYLE)
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

/** Merge runs of identical values so repeated family/size labels read as one group. */
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

/** Quantity to buy per stock/length, with the number of those beams already cut. */
function buyListSheet(model: PurchaseTrackerModel): XLSX.WorkSheet {
  const grouped = new Map<
    string,
    { stock: string; family: string; size: string; length: number; qty: number }
  >()
  for (const layout of model.layouts) {
    const key = `${layout.stock}|${layout.stockLength}`
    const found = grouped.get(key)
    if (found) found.qty += layout.qty
    else {
      const { family, size } = splitStock(layout.stock)
      grouped.set(key, {
        stock: layout.stock,
        family,
        size,
        length: layout.stockLength,
        qty: layout.qty,
      })
    }
  }
  const buys = [...grouped.values()].sort(
    (a, b) =>
      a.family.localeCompare(b.family) ||
      a.size.localeCompare(b.size, undefined, { numeric: true }) ||
      a.length - b.length,
  )
  const dataLast = buys.length + 1
  const totalRow = dataLast + 1
  const rows: (string | number)[][] = [
    [...BUY_HEADER],
    ...buys.map((buy) => [buy.family, buy.size, (buy.length / 1000).toFixed(1), buy.qty, '']),
    ['TOTAL', '', '', '', ''],
  ]
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const nestingLastRow = Math.max(2, model.layouts.length + 1)
  buys.forEach((buy, index) => {
    const row = index + 2
    // Layout ids are never merged, so the cut total stays correct under stock/length merges.
    const formula =
      model.layouts
        .filter((layout) => layout.stock === buy.stock && layout.stockLength === buy.length)
        .map((layout) => {
          const id = layout.layout.replace(/"/g, '""')
          return `SUMIF(Nesting!$A$2:$A$${nestingLastRow},"${id}",Nesting!$F$2:$F$${nestingLastRow})`
        })
        .join('+') || '0'
    setFormula(sheet, row - 1, 4, formula)
  })
  setFormula(sheet, totalRow - 1, 3, `SUM(D2:D${dataLast})`)
  setFormula(sheet, totalRow - 1, 4, `SUM(E2:E${dataLast})`)
  sheet['!cols'] = [{ wch: 10 }, { wch: 16 }, { wch: 11 }, { wch: 8 }, { wch: 8 }]
  sheet['!autofilter'] = { ref: `A1:E${Math.max(1, dataLast)}` }
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

  styleRow(sheet, 0, 5, HEADER_STYLE)
  buys.forEach((_, index) => {
    const row = index + 1
    styleCell(sheet, row, 0, GROUP_STYLE)
    styleCell(sheet, row, 1, GROUP_STYLE)
    styleCell(sheet, row, 3, CALC_STYLE)
    styleCell(sheet, row, 4, CALC_STYLE)
  })
  styleRow(sheet, totalRow - 1, 5, TOTAL_STYLE)
  return sheet
}

interface CfRule {
  dxf: number
  formula: string
}

interface CfRange {
  sqref: string
  rules: CfRule[]
}

const DXF_BLOCK = `<dxfs count="4">
<dxf><fill><patternFill><bgColor rgb="FFD9D9D9"/></patternFill></fill></dxf>
<dxf><fill><patternFill><bgColor rgb="FFFFEB9C"/></patternFill></fill></dxf>
<dxf><fill><patternFill><bgColor rgb="FFC6EFCE"/></patternFill></fill></dxf>
<dxf><fill><patternFill><bgColor rgb="FFBDD7EE"/></patternFill></fill></dxf>
</dxfs>`

/**
 * xlsx-js-style has no conditional-formatting writer, so lift the styles/fills into the generated
 * package. This keeps the status and 0/partial/full colours live as the shop edits the workbook.
 */
function addConditionalFormatting(
  bytes: ArrayBuffer,
  sheets: { file: string; ranges: CfRange[] }[],
): ArrayBuffer {
  const files = unzipSync(new Uint8Array(bytes))
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  const stylesFile = files['xl/styles.xml']
  if (stylesFile) {
    const styles = decoder.decode(stylesFile).replace(/<dxfs count="0"\/>/, DXF_BLOCK)
    files['xl/styles.xml'] = encoder.encode(styles)
  }

  for (const { file, ranges } of sheets) {
    const sheetFile = files[file]
    if (!sheetFile) continue
    let xml = decoder.decode(sheetFile)
    let priority = 1
    const blocks = ranges
      .map((range) => {
        const rules = range.rules
          .map(
            (rule) =>
              `<cfRule type="expression" dxfId="${rule.dxf}" priority="${priority++}"><formula>${rule.formula}</formula></cfRule>`,
          )
          .join('')
        return `<conditionalFormatting sqref="${range.sqref}">${rules}</conditionalFormatting>`
      })
      .join('')

    xml = xml.includes('<ignoredErrors')
      ? xml.replace('<ignoredErrors', `${blocks}<ignoredErrors`)
      : xml.replace('</worksheet>', `${blocks}</worksheet>`)
    files[file] = encoder.encode(xml)
  }

  const output = zipSync(files)
  return output.buffer.slice(
    output.byteOffset,
    output.byteOffset + output.byteLength,
  ) as ArrayBuffer
}

/** Builds the .xlsx workbook from the plans currently shown in the purchase dialog. */
export function buildPurchaseTrackerWorkbook(plans: PurchasePlan[], jobName = 'job'): ArrayBuffer {
  const model = buildPurchaseTrackerModel(plans, jobName)
  const nestingLast = Math.max(2, model.layouts.length + 1)
  const marksLast = Math.max(2, model.marks.length + 1)
  const buyLast = Math.max(
    2,
    new Set(model.layouts.map((layout) => `${layout.stock}|${layout.stockLength}`)).size + 1,
  )
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, nestingSheet(model), NESTING_SHEET)
  XLSX.utils.book_append_sheet(workbook, marksSheet(model), MARKS_SHEET)
  XLSX.utils.book_append_sheet(workbook, buyListSheet(model), BUY_LIST_SHEET)
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer

  return addConditionalFormatting(bytes, [
    {
      file: 'xl/worksheets/sheet1.xml',
      ranges: [
        {
          sqref: `F2:F${nestingLast}`,
          rules: [
            { dxf: 0, formula: 'F2=0' },
            { dxf: 1, formula: 'AND(F2&gt;0,F2&lt;E2)' },
            { dxf: 2, formula: 'F2&gt;=E2' },
          ],
        },
      ],
    },
    {
      file: 'xl/worksheets/sheet2.xml',
      ranges: [
        {
          sqref: `C2:C${marksLast}`,
          rules: [
            { dxf: 0, formula: 'C2=0' },
            { dxf: 1, formula: 'AND(C2&gt;0,C2&lt;B2)' },
            { dxf: 2, formula: 'C2&gt;=B2' },
          ],
        },
        {
          sqref: `D2:D${marksLast}`,
          rules: [
            { dxf: 0, formula: 'D2=0' },
            { dxf: 1, formula: 'AND(D2&gt;0,D2&lt;B2)' },
            { dxf: 2, formula: 'D2&gt;=B2' },
          ],
        },
        {
          sqref: `E2:E${marksLast}`,
          rules: [
            { dxf: 0, formula: '$E2=&quot;Pending&quot;' },
            { dxf: 1, formula: '$E2=&quot;In progress&quot;' },
            { dxf: 3, formula: '$E2=&quot;Cut&quot;' },
            { dxf: 2, formula: '$E2=&quot;Picked up&quot;' },
          ],
        },
      ],
    },
    {
      file: 'xl/worksheets/sheet3.xml',
      ranges: [
        {
          sqref: `E2:E${buyLast}`,
          rules: [
            { dxf: 0, formula: 'E2=0' },
            { dxf: 1, formula: 'AND(E2&gt;0,E2&lt;D2)' },
            { dxf: 2, formula: 'E2&gt;=D2' },
          ],
        },
      ],
    },
  ])
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
