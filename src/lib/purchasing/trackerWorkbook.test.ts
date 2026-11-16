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
  it('maps every piece to a physical beam', () => {
    const groups = [rhsGroup()]
    const plans = planPurchases(groups, DEFAULT_TRACKER_PURCHASE_OPTIONS)
    const model = buildPurchaseTrackerModel(plans, 'Job')
    const purchased = plans.reduce(
      (sum, plan) => sum + plan.purchases.reduce((count, item) => count + item.count, 0),
      0,
    )
    expect(model.parts).toHaveLength(3)
    expect(model.beams).toHaveLength(purchased)
    expect(model.parts.every((part) => part.beam === model.beams[0]?.beam)).toBe(true)
    expect(model.beams[0]?.marks).toContain('M-1')
  })

  it('pairs T bars into one stock beam', () => {
    const groups = [teeGroup()]
    const plans = planPurchases(groups, DEFAULT_TRACKER_PURCHASE_OPTIONS)
    const model = buildPurchaseTrackerModel(plans, 'Job')
    const purchased = plans.reduce(
      (sum, plan) => sum + plan.purchases.reduce((count, item) => count + item.count, 0),
      0,
    )
    expect(model.parts).toHaveLength(3)
    expect(model.beams).toHaveLength(purchased)
    expect(model.beams[0]?.stock).toBe('200UB29.8')
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

    expect(formulas(nesting).some((formula) => formula.includes('"Cut"'))).toBe(true)
    expect(formulas(marks).some((formula) => formula.includes('Nesting!$E'))).toBe(true)
    expect(formulas(marks).some((formula) => formula.includes('Picked up'))).toBe(true)
    expect(formulas(buy).some((formula) => formula.includes('COUNTIFS'))).toBe(true)
    expect(formulas(buy).every((formula) => !formula.includes('%'))).toBe(true)
  })

  it('uses the plans currently shown instead of recalculating defaults', () => {
    const groups = [rhsGroup()]
    const plans = planPurchases(groups, {
      ...DEFAULT_TRACKER_PURCHASE_OPTIONS,
      stockLengthsMm: [6000],
    })
    const bytes = buildPurchaseTrackerWorkbook(plans, 'NW31')
    const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, sheetStubs: true })
    const nesting = workbook.Sheets.Nesting
    if (!nesting) throw new Error('nesting missing')
    expect(nesting.A2?.v).toContain('B01')
    expect(nesting.C2?.v).toBe(6000)
  })
})
