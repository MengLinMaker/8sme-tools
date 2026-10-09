import { describe, expect, it } from 'vitest'
import { parseDstv } from './dstv'

// Real DSTV NC from the NW31 Top frames job (mark m118, BT100*15 T).
const M118 = `ST
** m118.nc1
  CO-7255
  m118
  m118
  8
  C300
  1
  BT100*15
  T
    2920.71
     134.00
     103.00
       9.60
       6.30
       8.90
     14.900
      0.460
      0.000
      0.000
      0.000
      0.002
AK
  v       0.00u    134.00       0.00       0.00       0.00       0.00       0.00
         48.91       0.00       0.00       0.00       0.00       0.00       0.00
       2582.31       0.00       0.00       0.00       0.00      45.38       3.82
       2590.66     134.00       0.00       0.00       0.00       0.00       0.00
          0.00     134.00       0.00       0.00       0.00       0.00       0.00
AK
  o       4.16o     96.21       0.00     -20.05       6.30       0.00       0.00
          4.16     103.00       0.00       0.00       0.00       0.00       0.00
       2576.66     103.00       0.00      -3.56       6.30       0.00       0.00
          4.16      96.21       0.00       0.00       0.00       0.00       0.00
BO
  v     135.08s     24.56      14.00
  v     135.09s    109.56      14.00
  v     918.88s     24.54      14.00
  v     918.88s    109.54      14.00
  v    1702.68s     24.52      14.00
  v    1702.68s    109.53      14.00
  v    2486.48s     24.51      14.00
  v    2486.49s    109.51      14.00
EN`

describe('parseDstv', () => {
  it('reads the ST header', () => {
    const file = parseDstv(M118)
    expect(file.header.mark).toBe('m118')
    expect(file.header.profile).toBe('BT100*15')
    expect(file.header.profileType).toBe('T')
    expect(file.header.grade).toBe('C300')
    expect(file.header.quantity).toBe(1)
    expect(file.header.length).toBeCloseTo(2920.71, 2)
    expect(file.header.dimensions.slice(0, 4)).toEqual([134, 103, 9.6, 6.3])
  })

  it('reads the 8 × Ø14 holes', () => {
    const file = parseDstv(M118)
    expect(file.holes).toHaveLength(8)
    for (const hole of file.holes) {
      expect(hole.face).toBe('v')
      expect(hole.diameter).toBe(14)
    }
    expect(file.holes[0]).toMatchObject({ x: 135.08, y: 24.56 })
  })

  it('reads the contours', () => {
    const file = parseDstv(M118)
    expect(file.contours.length).toBeGreaterThanOrEqual(2)
    expect(file.contours[0]?.kind).toBe('AK')
    expect(file.contours[0]?.vertices.length).toBe(5)
    expect(file.blocks).toContain('AK')
    expect(file.blocks).toContain('BO')
  })
})
