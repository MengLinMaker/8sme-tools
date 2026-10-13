import { describe, expect, it } from 'vitest'
import { partSectionForCode, stockOutlineForCode } from './stock'

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
  ['PFC100*50', [100, 50, 6.7, 4.2, 8], { w: 100, h: 50 }], // channel 'n': web on top, flanges down
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
    expect(inner.width).toBeLessThanOrEqual(100 - 2 * 9) // void clear of the 9 mm wall
    expect(inner.height).toBeLessThanOrEqual(150 - 2 * 9)

    const shs = stockOutlineForCode('SHS100*100*6.0', [100, 100, 6, 6, 15])
    expect(shs?.holes).toHaveLength(1)
    expect(bbox(shs?.holes?.[0] ?? []).width).toBeLessThanOrEqual(100 - 2 * 6)
  })

  it('makes CHS hollow', () => {
    expect(stockOutlineForCode('CHS114.3*5.4', [])?.holes).toHaveLength(1)
  })

  it('builds an unequal-angle L', () => {
    const { width, height } = bbox(stockOutlineForCode('UA100*75*6', [])?.points ?? [])
    expect(width).toBeGreaterThanOrEqual(100)
    expect(height).toBeGreaterThanOrEqual(75)
  })

  it('rounds the inner corner of each angle toe, leaving the outer corners sharp', () => {
    // EA75*75*6: root R1 = 8, toe R2 = 5 (OneSteel 7th Ed, which points R2 at the INNER corner
    // of each toe). Outer corners (legA, 0) and (0, legB) stay sharp; the inner corners
    // (legA, t) and (t, legB) are cut away by the toe radius.
    const t = 6
    const points = stockOutlineForCode('EA75*75*6', [75, 75, 6, 6, 8])?.points ?? []
    const maxX = Math.max(...points.map((p) => p[0]))
    const minX = Math.min(...points.map((p) => p[0]))
    const maxY = Math.max(...points.map((p) => p[1]))
    const minY = Math.min(...points.map((p) => p[1]))
    const near = (x: number, y: number, px: number, py: number) =>
      Math.abs(x - px) < 0.5 && Math.abs(y - py) < 0.5
    expect(points.some(([x, y]) => near(x, y, maxX, minY))).toBe(true)
    expect(points.some(([x, y]) => near(x, y, minX, maxY))).toBe(true)
    expect(points.some(([x, y]) => near(x, y, maxX, minY + t))).toBe(false)
    expect(points.some(([x, y]) => near(x, y, minX + t, maxY))).toBe(false)
  })

  it('models the toe radius on parts too, and falls back when the size is non-standard', () => {
    const part = partSectionForCode('EA75*75*6', [75, 75, 6, 6, 8])
    expect(part?.points.length ?? 0).toBeGreaterThan(8)

    // EA70*70*6 is not in the AUS catalogue — still builds, from the NC dims, root radius only.
    const { width, height } = bbox(
      stockOutlineForCode('EA70*70*6', [70, 70, 6, 6, 8])?.points ?? [],
    )
    expect(width).toBeGreaterThanOrEqual(70)
    expect(height).toBeGreaterThanOrEqual(70)
  })

  it('handles a numeric-prefix channel designation', () => {
    const outline = stockOutlineForCode('150PFC', [150, 75, 8, 5])
    const { width } = bbox(outline?.points ?? [])
    expect(width).toBeGreaterThanOrEqual(150)
  })

  it('uses the standard PFC table for a short channel callout', () => {
    const pfc = stockOutlineForCode('150PFC', [150, 75, 9.5, 6.0])
    expect(pfc?.label).toBe('150 PFC stock')
    const { width, height } = bbox(pfc?.points ?? [])
    expect(width).toBeGreaterThanOrEqual(150)
    expect(height).toBeGreaterThanOrEqual(75)
  })

  it('models the PFC root fillets from the catalogue radius', () => {
    // A tabulated PFC (r = 10) is drawn with its two inner root fillets; a sharp 8-point channel
    // would mean the radius was dropped.
    const pfc = stockOutlineForCode('150PFC', [150, 75, 9.5, 6.0])
    expect(pfc?.points.length ?? 0).toBeGreaterThan(8)
  })

  it('builds a UC I-section from its designation', () => {
    const uc = stockOutlineForCode('310UC158', [311, 327, 25.0, 15.7])
    expect(uc?.label).toBe('310UC158 stock')
    const { width, height } = bbox(uc?.points ?? [])
    expect(width).toBeGreaterThanOrEqual(311)
    expect(height).toBeGreaterThanOrEqual(327)
  })

  it('builds a TFB I-section from its short code', () => {
    const tfb = stockOutlineForCode('125TFB', [65, 125, 8.5, 5.0])
    expect(tfb?.label).toBe('125 TFB stock')
    const { height } = bbox(tfb?.points ?? [])
    expect(height).toBeGreaterThanOrEqual(125)
  })

  it('returns null for a non-section code', () => {
    expect(stockOutlineForCode('C300', [])).toBeNull()
    expect(stockOutlineForCode('', [])).toBeNull()
  })

  it('reports published mass for tabulated families', () => {
    expect(stockOutlineForCode('200UB29.8', [134, 207, 9.6, 6.3])?.mass).toBeCloseTo(29.8, 1)
    expect(stockOutlineForCode('310UC158', [311, 327, 25.0, 15.7])?.mass).toBeCloseTo(158.0, 1)
    expect(stockOutlineForCode('150PFC', [150, 75, 9.5, 6.0])?.mass).toBeCloseTo(17.7, 1)
    expect(stockOutlineForCode('125TFB', [65, 125, 8.5, 5.0])?.mass).toBeCloseTo(13.1, 1)
  })

  it('integrates mass from geometry for hollows and angles', () => {
    // Exact NC dims carry the corner radius (dims[4]) so the mass lands on the published value.
    expect(stockOutlineForCode('SHS100*100*6.0', [100, 100, 6, 6, 15])?.mass).toBeCloseTo(16.7, 0)
    expect(stockOutlineForCode('RHS150*100*9.0', [150, 100, 9, 9, 22.5])?.mass).toBeCloseTo(30.6, 0)
    expect(stockOutlineForCode('EA75*75*6', [75, 75, 6, 6, 8])?.mass).toBeCloseTo(6.8, 0)
  })

  it('draws the stock at the exact section size (no clearance offset)', () => {
    const pfc = bbox(stockOutlineForCode('100PFC', [100, 50, 6.7, 4.2, 8])?.points ?? [])
    expect(pfc.width).toBeCloseTo(100, 1)
    expect(pfc.height).toBeCloseTo(50, 1)

    const ua = bbox(stockOutlineForCode('UA100*75*6', [])?.points ?? [])
    expect(ua.width).toBeCloseTo(100, 1)
    expect(ua.height).toBeCloseTo(75, 1)
  })
})
