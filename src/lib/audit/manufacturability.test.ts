import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nw31Top } from '@test/fixtures'
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

/** The same step, but its far end rolls into a rounded corner (arc radius). */
const ROUNDED_STEP = `  o       0.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00      30.00       0.00       0.00       0.00       0.00       0.00
        60.00      30.00       0.00       0.00       0.00       0.00       0.00
        60.00     100.00     -15.00       0.00       0.00       0.00       0.00
         0.00     100.00       0.00       0.00       0.00       0.00       0.00`

/** The same step, with a notch instruction on the step's line (`t` = tangential notch). */
const NOTCHED_STEP = `  o       0.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00      30.00       0.00       0.00       0.00       0.00       0.00
        60.00      30.00       0.00       0.00       0.00       0.00       0.00
        60.00     100.00       0.00       0.00       0.00       0.00       0.00
         0.00     100.00       0.00       0.00       0.00       0.00       0.00
        60.00      15.00t      0.00       0.00       0.00       0.00       0.00`

/** The same step, but its near-vertical edge carries welding-prep bevel data (an angled cut). */
const BEVELED_STEP = `  o       0.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00       0.00       0.00       0.00       0.00       0.00       0.00
       100.00      30.00       0.00       0.00       0.00       0.00       0.00
        60.00      30.00       0.00      20.00       9.00       0.00       0.00
        60.00     100.00       0.00      20.00       9.00       0.00       0.00
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

  it('ignores a beveled step (a T/angle junction cut)', () => {
    // The raw step is still measurable for the STEP rebuild (which uses `contourHasBevel`).
    expect(contourStepDepth(first(nc(BEVELED_STEP)))).toBeCloseTo(70, 0)
    // But as a manufacturability finding it is an angled/bevel cut, handled by the bevel settings.
    expect(contourStepDepth(first(nc(BEVELED_STEP)), { ignoreBeveled: true })).toBe(0)
    expect(assessManufacturability(nc(BEVELED_STEP))).toEqual([])
  })

  it('ignores a step that meets a rounded corner', () => {
    expect(contourStepDepth(first(nc(ROUNDED_STEP)))).toBeCloseTo(70, 0)
    expect(contourStepDepth(first(nc(ROUNDED_STEP)), { ignoreRoundedCorners: true })).toBe(0)
    expect(assessManufacturability(nc(ROUNDED_STEP))).toEqual([])
  })

  it('ignores a step that is part of a notch/corner instruction', () => {
    expect(contourStepDepth(first(nc(NOTCHED_STEP)), { notches: [[60, 15]] })).toBe(0)
    expect(assessManufacturability(nc(NOTCHED_STEP))).toEqual([])
  })

  it.skipIf(!existsSync(join(nw31Top('NC files'), 'm134.nc1')))(
    'm134 (BT100*15) ignores the beveled web/flange root step',
    () => {
      const text = readFileSync(join(nw31Top('NC files'), 'm134.nc1'), 'utf8')
      expect(assessManufacturability(text)).toEqual([])
    },
  )

  it.skipIf(!existsSync(join(nw31Top('NC files'), 'm144.nc1')))(
    'm144 (BT100*15) ignores the end cut meeting a rounded corner',
    () => {
      const text = readFileSync(join(nw31Top('NC files'), 'm144.nc1'), 'utf8')
      // Its only finding is the 45.3° weld prep just outside the head's range (BEVEL_OUT_OF_RANGE).
      expect(assessManufacturability(text).filter((i) => i.code === 'CUT_STEP')).toEqual([])
    },
  )

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
