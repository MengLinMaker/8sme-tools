import { readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { partIrFromNc } from './fromNc'
import { partIrSvg } from './svg'
import { partIrToNcGeometry } from './toNcGeometry'

/**
 * UB bottom (`h`) markings. The NC can carry `KO`/`PU` bars on the rear web (`h`); the I-section
 * front net develops only o/v/u, so the IR keeps them in a separate `rear` chart. That is the
 * faithful record. WiseCAM's NCEP export does not machine the `h` copy (see docs/ncep-format.md),
 * so the rear chart is the only place the mark exists pre-export — it must not be moved onto the
 * front net or dropped.
 *
 * `M-9` (UB310*32, test/fixtures/ncep) is the example: three KO/PU pairs on `h` at along 26.1,
 * 228.1 and 1860.5, and three v-face pairs that stay on the front chart.
 */
describe('UB bottom (h) marks in the IR', () => {
  it('M-9 keeps the h marks on the rear chart, faithful and round-tripping', () => {
    const ir = partIrFromNc(readFileSync(fixture('ncep', 'M-9.nc1'), 'utf8'))
    if (!ir) throw new Error('no IR')

    const rear = ir.charts.find((chart) => chart.role === 'rear')
    expect(rear?.faces).toEqual(['h'])
    expect(ir.charts.find((chart) => chart.role === 'front')?.faces).toEqual(['v', 'o', 'u'])

    const rearMarks = ir.marks.filter((mark) => mark.chart === rear?.id)
    expect(rearMarks).toHaveLength(6) // three KO/PU pairs
    for (const mark of rearMarks) expect(['KO', 'PU']).toContain(mark.block)

    // The authored alongs survive: the h bars sit at 26.1, 228.1 and 1860.5 (± the bar width).
    const alongs = rearMarks.flatMap((mark) =>
      mark.shape.form === 'polyline' ? mark.shape.points.map(([, along]) => along) : [],
    )
    for (const start of [26.1, 228.1, 1860.5]) {
      expect(alongs.some((along) => Math.abs(along - start) < 0.01)).toBe(true)
    }
    // ...and none of those h marks leak onto the front chart (whose marks are at 40.5/217/1904).
    const frontMarks = ir.marks.filter((mark) => mark.chart === 'front')
    expect(frontMarks).toHaveLength(6)
    for (const mark of frontMarks) {
      if (mark.shape.form !== 'polyline') continue
      expect(mark.shape.points.some(([, along]) => Math.abs(along - 228.1) < 1)).toBe(false)
    }

    // Round-trip back to the NC keeps the marks on `h` at the authored along.
    const geom = partIrToNcGeometry(ir)
    const hMarks = geom.marks.filter((mark) => mark.face === 'h')
    expect(hMarks).toHaveLength(6)
    expect(hMarks.map((mark) => mark.points[0]?.[0])).toContain(228.1)

    // The Surface view renders the rear layer rather than silently dropping it.
    const svg = partIrSvg(ir, { orientation: 'raw' })
    expect(svg).toContain('data-layer="chart:rear"')
  })
})
