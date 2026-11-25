import { describe, expect, it } from 'vitest'
import { unrolledLayout } from '@/lib/wisecam/layout'
import { outlinePoints, outlineVoids } from './outline'
import {
  layoutDimensions,
  partSectionForCode,
  resolveStockOutline,
  sectionDimensions,
  sectionMassPerMetre,
  sectionThicknesses,
  stockOutlineForCode,
} from './stock'

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
  // NC header dims for an I-profile are [depth, flange width, tf, tw, r] (DSTV fields 10/11);
  // the code is catalogue-matched here, so the dims are just carried for realism. Canonical H:
  // depth horizontal (w), flange width vertical (h).
  ['200UB29.8', [207, 134, 9.6, 6.3], { w: 207, h: 134 }], // full UB, canonical H stance
  ['BT100*15', [134, 103, 9.6, 6.3, 8.9], { w: 134, h: 103 }], // halved UB (T)
  ['SHS100*100*6.0', [100, 100, 6, 6, 15], { w: 100, h: 100 }],
  ['SHS100*100*9.0', [100, 100, 9, 9, 22.5], { w: 100, h: 100 }],
  ['RHS150*100*9.0', [150, 100, 9, 9, 22.5], { w: 150, h: 100 }],
  ['PFC100*50', [100, 50, 6.7, 4.2, 8], { w: 100, h: 50 }], // channel 'n': web on top, flanges down
  ['EA75*75*6', [75, 75, 6, 6, 8], { w: 75, h: 75 }],
]

