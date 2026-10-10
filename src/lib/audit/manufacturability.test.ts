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

const BEVEL = `  o       0.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00       0.00       0.00     -20.00       9.00       0.00       0.00
       100.00     100.00       0.00       0.00       0.00       0.00       0.00
         0.00     100.00       0.00       0.00       0.00       0.00       0.00`

const first = (text: string) => parseNcGeometry(text).contours[0]

describe('manufacturability', () => {
  it('flags a sudden thickness step with material on both sides', () => {
    expect(contourStepDepth(first(nc(STEP)))).toBeCloseTo(70, 0)
    const issues = assessManufacturability(nc(STEP))
    expect(issues.map((i) => i.code)).toEqual(['CUT_STEP'])
    expect(issues[0]?.params?.depth).toBe('70')
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
})
