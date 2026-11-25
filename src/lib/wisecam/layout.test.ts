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

  it('develops an angle as one continuous strip around the outer corner', () => {
    // An angle is a section of a prism: the two outer leg faces develop as one strip, sharing the
    // corner (station 0). The NC authors each face's across from the corner, so `u` is reversed
    // onto the negative side and `v` runs forward — no separate charts, no gap.
    const layout = unrolledLayout('L', [75, 75, 6, 6, 8])
    if (!layout) throw new Error('no layout')
    expect(layout.seam).toBeCloseTo(150, 6)
    expect(layout.faces.o).toBeUndefined()
    expect(layout.faces.h).toBeUndefined()
    // Corner: both faces read y=0 at the shared station.
    expect(stationFor(layout, 'u', 0)).toBeCloseTo(0, 6)
    expect(stationFor(layout, 'v', 0)).toBeCloseTo(0, 6)
    // Toes: the horizontal leg runs negative, the vertical leg positive.
    expect(stationFor(layout, 'u', 75)).toBeCloseTo(-75, 6)
    expect(stationFor(layout, 'v', 75)).toBeCloseTo(75, 6)
  })

  it('assigns an unequal angle’s legs to the authored faces', () => {
    // a1/a2 confirm `v` spans the horizontal leg (dims[0]) and `u` the vertical one (dims[1]).
    const layout = unrolledLayout('L', [150, 90, 10, 10, 12])
    if (!layout) throw new Error('no layout')
    expect(layout.seam).toBeCloseTo(240, 6)
    expect(layout.faces.u?.length).toBeCloseTo(90, 6)
    expect(layout.faces.v?.length).toBeCloseTo(150, 6)
    // The corner is `u`'s y=0 end, shared with `v`'s y=0 start.
    expect(stationFor(layout, 'u', 0)).toBeCloseTo(-30, 6)
    expect(stationFor(layout, 'u', 90)).toBeCloseTo(-120, 6)
    expect(stationFor(layout, 'v', 0)).toBeCloseTo(-30, 6)
    expect(stationFor(layout, 'v', 150)).toBeCloseTo(120, 6)
  })
})