describe('stockOutlineForCode', () => {
  for (const [code, dims, size] of JOB_SECTIONS) {
    it(`builds a usable outline for ${code}`, () => {
      const outline = stockOutlineForCode(code, dims)
      expect(outline).not.toBeNull()
      expect(Array.isArray(outlinePoints(outline?.outline))).toBe(true)
      expect(outlinePoints(outline?.outline).length ?? 0).toBeGreaterThanOrEqual(3)
      for (const point of outlinePoints(outline?.outline) ?? []) {
        expect(point).toHaveLength(2)
        expect(Number.isFinite(point[0])).toBe(true)
        expect(Number.isFinite(point[1])).toBe(true)
      }
      const { width, height } = bbox(outlinePoints(outline?.outline) ?? [])
      expect(width).toBeGreaterThanOrEqual(size.w)
      expect(height).toBeGreaterThanOrEqual(size.h)
    })
  }

  it('labels a full UB by its designation', () => {
    expect(stockOutlineForCode('200UB29.8', [207, 134, 9.6, 6.3])?.label).toBe('200UB29.8 stock')
  })

  it('reads an NC-header I-section as height-then-flange-width, not swapped', () => {
    // A non-catalogue callout like `UB360*57` has no table entry, so the section is built from the
    // NC header dims [depth, flange width, tf, tw, r]. Interpreting them in the wrong order built
    // the beam rotated 90° from reality. Canonical H then puts the depth (359) horizontal and the
    // flange width (172) vertical.
    const dims = [359, 172, 13, 8, 11.4] // 360UB56.7
    const part = bbox(outlinePoints(partSectionForCode('UB360*57', dims)?.outline) ?? [])
    expect(part.width).toBeCloseTo(359, 0)
    expect(part.height).toBeCloseTo(172, 0)
    const stock = bbox(outlinePoints(stockOutlineForCode('UB360*57', dims)?.outline) ?? [])
    expect(stock.width).toBeCloseTo(359, 0)
    expect(stock.height).toBeCloseTo(172, 0)
  })

  it('labels a tee by its parent UB', () => {
    expect(stockOutlineForCode('BT100*15', [134, 103, 9.6, 6.3, 8.9])?.label).toContain('200UB29.8')
  })

  it('makes RHS/SHS hollow with a single void', () => {
    const rhs = stockOutlineForCode('RHS150*100*9.0', [150, 100, 9, 9, 22.5])
    expect(outlineVoids(rhs?.voidOutlines)).toHaveLength(1)
    // Canonical stance: the longer side (150) runs horizontal.
    const outer = bbox(outlinePoints(rhs?.outline) ?? [])
    expect(outer.width).toBeGreaterThanOrEqual(150)
    expect(outer.height).toBeGreaterThanOrEqual(100)
    const inner = bbox(outlineVoids(rhs?.voidOutlines)?.[0] ?? [])
    expect(inner.width).toBeLessThanOrEqual(150 - 2 * 9) // void clear of the 9 mm wall
    expect(inner.height).toBeLessThanOrEqual(100 - 2 * 9)

    const shs = stockOutlineForCode('SHS100*100*6.0', [100, 100, 6, 6, 15])
    expect(outlineVoids(shs?.voidOutlines)).toHaveLength(1)
    expect(bbox(outlineVoids(shs?.voidOutlines)?.[0] ?? []).width).toBeLessThanOrEqual(100 - 2 * 6)
  })

  it('makes CHS hollow', () => {
    expect(outlineVoids(stockOutlineForCode('CHS114.3*5.4', [])?.voidOutlines)).toHaveLength(1)
  })

  it('builds an unequal-angle L', () => {
    const { width, height } = bbox(
      outlinePoints(stockOutlineForCode('UA100*75*6', [])?.outline) ?? [],
    )
    expect(width).toBeGreaterThanOrEqual(100)
    expect(height).toBeGreaterThanOrEqual(75)
  })

  it('rounds the inner corner of each angle toe, leaving the outer corners sharp', () => {
    // EA75*75*6: root R1 = 8, toe R2 = 5 (OneSteel 7th Ed, which points R2 at the INNER corner
    // of each toe). Outer corners (legA, 0) and (0, legB) stay sharp; the inner corners
    // (legA, t) and (t, legB) are cut away by the toe radius.
    const t = 6
    const points = outlinePoints(stockOutlineForCode('EA75*75*6', [75, 75, 6, 6, 8])?.outline) ?? []
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
    expect(outlinePoints(part?.outline).length ?? 0).toBeGreaterThan(8)

    // EA70*70*6 is not in the AUS catalogue — still builds, from the NC dims, root radius only.
    const { width, height } = bbox(
      outlinePoints(stockOutlineForCode('EA70*70*6', [70, 70, 6, 6, 8])?.outline) ?? [],
    )
    expect(width).toBeGreaterThanOrEqual(70)
    expect(height).toBeGreaterThanOrEqual(70)
  })

  it('handles a numeric-prefix channel designation', () => {
    const outline = stockOutlineForCode('150PFC', [150, 75, 8, 5])
    const { width } = bbox(outlinePoints(outline?.outline) ?? [])
    expect(width).toBeGreaterThanOrEqual(150)
  })

  it('uses the standard PFC table for a short channel callout', () => {
    const pfc = stockOutlineForCode('150PFC', [150, 75, 9.5, 6.0])
    expect(pfc?.label).toBe('150 PFC stock')
    const { width, height } = bbox(outlinePoints(pfc?.outline) ?? [])
    expect(width).toBeGreaterThanOrEqual(150)
    expect(height).toBeGreaterThanOrEqual(75)
  })

  it('models the PFC root fillets from the catalogue radius', () => {
    // A tabulated PFC (r = 10) is drawn with its two inner root fillets; a sharp 8-point channel
    // would mean the radius was dropped.
    const pfc = stockOutlineForCode('150PFC', [150, 75, 9.5, 6.0])
    expect(outlinePoints(pfc?.outline).length ?? 0).toBeGreaterThan(8)
  })

  it('builds a UC I-section from its designation', () => {
    const uc = stockOutlineForCode('310UC158', [311, 327, 25.0, 15.7])
    expect(uc?.label).toBe('310UC158 stock')
    const { width, height } = bbox(outlinePoints(uc?.outline) ?? [])
    // Canonical H: depth (327) horizontal, flange width (311) vertical.
    expect(width).toBeGreaterThanOrEqual(327)
    expect(height).toBeGreaterThanOrEqual(311)
  })

  it('builds a TFB I-section from its short code', () => {
    const tfb = stockOutlineForCode('125TFB', [65, 125, 8.5, 5.0])
    expect(tfb?.label).toBe('125 TFB stock')
    // Canonical H: depth (125) horizontal, flange width (65) vertical.
    const { width } = bbox(outlinePoints(tfb?.outline) ?? [])
    expect(width).toBeGreaterThanOrEqual(125)
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
    const pfc = bbox(
      outlinePoints(stockOutlineForCode('100PFC', [100, 50, 6.7, 4.2, 8])?.outline) ?? [],
    )
    expect(pfc.width).toBeCloseTo(100, 1)
    expect(pfc.height).toBeCloseTo(50, 1)

    const ua = bbox(outlinePoints(stockOutlineForCode('UA100*75*6', [])?.outline) ?? [])
    expect(ua.width).toBeCloseTo(100, 1)
    expect(ua.height).toBeCloseTo(75, 1)
  })

  describe('resolveStockOutline (STEP-only fallback)', () => {
    it('draws the real inferred outline, not the catalogue ideal', async () => {
      // A real angle outline with square toes (unlike the catalogue's rounded toes).
      const real: [number, number][] = [
        [0, 0],
        [80, 0],
        [80, 8],
        [8, 8],
        [8, 80],
        [0, 80],
      ]
      const outline = await resolveStockOutline({ mark: 'x1' }, undefined, {
        code: 'EA80*80*8',
        outline: { points: real },
      })
      expect(outlinePoints(outline?.outline)).toEqual(real)
      expect(outline?.label).toBe('EA80*80*8')
    })

    it('falls back to the catalogue outline when no real outline is given', async () => {
      const outline = await resolveStockOutline({ mark: 'x1' }, undefined, { code: '100 PFC' })
      expect(outlinePoints(outline?.outline).length).toBeGreaterThan(3)
      expect(bbox(outlinePoints(outline?.outline) ?? []).width).toBeCloseTo(100, 0)
    })
  })
})

