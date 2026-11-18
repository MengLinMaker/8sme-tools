import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { type PurchaseGroupInput, planPurchases } from './purchase'
import {
  buildPurchaseTrackerModel,
  buildPurchaseTrackerWorkbook,
  buildPurchaseTrackerWorkbookForGroups,
  DEFAULT_TRACKER_PURCHASE_OPTIONS,
} from './trackerWorkbook'

function rhsGroup(): PurchaseGroupInput {
  return {
    key: 'profile:150x100x6 RHS',
    stock: '150x100x6 RHS',
    sources: ['150x100x6 RHS'],
    tee: false,
    massPerMetre: 21.3,
    pieces: [
      { mark: 'M-1', lengthMm: 3000, quantity: 2 },
      { mark: 'M-2', lengthMm: 2000, quantity: 1 },
    ],
  }
}

function teeGroup(): PurchaseGroupInput {
  return {
    key: 'tee:200UB29.8',
    stock: '200UB29.8',
    sources: ['BT100*15'],
    tee: true,
    massPerMetre: 29.8,
    pieces: [
      { mark: 'T-1', lengthMm: 3000, quantity: 2 },
      { mark: 'T-2', lengthMm: 2000, quantity: 1 },
    ],
  }
}

function formulas(sheet: XLSX.WorkSheet): string[] {
  return Object.values(sheet as Record<string, unknown>).flatMap((cell) => {
    if (!cell || typeof cell !== 'object') return []
    const formula = (cell as { f?: unknown }).f
    return typeof formula === 'string' ? [formula] : []
  })
}

describe('buildPurchaseTrackerModel', () => {
  it('rolls pieces up into layouts and marks with quantities', () => {
    const groups = [rhsGroup()]
    const plans = planPurchases(groups, DEFAULT_TRACKER_PURCHASE_OPTIONS)
    const model = buildPurchaseTrackerModel(groups, plans, 'Job')
    expect(model.layouts).toHaveLength(1)
    expect(model.layouts[0]?.qty).toBe(1)
    expect(model.marks.find((mark) => mark.mark === 'M-1')?.qty).toBe(2)
    expect(model.marks.find((mark) => mark.mark === 'M-2')?.qty).toBe(1)
  })

  it('pairs T bars into one stock layout', () => {
    const groups = [teeGroup()]
    const plans = planPurchases(groups, DEFAULT_TRACKER_PURCHASE_OPTIONS)
    const model = buildPurchaseTrackerModel(groups, plans, 'Job')
    expect(model.layouts).toHaveLength(1)
    expect(model.layouts[0]?.stock).toBe('200UB29.8')
    expect(model.marks.find((mark) => mark.mark === 'T-1')?.qty).toBe(2)
  })
})

describe('buildPurchaseTrackerWorkbook', () => {
  it('writes nesting, marks and parts-to-buy sheets with auto formulas', () => {
    const bytes = buildPurchaseTrackerWorkbookForGroups([rhsGroup()], 'NW31')
    const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, sheetStubs: true })
    expect(workbook.SheetNames).toEqual(['Nesting', 'Marks', 'Parts to buy'])

    const nesting = workbook.Sheets.Nesting
    const marks = workbook.Sheets.Marks
    const buy = workbook.Sheets['Parts to buy']
    if (!nesting || !marks || !buy) throw new Error('sheet missing')

    expect(nesting.A1?.v).toBe('Layout')
    expect(nesting.E1?.v).toBe('Qty')
    expect(nesting.F1?.v).toBe('Cut')
    expect(marks.B1?.v).toBe('Profile')
    expect(marks.C1?.v).toBe('Qty')
    expect(marks.D1?.v).toBe('Cut')
    expect(formulas(marks).some((formula) => formula.includes('Nesting!$F'))).toBe(true)
    expect(formulas(marks).some((formula) => formula.includes('*2'))).toBe(true)
    expect(formulas(buy).some((formula) => formula.includes('SUMIF'))).toBe(true)
    expect(formulas(buy).some((formula) => formula.includes('Nesting!$A'))).toBe(true)
    expect(formulas(buy).every((formula) => !formula.includes('Nesting!$B'))).toBe(true)
    expect(formulas(buy).every((formula) => !formula.includes('%'))).toBe(true)
    expect(formulas(nesting).some((formula) => formula.startsWith('SUM(E2:E'))).toBe(true)
    expect(formulas(marks).some((formula) => formula.startsWith('SUM(C2:C'))).toBe(true)
    expect(formulas(buy).some((formula) => formula.startsWith('SUM(D2:D'))).toBe(true)
    expect(buy.A2?.v).toBe('RHS')
    expect(buy.B2?.v).toBe('150×100×6')
  })

  it('merges repeated family/size labels in Parts to buy', () => {
    const groups: PurchaseGroupInput[] = [
      rhsGroup(),
      {
        ...rhsGroup(),
        key: 'profile:200x100x6 RHS',
        stock: '200x100x6 RHS',
        sources: ['200x100x6 RHS'],
        pieces: [{ mark: 'M-2', lengthMm: 2000, quantity: 1 }],
      },
    ]
    const plans = planPurchases(groups, DEFAULT_TRACKER_PURCHASE_OPTIONS)
    const bytes = buildPurchaseTrackerWorkbook(groups, plans, 'NW31')
    const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, sheetStubs: true })
    expect(workbook.Sheets['Parts to buy']?.['!merges']?.length).toBeGreaterThan(0)
  })

  it('uses the plans currently shown instead of recalculating defaults', () => {
    const groups = [rhsGroup()]
    const plans = planPurchases(groups, {
      ...DEFAULT_TRACKER_PURCHASE_OPTIONS,
      stockLengthsMm: [6000],
    })
    const bytes = buildPurchaseTrackerWorkbook(groups, plans, 'NW31')
    const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, sheetStubs: true })
    const nesting = workbook.Sheets.Nesting
    if (!nesting) throw new Error('nesting missing')
    expect(nesting.A2?.v).toContain('L01')
    expect(nesting.C2?.v).toBe(6000)
    expect(nesting['!merges']?.length).toBeGreaterThan(0)
  })

  it('writes live status and 0/partial/full colour rules', () => {
    const bytes = buildPurchaseTrackerWorkbookForGroups([rhsGroup()], 'NW31')
    const files = unzipSync(new Uint8Array(bytes))
    const decoder = new TextDecoder()
    const marks = decoder.decode(files['xl/worksheets/sheet2.xml'])
    const buy = decoder.decode(files['xl/worksheets/sheet3.xml'])
    const styles = decoder.decode(files['xl/styles.xml'])
    expect(marks).toContain('conditionalFormatting')
    expect(marks).toContain('Picked up')
    expect(marks).toContain('In progress')
    expect(buy).toContain('conditionalFormatting')
    expect(styles).toContain('<dxfs count="4">')
  })

  it('freezes the header row on every sheet', () => {
    const bytes = buildPurchaseTrackerWorkbookForGroups([rhsGroup()], 'NW31')
    const files = unzipSync(new Uint8Array(bytes))
    const decoder = new TextDecoder()
    for (const file of [
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ]) {
      const xml = decoder.decode(files[file])
      expect(xml).toContain('state="frozen"')
      expect(xml).toContain('ySplit="1"')
      expect(xml).toContain('topLeftCell="A2"')
      expect(xml).not.toContain('xSplit')
    }
  })
})
