import { readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { partIrFromNc } from './fromNc'
import { partIrSvg } from './svg'

function part(mark: string) {
  const value = partIrFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'))
  if (!value) throw new Error(`no IR for ${mark}`)
  return value
}

describe('PartIR SVG view', () => {
  it('emits the section and every chart as named layers', () => {
    const ir = part('M-1')
    const svg = partIrSvg(ir)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('data-layer="section"')
    for (const chart of ir.charts) expect(svg).toContain(`data-layer="chart:${chart.id}"`)
    expect(svg).toContain('<circle')
    expect(svg.endsWith('</svg>')).toBe(true)
  })

  it('supports a responsive IR view with an overlay', () => {
    const ir = part('M-1')
    const svg = partIrSvg(ir, { responsive: true, overlay: ir })
    expect(svg).toContain('width="100%" height="100%"')
    expect(svg).toContain('stroke-dasharray="4 3"')
  })

  it('omits coincident diff segments and only draws deviations', () => {
    const ir = part('M-1')
    const same = partIrSvg(ir, { overlay: ir, diff: true, diffTolerance: 0.1 })
    expect(same).not.toContain('stroke="#64748b"')

    const shifted = structuredClone(ir)
    for (const feature of shifted.features) {
      if (feature.kind === 'cut' && feature.shape.form === 'polyline')
        feature.shape.points = feature.shape.points.map(([station, along]) => [station + 5, along])
    }
    const diff = partIrSvg(ir, { overlay: shifted, diff: true, diffTolerance: 0.1 })
    expect(diff).toMatch(/stroke="#(f87171|60a5fa)"/)
  })

  it('keeps slotted holes as visible cut geometry (m88)', () => {
    const ir = partIrFromNc(readFileSync(fixture('part-ir', 'm88.nc1'), 'utf8'))
    if (!ir) throw new Error('no m88 IR')
    expect(ir.features.filter((feature) => feature.kind === 'slot')).toHaveLength(6)
    const svg = partIrSvg(ir)
    expect(svg.match(/<polygon[^>]*stroke="#38bdf8"/g) ?? []).toHaveLength(6)
  })

  it('defaults to WiseCAM orientation (station mirrored, beam up)', () => {
    const ir = part('M-1')
    expect(partIrSvg(ir)).toContain('scale(-1 -1)')
    expect(partIrSvg(ir, { orientation: 'raw' })).not.toContain('scale(-1')
  })

  it('colours cuts by the supplied face-thickness palette', () => {
    const ir = part('M-1')
    const svg = partIrSvg(ir, { colorForFace: () => '#123456' })
    expect(svg).toContain('stroke="#123456"')
  })

  it('draws rounded-corner strips between tube faces', () => {
    const ir = part('M-35')
    const svg = partIrSvg(ir)
    expect(svg).toContain('fill-opacity="0.22"')
  })

  it('draws cut polylines and marks from the canonical UV geometry', () => {
    const ir = part('M-3')
    const svg = partIrSvg(ir)
    expect(svg).toContain('<polygon')
    expect(svg).toContain('stroke-dasharray')
    expect(svg).toContain('data-layer="chart:front"')
  })
})
