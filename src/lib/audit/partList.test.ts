import { describe, expect, it } from 'vitest'
import { aggregatePartList } from './partList'
import type { PartListRow } from './schemas'

const row = (overrides: Partial<PartListRow>): PartListRow => ({
  part: 'p1',
  qty: 1,
  profile: 'RHS100',
  grade: 'C350',
  length: 100,
  weight: 2,
  ...overrides,
})

describe('aggregatePartList', () => {
  it('keeps a plain part list unchanged', () => {
    const { expected, assemblies } = aggregatePartList([row({ qty: 3 })])
    expect(expected.get('p1')).toMatchObject({ part: 'p1', qty: 3 })
    expect(assemblies.size).toBe(0)
  })

  it('totals a part across assemblies and records each usage', () => {
    const { expected, assemblies } = aggregatePartList([
      row({ assembly: 'A1', assemblyQty: 2, qty: 1 }),
      row({ part: 'p2', assembly: 'A1', assemblyQty: 2, qty: 3 }),
      row({ assembly: 'A2', assemblyQty: 4, qty: 2 }),
    ])
    expect(expected.get('p1')?.qty).toBe(2 * 1 + 4 * 2)
    expect(assemblies.get('p1')).toEqual([
      { assembly: 'A1', assemblyQty: 2, qtyPerAssembly: 1, total: 2 },
      { assembly: 'A2', assemblyQty: 4, qtyPerAssembly: 2, total: 8 },
    ])
    expect(assemblies.get('p2')).toEqual([
      { assembly: 'A1', assemblyQty: 2, qtyPerAssembly: 3, total: 6 },
    ])
  })

  it('sums repeated rows for the same part in one assembly', () => {
    const { expected, assemblies } = aggregatePartList([
      row({ assembly: 'A1', assemblyQty: 2, qty: 1 }),
      row({ assembly: 'A1', assemblyQty: 2, qty: 2 }),
    ])
    expect(expected.get('p1')?.qty).toBe(6)
    expect(assemblies.get('p1')).toEqual([
      { assembly: 'A1', assemblyQty: 2, qtyPerAssembly: 3, total: 6 },
    ])
  })

  it('leaves the quantity null when no row gives one', () => {
    const { expected } = aggregatePartList([row({ assembly: 'A1', assemblyQty: 2, qty: null })])
    expect(expected.get('p1')?.qty).toBeNull()
  })
})
