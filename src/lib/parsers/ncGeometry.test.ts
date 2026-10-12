import { existsSync, readFileSync } from 'node:fs'
import { nw31Bottom } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseNcGeometry } from './ncGeometry'

/** A real shaft whose o/u ends carry DSTV notch lines (`w`). */
const M147 = nw31Bottom('m147.nc1')

// Real geometry from the NW31 m170.nc1 (a part whose STEP is wrong).
const M170 = `ST
** m170.nc1
  CO-7255
  m170
  8
  C300
  1
  BT100*15
  T
    2670.65
     134.00
AK
  v       0.00u      0.00       0.00       0.00       0.00       0.00       0.00
       2093.22       0.00       0.00       0.00       0.00      45.40       3.82
       2093.22     134.00       0.00       0.00       0.00       0.00       0.00
         48.77     134.00       0.00       0.00       0.00       0.00       0.00
          0.00       0.00       0.00       0.00       0.00       0.00       0.00
BO
  v     124.38s     24.61      14.00
  v    1058.80s    109.61      14.00
EN`

describe('parseNcGeometry', () => {
  it('reads faces, contours and holes', () => {
    const geometry = parseNcGeometry(M170)
    expect(geometry.contours).toHaveLength(1)
    expect(geometry.contours[0]?.face).toBe('v')
    expect(geometry.contours[0]?.kind).toBe('outer')
    expect(geometry.contours[0]?.points).toEqual([
      [0, 0],
      [2093.22, 0],
      [2093.22, 134],
      [48.77, 134],
      [0, 0],
    ])
    expect(geometry.holes).toHaveLength(2)
    expect(geometry.holes[0]).toMatchObject({ face: 'v', x: 124.38, y: 24.61, diameter: 14 })
  })

  it('returns nothing for a header-only NC', () => {
    expect(parseNcGeometry('ST\n  CO-7255\nEN').contours).toEqual([])
  })

  it('separates DSTV notch lines (t/w) from contour vertices', () => {
    // A notched corner adds an extra AK line — the corner coords carrying `w` — that must not be
    // mistaken for a (duplicate) contour vertex.
    const text = `ST
  m1
AK
  o       0.00       0.00       0.00       0.00       0.00       0.00       0.00
          0.00     100.00       0.00       0.00       0.00       0.00       0.00
         45.53      93.45       0.00       0.00       0.00       0.00       0.00
         45.53      93.45w      0.00       0.00       0.00       0.00       0.00
         45.49     100.00       0.00       0.00       0.00       0.00       0.00
EN`
    const geometry = parseNcGeometry(text)
    expect(geometry.contours[0]?.points).toEqual([
      [0, 0],
      [0, 100],
      [45.53, 93.45],
      [45.49, 100],
    ])
    expect(geometry.notches).toEqual([{ face: 'o', x: 45.53, y: 93.45, type: 'w' }])
  })

  it.skipIf(!existsSync(M147))("parses m147's 8 notch lines (o/u ends)", () => {
    const geometry = parseNcGeometry(readFileSync(M147, 'utf8'))
    expect(geometry.notches).toHaveLength(8)
    expect(geometry.notches.every((n) => n.type === 'w')).toBe(true)
    expect([...new Set(geometry.notches.map((n) => n.face))].sort()).toEqual(['o', 'u'])
  })
})