describe('sectionDimensions', () => {
  it('lists rolled-section depth, flange and root radius', () => {
    const byKey = Object.fromEntries(
      sectionDimensions('200UB29.8', []).map((row) => [row.key, row.value]),
    )
    expect(byKey.depth).toBe(207)
    expect(byKey.flangeWidth).toBe(134)
    expect(byKey.flangeThickness).toBe(9.6)
    expect(byKey.webThickness).toBe(6.3)
    expect(byKey.rootRadius).toBe(8.9)
    expect(byKey.massPerMetre).toBe(29.8)
  })

  it('derives hollow corner radii from the wall', () => {
    const byKey = Object.fromEntries(
      sectionDimensions('RHS150*100*9.0', []).map((row) => [row.key, row.value]),
    )
    expect(byKey.sideA).toBe(150)
    expect(byKey.sideB).toBe(100)
    expect(byKey.wall).toBe(9)
    expect(byKey.cornerRadius).toBe(22.5)
    expect(byKey.innerRadius).toBe(13.5)
  })

  it('reads the parent UB dimensions for a T', () => {
    const byKey = Object.fromEntries(
      sectionDimensions('BT100*15', [134, 103, 9.6, 6.3, 8.9]).map((row) => [row.key, row.value]),
    )
    expect(byKey.flangeWidth).toBe(134)
    expect(byKey.halfDepth).toBe(103)
    expect(byKey.flangeThickness).toBe(9.6)
    expect(byKey.webThickness).toBe(6.3)
    expect(byKey.rootRadius).toBe(8.9)
  })
})

describe('sectionThicknesses', () => {
  it('reads flange and web thicknesses for a rolled section', () => {
    expect(sectionThicknesses('200UB29.8', [207, 134, 9.6, 6.3])).toEqual([
      { role: 'flange', mm: 9.6 },
      { role: 'web', mm: 6.3 },
    ])
  })

  it('reads the parent UB thicknesses for a T', () => {
    expect(sectionThicknesses('BT100*15', [134, 103, 9.6, 6.3, 8.9])).toEqual([
      { role: 'flange', mm: 9.6 },
      { role: 'web', mm: 6.3 },
    ])
  })

  it('collapses a section whose flange and web are the same', () => {
    expect(sectionThicknesses('SHS100*100*6.0', [100, 100, 6])).toEqual([{ role: 'wall', mm: 6 }])
  })

  it('reads the wall from the callout for a hollow section', () => {
    expect(sectionThicknesses('RHS150*100*9.0', [])).toEqual([{ role: 'wall', mm: 9 }])
  })
})

