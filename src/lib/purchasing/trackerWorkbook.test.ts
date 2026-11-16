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
    const model = buildPurchaseTrackerModel(groups, plans, 'Job')
    const purchased = plans.reduce(
      (sum, plan) => sum + plan.purchases.reduce((count, item) => count + item.count, 0),
      0,
    )
    expect(model.parts).toHaveLength(3)
    expect(model.beams).toHaveLength(purchased)
    expect(model.parts.every((part) => part.beam === model.beams[0]?.beam)).toBe(true)
    expect(model.beams[0]?.parts).toBe(3)
    expect(model.beams[0]?.pieces).toContain('M-1')
    expect(model.parts.every((part) => part.massKg > 0)).toBe(true)
  })

  it('pairs T bars into one stock beam', () => {
    const groups = [teeGroup()]
    const plans = planPurchases(groups, DEFAULT_TRACKER_PURCHASE_OPTIONS)
    const model = buildPurchaseTrackerModel(groups, plans, 'Job')
    const purchased = plans.reduce(
      (sum, plan) => sum + plan.purchases.reduce((count, item) => count + item.count, 0),
      0,
    )
    expect(model.parts).toHaveLength(3)
    expect(model.beams).toHaveLength(purchased)
    expect(model.beams[0]?.stock).toBe('200UB29.8')
    expect(model.beams[0]?.parts).toBe(3)
  })
})

describe('buildPurchaseTrackerWorkbook', () => {
  it('writes summary, parts and beams sheets with formulas', () => {
    const bytes = buildPurchaseTrackerWorkbookForGroups([rhsGroup()], 'NW31')
    const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, sheetStubs: true })
    expect(workbook.SheetNames).toEqual(['Summary', 'Buy list', 'Parts', 'Beams'])

    const parts = workbook.Sheets.Parts
    const beams = workbook.Sheets.Beams
    const summary = workbook.Sheets.Summary
    const buyList = workbook.Sheets['Buy list']
    if (!parts || !beams || !summary || !buyList) throw new Error('sheet missing')

    expect(formulas(parts).some((formula) => formula.includes('Picked up'))).toBe(true)
    expect(formulas(beams).some((formula) => formula.includes('SUMIF'))).toBe(true)
    expect(formulas(beams).some((formula) => formula.includes('E2-G2'))).toBe(true)
    expect(formulas(summary).some((formula) => formula.includes('COUNTA'))).toBe(true)
    expect(formulas(summary).some((formula) => formula.includes('SUMIF'))).toBe(true)
    expect(formulas(buyList).some((formula) => formula.includes('COUNTIFS'))).toBe(true)
  })

  it('uses the plans currently shown instead of recalculating defaults', () => {
    const groups = [rhsGroup()]
    const plans = planPurchases(groups, {
      ...DEFAULT_TRACKER_PURCHASE_OPTIONS,
      stockLengthsMm: [6000],
    })
    const bytes = buildPurchaseTrackerWorkbook(groups, plans, 'NW31')
    const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, sheetStubs: true })
    const beams = workbook.Sheets.Beams
    if (!beams) throw new Error('beams missing')
    expect(beams.A2?.v).toContain('B01')
    expect(beams.C2?.v).toBe(6000)
  })

  it('puts the job name on the summary sheet', () => {
    const bytes = buildPurchaseTrackerWorkbookForGroups([rhsGroup()], 'NW31 Top frames')
    const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, sheetStubs: true })
    const summary = workbook.Sheets.Summary
    if (!summary) throw new Error('summary missing')
    const values = Object.values(summary as Record<string, unknown>)
      .map((cell) => (cell && typeof cell === 'object' ? (cell as { v?: unknown }).v : undefined))
      .filter((value): value is string => typeof value === 'string')
    expect(values).toContain('NW31 Top frames')
  })
})
