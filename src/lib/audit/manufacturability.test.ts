import { describe, expect, it } from 'vitest'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { assessManufacturability, contourHasBevel, contourStepDepth } from './manufacturability'

/** A minimal T NC with the given AK block body (one face). */
function nc(akBody: string): string {
  return `ST\n  1\n  m1\n  C300\n  1\n  BT100*15\n  T\n  1000\n  134\n  103\n  9.6\n  6.3\n  8.9\nAK\n${akBody}\nEN`
}

const STEP = `  o       0.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00      30.00       0.00       0.00       0.00       0.00       0.00
        60.00      30.00       0.00       0.00       0.00       0.00       0.00
        60.00     100.00       0.00       0.00       0.00       0.00       0.00
         0.00     100.00       0.00       0.00       0.00       0.00       0.00`

const RECT = `  o       0.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00     100.00       0.00       0.00       0.00       0.00       0.00
         0.00     100.00       0.00       0.00       0.00       0.00       0.00`

/** A shallow step (20 mm) — within the head's ~30 mm reach, so not flagged. */
const SHALLOW = `  o       0.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00      30.00       0.00       0.00       0.00       0.00       0.00
        60.00      30.00       0.00       0.00       0.00       0.00       0.00
        60.00      50.00       0.00       0.00       0.00       0.00       0.00
         0.00      50.00       0.00       0.00       0.00       0.00       0.00`

const BEVEL = `  o       0.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00       0.00       0.00     -20.00       9.00       0.00       0.00
       100.00     100.00       0.00       0.00       0.00       0.00       0.00
         0.00     100.00       0.00       0.00       0.00       0.00       0.00`

/** Corner radii only (m106 style: R=-6.70, weld-prep all zero) — not a bevel. */
const RADII = `  o       0.00      16.70       0.00       0.00       0.00       0.00       0.00
         9.99       6.70       0.00       0.00       0.00       0.00       0.00
        39.09       6.70      -6.70       0.00       0.00       0.00       0.00
        45.79       6.70t     -6.70       0.00       0.00       0.00       0.00`

/** Bevel data carried only in the last weld-prep value — must still be detected. */
const BEVEL_LAST = `  o       0.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00       0.00       0.00       0.00       0.00       0.00      12.00
       100.00     100.00       0.00       0.00       0.00       0.00       0.00
         0.00     100.00       0.00       0.00       0.00       0.00       0.00`

const first = (text: string) => parseNcGeometry(text).contours[0]

describe('manufacturability', () => {
  it('flags a sudden thickness step with material on both sides', () => {
    expect(contourStepDepth(first(nc(STEP)))).toBeCloseTo(70, 0)
    const issues = assessManufacturability(nc(STEP))
    expect(issues.map((i) => i.code)).toEqual(['CUT_STEP'])
    expect(issues[0]?.params?.depth).toBe('70')
    // Deeper than the head can reach → an unmanufacturable error, not a fixable warning.
    expect(issues[0]?.severity).toBe('error')
  })

  it('ignores a shallow step within the head reach', () => {
    expect(contourStepDepth(first(nc(SHALLOW)))).toBeCloseTo(20, 0)
    expect(assessManufacturability(nc(SHALLOW))).toEqual([])
  })

  it('ignores an end cut (material on one side only)', () => {
    expect(contourStepDepth(first(nc(RECT)))).toBe(0)
    expect(assessManufacturability(nc(RECT))).toEqual([])
  })

  it('detects bevel / welding-preparation data', () => {
    expect(contourHasBevel(first(nc(BEVEL)))).toBe(true)
    expect(contourHasBevel(first(nc(RECT)))).toBe(false)
    // Bevels are surfaced by viewing, not as a finding.
    expect(assessManufacturability(nc(BEVEL))).toEqual([])
  })

  it('does not mistake corner radii for bevel data', () => {
    // m106 carries R=-6.70 corner blends with all weld-prep fields zero.
    expect(contourHasBevel(first(nc(RADII)))).toBe(false)
  })

  it('detects bevel data in the last weld-preparation value', () => {
    expect(contourHasBevel(first(nc(BEVEL_LAST)))).toBe(true)
  })
})