describe('layoutDimensions', () => {
  it('fills the dims unrolledLayout needs for a code-only STEP guess', () => {
    for (const [code, type] of [
      ['PFC100*50', 'U'],
      ['RHS150*100*9.0', 'M'],
      ['SHS100*100*6.0', 'M'],
      ['200UB29.8', 'I'],
    ] as const) {
      const dims = layoutDimensions(code, [])
      expect(dims.length).toBeGreaterThanOrEqual(2)
      expect(unrolledLayout(type, dims)).not.toBeNull()
    }
  })
})

describe('hollow stock outline', () => {
  // The STEP detector returns `dims: []` for RHS/SHS because the code carries the size, so a
  // radius defaulted from `dims[4]` alone drew a sharp-cornered box over a real rounded hollow
  // (J12095 item35, SHS75*75*6, showed "stock is wrong — no curved corner").
  it('keeps the corner arcs when no NC dims are supplied', () => {
    for (const code of ['SHS75*75*6.0', 'SHS89*89*5.0', 'RHS150*100*9.0']) {
      const section = partSectionForCode(code, [])
      expect(section, `${code} section`).toBeTruthy()
      if (!section) continue
      // Corner arcs contribute many points; a sharp rectangle is four.
      expect(outlinePoints(section?.outline).length, `${code} corner arcs`).toBeGreaterThan(20)
      expect(outlineVoids(section?.voidOutlines)?.length ?? 0, `${code} hollow void`).toBe(1)
    }
  })
})

describe('rounded UB mass', () => {
  it('resolves a rounded callout to the catalogue section', () => {
    const rounded = partSectionForCode('200UB25', [])
    const exact = partSectionForCode('200UB25.4', [])
    expect(rounded).toBeTruthy()
    expect(outlinePoints(rounded?.outline)).toEqual(outlinePoints(exact?.outline))
    expect(sectionMassPerMetre('200UB25', [])).toBeCloseTo(25.4, 3)
  })

  it('takes the nearest mass within the depth group', () => {
    expect(sectionMassPerMetre('200UB18', [])).toBeCloseTo(18.2, 3)
    expect(sectionMassPerMetre('310UB40', [])).toBeCloseTo(40.4, 3)
  })

  it('leaves an unknown depth unresolved', () => {
    expect(partSectionForCode('999UB25', [])).toBeNull()
  })
})

describe('hollow corner radius (AS/NZS 1163)', () => {
  it('uses 2.5t over 3 mm wall and 2.0t at or under', () => {
    const radiusOf = (code: string): number => {
      const section = partSectionForCode(code, [])
      expect(section, code).toBeTruthy()
      const xs = (outlinePoints(section?.outline) ?? []).map(([x]) => x)
      const ys = (outlinePoints(section?.outline) ?? []).map(([, y]) => y)
      const width = Math.max(...xs) - Math.min(...xs)
      const height = Math.max(...ys) - Math.min(...ys)
      // A rounded rectangle's area is W·H − (4 − π)R².
      let twice = 0
      const points = outlinePoints(section?.outline) ?? []
      for (let i = 0; i < points.length; i++) {
        const a = points[i] as [number, number]
        const b = points[(i + 1) % points.length] as [number, number]
        twice += a[0] * b[1] - b[0] * a[1]
      }
      const area = Math.abs(twice) / 2
      return Math.sqrt(Math.max(0, (width * height - area) / (4 - Math.PI)))
    }
    // 75×75×6 → 2.5 × 6 = 15; 89×89×5 → 12.5; a thin wall 50×50×3 → 2.0 × 3 = 6.
    expect(radiusOf('SHS75*75*6.0')).toBeCloseTo(15, 0)
    expect(radiusOf('SHS89*89*5.0')).toBeCloseTo(12.5, 0)
    expect(radiusOf('SHS50*50*3.0')).toBeCloseTo(6, 0)
  })
})
