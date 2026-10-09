import { describe, expect, it } from 'vitest'
import { stockOutlineForCode } from './stock'

function bbox(points: [number, number][]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  return { width: maxX - minX, height: maxY - minY }
}

/** Real section codes + NC dimensions from the NW31 / NW30 jobs. */
const JOB_SECTIONS: [string, number[], { w: number; h: number }][] = [
  ['200UB29.8', [134, 207, 9.6, 6.3], { w: 134, h: 207 }], // full UB, orientation I
  ['BT100*15', [134, 103, 9.6, 6.3, 8.9], { w: 134, h: 103 }], // halved UB (T)
  ['SHS100*100*6.0', [100, 100, 6, 6, 15], { w: 100, h: 100 }],
  ['SHS100*100*9.0', [100, 100, 9, 9, 22.5], { w: 100, h: 100 }],
  ['RHS150*100*9.0', [150, 100, 9, 9, 22.5], { w: 100, h: 150 }],
  ['PFC100*50', [100, 50, 6.7, 4.2, 8], { w: 50, h: 100 }],
  ['EA75*75*6', [75, 75, 6, 6, 8], { w: 75, h: 75 }],
]

describe('stockOutlineForCode', () => {
  for (const [code, dims, size] of JOB_SECTIONS) {
    it(`builds a usable outline for ${code}`, () => {
      const outline = stockOutlineForCode(code, dims)
      expect(outline).not.toBeNull()
      expect(Array.isArray(outline?.points)).toBe(true)
      expect(outline?.points.length ?? 0).toBeGreaterThanOrEqual(3)
      for (const point of outline?.points ?? []) {
        expect(point).toHaveLength(2)
        expect(Number.isFinite(point[0])).toBe(true)
        expect(Number.isFinite(point[1])).toBe(true)
      }
      const { width, height } = bbox(outline?.points ?? [])
      expect(width).toBeGreaterThanOrEqual(size.w)
      expect(height).toBeGreaterThanOrEqual(size.h)
    })
  }

  it('labels a full UB by its designation', () => {
    expect(stockOutlineForCode('200UB29.8', [134, 207, 9.6, 6.3])?.label).toBe('200UB29.8 stock')
  })

  it('labels a tee by its parent UB', () => {
    expect(stockOutlineForCode('BT100*15', [134, 103, 9.6, 6.3, 8.9])?.label).toContain('200UB29.8')
  })

  it('makes RHS/SHS hollow with a single void', () => {
    const rhs = stockOutlineForCode('RHS150*100*9.0', [150, 100, 9, 9, 22.5])
    expect(rhs?.holes).toHaveLength(1)
    const outer = bbox(rhs?.points ?? [])
    expect(outer.width).toBeGreaterThanOrEqual(100)
    expect(outer.height).toBeGreaterThanOrEqual(150)
    const inner = bbox(rhs?.holes?.[0] ?? [])
    expect(inner.width).toBeLessThan(100 - 2 * 9) // void clear of the 9 mm wall
    expect(inner.height).toBeLessThan(150 - 2 * 9)

    const shs = stockOutlineForCode('SHS100*100*6.0', [100, 100, 6, 6, 15])
    expect(shs?.holes).toHaveLength(1)
    expect(bbox(shs?.holes?.[0] ?? []).width).toBeLessThan(100 - 2 * 6)
  })

  it('makes CHS hollow', () => {
    expect(stockOutlineForCode('CHS114.3*5.4', [])?.holes).toHaveLength(1)
  })

  it('builds an unequal-angle L', () => {
    const { width, height } = bbox(stockOutlineForCode('UA100*75*6', [])?.points ?? [])
    expect(width).toBeGreaterThanOrEqual(100)
    expect(height).toBeGreaterThanOrEqual(75)
  })

  it('handles a numeric-prefix channel designation', () => {
    const outline = stockOutlineForCode('150PFC', [150, 75, 8, 5])
    const { height } = bbox(outline?.points ?? [])
    expect(height).toBeGreaterThanOrEqual(150)
  })

  it('returns null for a non-section code', () => {
    expect(stockOutlineForCode('C300', [])).toBeNull()
    expect(stockOutlineForCode('', [])).toBeNull()
  })
})
