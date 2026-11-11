import { describe, expect, it } from 'vitest'
import { stationFor, unrolledLayout } from './layout'

describe('unrolledLayout', () => {
  it('develops the I-section bottom flange as a bottom view (Y reversed)', () => {
    const layout = unrolledLayout('I', [298, 149, 8, 5.5, 13])
    if (!layout) throw new Error('no layout')
    const half = layout.seam / 2
    // `o` (top view) keeps its Y direction; `u` (bottom view) runs the other way, so its Y=0 edge
    // meets the web and its Y=flange edge is the free toe on the far side of the net.
    expect(stationFor(layout, 'o', 0)).toBeCloseTo(-half, 6)
    expect(stationFor(layout, 'u', 0)).toBeCloseTo(half, 6)
    expect(stationFor(layout, 'u', 149)).toBeCloseTo(half - 149, 6)
    // A bottom-view hole at Y=24.5 lands 149-24.5 from the u region start (real M-9).
    expect(stationFor(layout, 'u', 24.5)).toBeCloseTo(half - 24.5, 6)
  })

  it('develops the channel bottom flange as a bottom view (Y reversed)', () => {
    const layout = unrolledLayout('U', [100, 50, 6.7, 4.2, 8])
    if (!layout) throw new Error('no layout')
    // PFC100*50: seam 200, `u` spans -100…-50 and `v` starts at -50. Y=0 is the web-side edge.
    expect(stationFor(layout, 'u', 0)).toBeCloseTo(-50, 6)
    expect(stationFor(layout, 'u', 50)).toBeCloseTo(-100, 6)
  })

  it('leaves the top view (o) and web (v) unreversed', () => {
    const layout = unrolledLayout('I', [298, 149, 8, 5.5, 13])
    if (!layout) throw new Error('no layout')
    const v = layout.faces.v
    if (!v) throw new Error('no v region')
    expect(stationFor(layout, 'v', 0)).toBeCloseTo(v.start, 6)
    expect(stationFor(layout, 'v', 298)).toBeCloseTo(v.start + 298, 6)
  })
})
