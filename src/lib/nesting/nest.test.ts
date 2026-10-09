import { describe, expect, it } from 'vitest'
import { buildTeeUnits, nestGroup, type TeeGroup, ubLayouts } from './nest'

const UNLIMITED = Number.POSITIVE_INFINITY

function makeGroup(lengths: [number, number][]): TeeGroup {
  const parts = lengths.map(([length, quantity], index) => ({
    mark: `m${index}`,
    section: 'BT100*15',
    parentUb: '200UB29.8',
    mass: 29.8,
    length,
    quantity,
  }))
  return {
    parentUb: '200UB29.8',
    mass: 29.8,
    parts,
    teeCount: parts.reduce((sum, p) => sum + p.quantity, 0),
    totalLength: parts.reduce((sum, p) => sum + p.quantity * p.length, 0),
  }
}

/** One part per length (qty 1), as in the real job. */
function lengthsToGroup(lengths: number[]): TeeGroup {
  const parts = lengths.map((length, index) => ({
    mark: `m${index}`,
    section: 'BT100*15',
    parentUb: '200UB29.8',
    mass: 29.8,
    length,
    quantity: 1,
  }))
  return {
    parentUb: '200UB29.8',
    mass: 29.8,
    parts,
    teeCount: lengths.length,
    totalLength: lengths.reduce((sum, l) => sum + l, 0),
  }
}

describe('buildTeeUnits', () => {
  it('makes one unit per T', () => {
    const units = buildTeeUnits(makeGroup([[2000, 3]]))
    expect(units.map((u) => u.length)).toEqual([2000, 2000, 2000])
    expect(units[0]?.mark).toBe('m0')
  })
})

describe('nestGroup', () => {
  it('packs T’s into two independent T bars per stock UB', () => {
    const result = nestGroup(
      makeGroup([
        [5000, 1],
        [3000, 1],
        [2000, 1],
      ]),
      {
        stock: [{ length: 12000, count: UNLIMITED }],
        kerf: 0,
      },
    )
    expect(result.ubCount).toBe(1)
    expect(result.teeBarCount).toBe(2)
    expect(result.ubBars[0]?.teeBars[0].units.map((u) => u.length)).toEqual([2000, 3000, 5000])
  })

  it('opens another UB when both T bars are full', () => {
    const result = nestGroup(makeGroup([[3000, 3]]), {
      stock: [{ length: 4000, count: UNLIMITED }],
      kerf: 0,
    })
    expect(result.ubCount).toBe(2)
    expect(result.teeBarCount).toBe(4)
  })

  it('reports T’s longer than any stock as oversized', () => {
    const result = nestGroup(makeGroup([[13000, 1]]), {
      stock: [{ length: 12000, count: UNLIMITED }],
      kerf: 0,
    })
    expect(result.oversized).toHaveLength(1)
    expect(result.ubCount).toBe(0)
  })

  it('reserves a leftover allowance', () => {
    const result = nestGroup(makeGroup([[3000, 2]]), {
      stock: [{ length: 6000, count: UNLIMITED }],
      kerf: 0,
      leftover: 300,
    })
    expect(result.ubCount).toBe(1)
    expect(result.ubBars[0]?.teeBars[0].units).toHaveLength(1)
    expect(result.ubBars[0]?.teeBars[1].units).toHaveLength(1)
  })

  it('groups identical beams with a quantity', () => {
    const result = nestGroup(makeGroup([[3000, 4]]), {
      stock: [{ length: 4000, count: UNLIMITED }],
      kerf: 0,
    })
    const layouts = ubLayouts(result)
    expect(layouts).toHaveLength(1)
    expect(layouts[0]?.quantity).toBe(2)
  })

  it('flags cuts that land on the same line across the two halves', () => {
    const result = nestGroup(makeGroup([[7000, 2]]), {
      stock: [{ length: 12000, count: UNLIMITED }],
      kerf: 0,
      minSeparation: 10,
    })
    // left [7000] and right [7000] -> a cut on the same line
    expect(result.cutConflicts.length).toBeGreaterThan(0)
  })
})

describe('regression: NW31 top frames T lengths', () => {
  // Real T lengths (mm) from the NW31 Top frames job — 31 T's, total 67631 mm.
  const LENGTHS = [
    2591, 2698, 2661, 1991, 2505, 2367, 2252, 2002, 1992, 1879, 2093, 2371, 2429, 2500, 2479, 2400,
    2319, 2247, 2177, 2101, 2043, 1982, 1939, 2308, 1892, 1906, 1891, 1881, 1890, 1912, 1933,
  ]

  it('keeps total stock (UB length) low at 12 m', () => {
    const result = nestGroup(lengthsToGroup(LENGTHS), {
      stock: [{ length: 12000, count: UNLIMITED }],
      kerf: 3,
    })
    const material = result.ubCount * 12000
    const theoreticalMinBars = Math.ceil(result.totalTeeLength / 12000) // T bars needed by length
    // eslint-disable-next-line no-console
    console.log(
      `\nubCount=${result.ubCount} teeBars=${result.teeBarCount} material=${material}mm ` +
        `(theoretical min bars=${theoreticalMinBars}, material>=${theoreticalMinBars * 6000}mm) ` +
        `util=${(result.utilisation * 100).toFixed(1)}%`,
    )

    // Each UB yields two T bars, so material (UB length) >= totalTeeLength / 2.
    expect(material).toBeGreaterThanOrEqual(result.totalTeeLength / 2)
    // Regression lock: 31 average ~2.18 m T's fit in 3 × 12 m UBs at ~94%.
    expect(result.ubCount).toBe(3)
    expect(result.utilisation).toBeGreaterThan(0.9)
  })
})
