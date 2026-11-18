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

  it('supports a horizontal-axis flip for PFC display', () => {
    const ir = part('M-1')
    const svg = partIrSvg(ir, { orientation: 'flipY' })
    expect(svg).toContain('scale(1 -1)')
    expect(svg).not.toContain('scale(-1 -1)')
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

  it('never clips the material panel to a degenerate end cut', () => {
    // M-35 is a square-cut SHS: both ends develop to a single station, so the strip between them
    // has zero area. Clipping to it blanked the panel (and the rounded-corner strips with it).
    const ir = part('M-35')
    expect(ir.startCut).toHaveLength(2)
    const svg = partIrSvg(ir)
    expect(svg).not.toContain('<clipPath')
    expect(svg).toContain('fill="#0f172a" stroke="#334155"')
  })

  it('keeps the cut-boundary clip for a shaped end', () => {
    const ir = part('M-3')
    const half = (ir.charts[0]?.layout.seam ?? 0) / 2
    const svg = partIrSvg(ir)
    const clip = /<clipPath id="[^"]+"><polygon points="([^"]+)"/.exec(svg)
    expect(clip).not.toBeNull()
    const stations = (clip?.[1] ?? '').split(' ').map((pair) => Number(pair.split(',')[0]))
    expect(Math.min(...stations)).toBeCloseTo(-half, 0)
    expect(Math.max(...stations)).toBeCloseTo(half, 0)
  })

  it('falls back to the net when an end cut does not span the perimeter', () => {
    // M-42's developed end boundary covers only part of the net; the sorted polygon used to
    // bow-tie and paint a nonsense material panel.
    const ir = part('M-42')
    expect(partIrSvg(ir)).not.toContain('<clipPath')
  })

  it('draws cut polylines and marks from the canonical UV geometry', () => {
    const ir = part('M-3')
    const svg = partIrSvg(ir)
    expect(svg).toContain('<polygon')
    expect(svg).toContain('stroke-dasharray')
    expect(svg).toContain('data-layer="chart:front"')
  })
})
