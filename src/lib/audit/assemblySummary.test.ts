import { describe, expect, it } from 'vitest'
import { type AssemblyPartInput, summarizeAssemblies } from './assemblySummary'
import type { PartListRow } from './schemas'

const part = (overrides: Partial<AssemblyPartInput>): AssemblyPartInput => ({
  mark: 'p1',
  profile: '200UB25.4 (T)',
  lengthMm: 1000,
  massKg: 10,
  status: 'ok',
  assemblies: [{ assembly: 'B1', assemblyQty: 1, qtyPerAssembly: 1, total: 1 }],
  ...overrides,
})

const row = (overrides: Partial<PartListRow>): PartListRow => ({
  part: 'p1',
  qty: 1,
  profile: 'RHS100',
  grade: 'C350',
  length: 100,
  weight: 2,
  ...overrides,
})

describe('summarizeAssemblies', () => {
  it('groups parts by assembly and totals the kit', () => {
    const groups = summarizeAssemblies([
      part({ mark: 'M/1', lengthMm: 2000, massKg: 20 }),
      part({
        mark: 'M/2',
        lengthMm: 500,
        massKg: 5,
        assemblies: [{ assembly: 'B1', assemblyQty: 2, qtyPerAssembly: 2, total: 4 }],
      }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      assembly: 'B1',
      assemblyQty: 2,
      marks: 2,
      piecesPerAssembly: 3,
      pieces: 5,
      lengthMm: 2000 * 1 + 500 * 4,
      massKg: 20 * 1 + 5 * 4,
      errors: 0,
      warnings: 0,
      missing: 0,
    })
    expect(groups[0]?.members.map((member) => member.mark)).toEqual(['M/1', 'M/2'])
  })

  it('counts a part used by two assemblies in both kits', () => {
    const groups = summarizeAssemblies([
      part({
        assemblies: [
          { assembly: 'B1', assemblyQty: 1, qtyPerAssembly: 1, total: 1 },
          { assembly: 'B2', assemblyQty: 3, qtyPerAssembly: 2, total: 6 },
        ],
      }),
    ])
    expect(groups.map((group) => group.assembly)).toEqual(['B1', 'B2'])
    expect(groups.map((group) => group.pieces)).toEqual([1, 6])
    expect(groups[1]?.assemblyQty).toBe(3)
  })

  it('sorts assemblies and members numerically', () => {
    const groups = summarizeAssemblies([
      part({
        mark: 'M/10',
        assemblies: [{ assembly: 'B10', assemblyQty: 1, qtyPerAssembly: 1, total: 1 }],
      }),
      part({
        mark: 'M/2',
        assemblies: [{ assembly: 'B2', assemblyQty: 1, qtyPerAssembly: 1, total: 1 }],
      }),
      part({
        mark: 'M/9',
        assemblies: [{ assembly: 'B2', assemblyQty: 1, qtyPerAssembly: 1, total: 1 }],
      }),
    ])
    expect(groups.map((group) => group.assembly)).toEqual(['B2', 'B10'])
    expect(groups[0]?.members.map((member) => member.mark)).toEqual(['M/2', 'M/9'])
  })

  it('lists a mark with no files as a missing member, not as an absence', () => {
    const groups = summarizeAssemblies(
      [
        part({
          mark: 'M/1',
          assemblies: [{ assembly: 'B1', assemblyQty: 2, qtyPerAssembly: 1, total: 2 }],
        }),
      ],
      [
        row({ part: 'M/1', assembly: 'B1', assemblyQty: 2, qty: 1 }),
        row({
          part: 'M/9',
          assembly: 'B1',
          assemblyQty: 2,
          qty: 3,
          profile: '150UC23.3',
          length: 400,
          weight: 4,
        }),
      ],
    )
    expect(groups[0]).toMatchObject({
      marks: 2,
      piecesPerAssembly: 4,
      pieces: 8,
      missing: 1,
      warnings: 1,
      lengthMm: 1000 * 2 + 400 * 6,
      massKg: 10 * 2 + 4 * 6,
    })
    const missing = groups[0]?.members.find((member) => member.mark === 'M/9')
    expect(missing).toMatchObject({
      profile: '150UC23.3',
      qtyPerAssembly: 3,
      total: 6,
      present: false,
      status: 'warning',
    })
  })

  it('does not add a part-list row for a part that did arrive', () => {
    const groups = summarizeAssemblies(
      [part({ mark: 'M/1' })],
      [row({ part: 'M/1', assembly: 'B1', assemblyQty: 5, qty: 9 })],
    )
    expect(groups[0]?.marks).toBe(1)
    expect(groups[0]?.members[0]).toMatchObject({ present: true, qtyPerAssembly: 1, total: 1 })
  })

  it('sums repeated part-list rows for one missing mark', () => {
    const groups = summarizeAssemblies(
      [],
      [
        row({ part: 'M/9', assembly: 'B1', assemblyQty: 2, qty: 1 }),
        row({ part: 'M/9', assembly: 'B1', assemblyQty: 2, qty: 2 }),
      ],
    )
    expect(groups[0]?.marks).toBe(1)
    expect(groups[0]?.members[0]).toMatchObject({ qtyPerAssembly: 3, total: 6 })
  })

  it('takes the largest assembly quantity when rows disagree', () => {
    const groups = summarizeAssemblies([
      part({
        mark: 'M/1',
        assemblies: [{ assembly: 'B1', assemblyQty: 1, qtyPerAssembly: 1, total: 1 }],
      }),
      part({
        mark: 'M/2',
        assemblies: [{ assembly: 'B1', assemblyQty: 4, qtyPerAssembly: 1, total: 4 }],
      }),
    ])
    expect(groups[0]?.assemblyQty).toBe(4)
  })

  it('ignores members whose length or mass is unknown instead of zeroing the total', () => {
    const groups = summarizeAssemblies([
      part({ mark: 'M/1', lengthMm: 1000, massKg: 10 }),
      part({
        mark: 'M/2',
        lengthMm: null,
        massKg: null,
        assemblies: [{ assembly: 'B1', assemblyQty: 1, qtyPerAssembly: 2, total: 2 }],
      }),
    ])
    expect(groups[0]?.lengthMm).toBe(1000)
    expect(groups[0]?.massKg).toBe(10)
    expect(groups[0]?.pieces).toBe(3)
  })

  it('counts finding status per member', () => {
    const groups = summarizeAssemblies([
      part({ mark: 'M/1', status: 'error' }),
      part({
        mark: 'M/2',
        status: 'warning',
        assemblies: [{ assembly: 'B1', assemblyQty: 1, qtyPerAssembly: 1, total: 1 }],
      }),
      part({
        mark: 'M/3',
        status: 'info',
        assemblies: [{ assembly: 'B1', assemblyQty: 1, qtyPerAssembly: 1, total: 1 }],
      }),
    ])
    expect(groups[0]).toMatchObject({ errors: 1, warnings: 1, missing: 0 })
  })

  it('returns nothing for a job without assembly rows', () => {
    expect(summarizeAssemblies([part({ assemblies: [] })], [row({ qty: 4 })])).toEqual([])
  })

  it('attaches the assembly drawing named after the assembly mark', () => {
    const groups = summarizeAssemblies(
      [part({ assemblies: [{ assembly: 'B/12', assemblyQty: 1, qtyPerAssembly: 1, total: 1 }] })],
      [],
      new Map([['b12', 'PDF/B_12  ASSEMBLY.pdf']]),
    )
    expect(groups[0]?.drawingPath).toBe('PDF/B_12  ASSEMBLY.pdf')
  })

  it('leaves the drawing empty when only a part shares the assembly name', () => {
    const groups = summarizeAssemblies(
      [part({ mark: 'M/1' })],
      [],
      new Map([['m/1', 'PDF/M_1.pdf']]),
    )
    expect(groups[0]?.drawingPath).toBeNull()
  })
})
