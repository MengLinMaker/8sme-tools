import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { getUb } from '@/lib/sections/ub'
import { buildStitchedBeamNc, stitchBeamGeometry } from './nc'

const UB = getUb('200UB29.8')
if (!UB) throw new Error('missing 200UB29.8 fixture')

const piece = (start: number) => ({
  start,
  geometry: {
    contours: [
      {
        face: 'v' as const,
        kind: 'outer' as const,
        points: [
          [0, 0],
          [1000, 0],
          [1000, 100],
          [0, 100],
        ] as [number, number][],
        bevels: [],
        radii: [0, 0, 0, 0],
      },
    ],
    holes: [{ face: 'o' as const, x: 500, y: 50, diameter: 14 }],
    notches: [{ face: 'o' as const, x: 10, y: 0, type: 'w' as const }],
    marks: [],
  },
})

describe('stitchBeamGeometry', () => {
  it('shifts every piece to its slot along the beam', () => {
    const stitched = stitchBeamGeometry([piece(0), piece(2000)])
    expect(stitched?.contours).toHaveLength(2)
    expect(stitched?.contours[1]?.points[0]).toEqual([2000, 0])
    expect(stitched?.contours[1]?.points[2]).toEqual([3000, 100])
    expect(stitched?.holes.map((h) => h.x)).toEqual([500, 2500])
    expect(stitched?.notches.map((n) => n.x)).toEqual([10, 2010])
  })

  it('returns null when no piece carries geometry', () => {
    expect(stitchBeamGeometry([])).toBeNull()
  })
})

describe('buildStitchedBeamNc', () => {
  it('round-trips the stitched geometry under a whole-beam header', () => {
    const items = [piece(0), piece(2000)]
    const text = buildStitchedBeamNc({
      section: UB,
      name: 'beam',
      stockLength: 12000,
      items,
    })
    expect(text).not.toBeNull()
    const nc = text ?? ''
    expect(nc).toContain('200UB29.8')
    expect(nc).toContain('\r\nAK\r\n')
    expect(nc).toContain('  o 500.00 50.00 14.00')

    const header = parseDstv(nc).header
    expect(header.profile).toBe('200UB29.8')
    expect(header.profileType).toBe('I')
    expect(header.length).toBe(12000)
    expect(header.dimensions.slice(0, 4)).toEqual([UB.b, UB.d, UB.tf, UB.tw])

    const geometry = parseNcGeometry(nc)
    expect(geometry.contours).toHaveLength(2)
    expect(geometry.contours[0]?.face).toBe('v')
    expect(geometry.contours[1]?.points[0]).toEqual([2000, 0])
    expect(geometry.holes).toHaveLength(2)
    expect(geometry.holes[1]).toMatchObject({ face: 'o', x: 2500, y: 50, diameter: 14 })
  })

  it('returns null with no geometry', () => {
    expect(
      buildStitchedBeamNc({ section: UB, name: 'beam', stockLength: 12000, items: [] }),
    ).toBeNull()
  })

  it('re-emits a slotted (`l`) hole as a slot, not a plain circle', () => {
    const items = [
      {
        start: 0,
        geometry: {
          contours: [],
          holes: [
            {
              face: 'o' as const,
              x: 267.8,
              y: 25,
              diameter: 10,
              slot: { dx: 0, dy: 10, angle: 0 },
            },
          ],
          notches: [],
          marks: [],
        },
      },
    ]
    const text = buildStitchedBeamNc({ section: UB, name: 'beam', stockLength: 12000, items })
    expect(text).toContain('  o 267.80 25.00 10.00 0.00l 0.00 10.00 0.00')
    expect(parseNcGeometry(text ?? '').holes[0]?.slot).toEqual({ dx: 0, dy: 10, angle: 0 })
  })
})
