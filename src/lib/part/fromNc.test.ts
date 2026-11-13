import { existsSync, readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { partIrFromNc } from './fromNc'
import { chartForFace } from './ir'

const MARKS = ['M-1', 'M-3', 'M-35', 'M-42'] as const

function ncText(mark: string): string {
  return readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8')
}

describe('NC → PartIR', () => {
  for (const mark of MARKS) {
    it.skipIf(!existsSync(fixture('ncep', `${mark}.nc1`)))(
      `${mark}: keeps the canonical cut/hole/mark set`,
      () => {
        const text = ncText(mark)
        const header = parseDstv(text).header
        const geometry = parseNcGeometry(text)
        const part = partIrFromNc(text)
        expect(part).not.toBeNull()
        if (!part) return

        expect(part.profile).toBe(header.profile)
        expect(part.profileType).toBe(header.profileType)
        expect(part.length).toBe(header.length)
        expect(part.quantity).toBe(header.quantity ?? 1)

        expect(part.charts.some((chart) => chart.id === 'front')).toBe(true)
        expect(part.features.filter((feature) => feature.kind === 'cut')).toHaveLength(
          geometry.contours.length,
        )
        expect(
          part.features.filter((feature) => feature.kind === 'hole' || feature.kind === 'slot'),
        ).toHaveLength(geometry.holes.length)
        expect(part.features.filter((feature) => feature.kind === 'notch')).toHaveLength(
          geometry.notches.length,
        )
        expect(part.marks).toHaveLength(geometry.marks.length)

        // Canonical UV is centred on the seam: no feature station may fall outside the chart.
        const front = part.charts.find((chart) => chart.id === 'front')
        if (!front) return
        const half = front.layout.seam / 2
        const all = part.features.flatMap((feature) => {
          const shape = feature.shape
          if (shape.form === 'circle') return [shape.center]
          if (shape.form === 'slot') return [shape.center, shape.far]
          return shape.points
        })
        for (const [station] of all) {
          expect(station).toBeGreaterThanOrEqual(-half - 0.01)
          expect(station).toBeLessThanOrEqual(half + 0.01)
        }
      },
    )
  }

  it('gives a face outside the front net its own chart (rear `h`)', () => {
    const text = ncText('M-1').replace(/EN(\r?\n)?$/, 'SI\n  h 100.00 25.00 0.00 10.00 TEST\nEN\n')
    const part = partIrFromNc(text)
    expect(part).not.toBeNull()
    if (!part) return
    const rear = part.charts.find((chart) => chart.id === 'rear')
    expect(rear?.faces).toEqual(['h'])
    expect(chartForFace(part, 'h')?.id).toBe('rear')
    const mark = part.marks.find((entry) => entry.text?.value === 'TEST')
    expect(mark?.chart).toBe('rear')
  })
})
