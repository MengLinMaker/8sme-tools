import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { partSectionForCode } from '@/lib/sections/stock'
import {
  assessCutReach,
  assessCutReachGeometry,
  MAX_CUT_THICKNESS_MM,
  materialSpans,
  nearestEdgeOutwardNormal,
} from './cutReach'

/** A minimal NC whose `v` (bottom) face is a rectangle: two end cuts across a solid bar. */
function rectNc(bevelDeg = 0): string {
  const b = bevelDeg.toFixed(2)
  const row = (head: string, x: number, y: number) =>
    `${head}${x.toFixed(2).padStart(10)}${y.toFixed(2).padStart(12)}${'0.00'.padStart(12)}${b.padStart(12)}${'0.00'.padStart(12)}${b.padStart(12)}${'0.00'.padStart(12)}`
  return [
    'ST',
    '  m1',
    'AK',
    row('  v', 0, 0),
    row(' ', 200, 0),
    row(' ', 200, 100),
    row(' ', 0, 100),
    'EN',
  ].join('\n')
}

const SOLID: [number, number][] = [
  [-50, -25],
  [50, -25],
  [50, 25],
  [-50, 25],
]

describe('cutReach geometry', () => {
  it('materialSpans reads a solid as one span', () => {
    const spans = materialSpans(SOLID, [], [0, -25], [0, 1])
    expect(spans).toHaveLength(1)
    expect(spans[0]?.[1]).toBeCloseTo(50, 6)
  })

  it('materialSpans reads a hollow wall as a near span plus a far wall', () => {
    const outer: [number, number][] = [
      [-50, -50],
      [50, -50],
      [50, 50],
      [-50, 50],
    ]
    const hole: [number, number][] = [
      [-44, -44],
      [44, -44],
      [44, 44],
      [-44, 44],
    ]
    const spans = materialSpans(outer, [hole], [0, -50], [0, 1])
    expect(spans).toHaveLength(2)
    expect(spans[0]?.[1]).toBeCloseTo(6, 6)
    expect(spans[1]?.[0]).toBeCloseTo(94, 6)
  })

  it('nearestEdgeOutwardNormal points out of the section', () => {
    const bottom = nearestEdgeOutwardNormal(SOLID, [0, -25])
    expect(bottom[0]).toBeCloseTo(0, 6)
    expect(bottom[1]).toBeCloseTo(-1, 6)
    const left = nearestEdgeOutwardNormal(SOLID, [-50, 0])
    expect(left[0]).toBeCloseTo(-1, 6)
    expect(left[1]).toBeCloseTo(0, 6)
  })

  it('flags a cut through material deeper than the pierce cap', () => {
    const failures = assessCutReach(rectNc(0), SOLID)
    expect(failures.length).toBeGreaterThan(0)
    for (const failure of failures) {
      expect(failure.reason).toBe('reach')
      expect(failure.path).toBeGreaterThan(MAX_CUT_THICKNESS_MM)
    }
  })

  it('flags a bevel whose bore exceeds the pierce cap', () => {
    const failures = assessCutReach(rectNc(45), SOLID)
    expect(failures.length).toBeGreaterThan(0)
    for (const failure of failures) {
      expect(failure.reason).toBe('reach')
      expect(failure.path).toBeGreaterThan(MAX_CUT_THICKNESS_MM)
    }
  })

  it('clears a thin-wall cut', () => {
    const section = partSectionForCode('SHS100*100*6.0', [100, 100, 6, 6, 15])
    expect(section).not.toBeNull()
    if (!section) return
    const failures = assessCutReachGeometry(
      parseNcGeometry(rectNc(0)),
      section.points,
      section.holes ?? [],
    )
    expect(failures).toEqual([])
  })
})

describe('cutReach on real parts', () => {
  const NW31 = join(
    process.env.USERPROFILE ?? '',
    'Downloads',
    'Failed tests',
    '11602-02-01 NW31 BOTTOM & MIDDLE FRAMES - Shafts',
  )
  const NW30 = join(
    process.env.USERPROFILE ?? '',
    'Downloads',
    'Failed tests',
    '11601-02-01 NW30 BOTTOM FRAMES - SHAFTS',
  )
  // A PFC end cut runs across the flange over the web (deep-backed → flag); an SHS end cut only
  // ever meets thin walls, so it clears.
  const marks: { dir: string; mark: string; expectFlagged: boolean }[] = [
    { dir: NW31, mark: 'm106', expectFlagged: true },
    { dir: NW31, mark: 'm128', expectFlagged: true },
    { dir: NW30, mark: 'm106', expectFlagged: false },
  ]
  for (const { dir, mark, expectFlagged } of marks) {
    const have = existsSync(join(dir, `${mark}.nc1`))
    it.skipIf(!have)(
      `${mark} (${dir.includes('NW31') ? 'NW31' : 'NW30'}) ${
        expectFlagged ? 'flags the deep-backed cut' : 'clears the thin-wall cut'
      }`,
      () => {
        const ncText = readFileSync(join(dir, `${mark}.nc1`), 'utf8')
        const nc = parseNcGeometry(ncText)
        const header = parseDstv(ncText).header
        const section = partSectionForCode(header.profile, header.dimensions)
        expect(section).not.toBeNull()
        if (!section) return
        const failures = assessCutReachGeometry(nc, section.points, section.holes ?? [])
        console.log(`${mark}: ${failures.length} failures`, failures.slice(0, 6))
        if (expectFlagged) expect(failures.length).toBeGreaterThan(0)
        else expect(failures).toEqual([])
      },
    )
  }
})
