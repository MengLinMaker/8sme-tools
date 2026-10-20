import { existsSync, readFileSync } from 'node:fs'
import { nw31Bottom } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseNcGeometry, slotOffset } from './ncGeometry'

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

  it('keeps a slotted (`l`) hole as an obround, not a plain circle', () => {
    // Real NW30 m71 BO lines: the `o` holes are Ø10 slots (`l`, 10 mm end-to-end); the `u` holes
    // are plain Ø14 drills. The slot's start point is `(267.80, 25.00)`, the far end `+10` in Y.
    const text = `ST
  m71
BO
  o     267.80u     25.00      10.00      0.00l      0.00     10.00      0.00
  u     267.80u     29.99      14.00
EN`
    const geometry = parseNcGeometry(text)
    expect(geometry.holes).toHaveLength(2)
    expect(geometry.holes[0]).toMatchObject({
      face: 'o',
      x: 267.8,
      y: 25,
      diameter: 10,
      slot: { dx: 0, dy: 10, angle: 0 },
    })
    expect(geometry.holes[1]).toMatchObject({ face: 'u', diameter: 14 })
    expect(geometry.holes[1]?.slot).toBeUndefined()
  })

  it('keeps a tilted (`l`) hole’s rotation angle', () => {
    // Real NW31 a1 BO lines (EA75×75×6): the `v` slots are Ø10 and the DSTV angle field is ~70°,
    // i.e. ~20° off the face's Y axis. The far-end offset is `(dx, dy)` rotated by that angle.
    const text = `ST
  a1
  EA75*75*6
  L
BO
  v    1005.67u     35.89      10.00      0.00l      0.00     10.00     69.95
EN`
    const slot = parseNcGeometry(text).holes[0]?.slot
    expect(slot).toMatchObject({ dx: 0, dy: 10, angle: 69.95 })
    const [x, y] = slotOffset(slot as never)
    expect(x).toBeCloseTo(-9.394, 3)
    expect(y).toBeCloseTo(3.428, 3)
    expect(Math.hypot(x, y)).toBeCloseTo(10, 6)
  })

  it('parses `SI` etch text and `KO`/`PU` scribe marks', () => {
    // DSTV order is `face X Y angle height text`. The KO/PU blocks are contour-like lines.
    const text = `ST
  m-2
SI
  v     152.40o    201.93       0.00       76         B_1
KO
  v     2886.01o   455.93       0.00
  v     2886.01o   481.33       0.00
  v     2895.53o   481.33       0.00
PU
  v     2895.53o   481.33       0.00
  v     2895.53o   455.93       0.00
EN`
    const geometry = parseNcGeometry(text)
    expect(geometry.marks).toEqual([
      {
        face: 'v',
        kind: 'etch',
        points: [[152.4, 201.93]],
        text: { value: 'B_1', height: 76, angle: 0 },
      },
      {
        face: 'v',
        kind: 'marking',
        points: [
          [2886.01, 455.93],
          [2886.01, 481.33],
          [2895.53, 481.33],
        ],
      },
      {
        face: 'v',
        kind: 'marking',
        points: [
          [2895.53, 481.33],
          [2895.53, 455.93],
        ],
      },
    ])
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
