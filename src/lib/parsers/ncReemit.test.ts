import { describe, expect, it } from 'vitest'
import { parseDstv } from './dstv'
import { reemitPartNc } from './ncReemit'

// Real DSTV NC from the NW31 Top frames job (mark m118, BT100*15 T) — carries bevel/radius columns.
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
EN`

describe('reemitPartNc', () => {
  it('round-trips the parsed DSTV structure', () => {
    const before = parseDstv(M118)
    const after = parseDstv(reemitPartNc(M118))
    expect(after.header).toEqual(before.header)
    expect(after.holes).toEqual(before.holes)
    expect(after.contours).toEqual(before.contours)
    expect(after.marks).toEqual(before.marks)
    expect(after.notches).toEqual(before.notches)
    expect(after.blocks).toEqual(before.blocks)
  })

  it('preserves the bevel/radius columns of an AK vertex verbatim', () => {
    expect(reemitPartNc(M118)).toContain(
      '2582.31       0.00       0.00       0.00       0.00      45.38       3.82',
    )
  })

  it('re-emits a file with CRLF line endings', () => {
    expect(reemitPartNc(M118).split('\r\n').length).toBeGreaterThan(1)
    expect(reemitPartNc(M118)).not.toContain('\n\n')
  })

  it('throws on input that is not DSTV (so the caller can fall back)', () => {
    expect(() => reemitPartNc('not an nc1 file')).toThrow()
  })
})
