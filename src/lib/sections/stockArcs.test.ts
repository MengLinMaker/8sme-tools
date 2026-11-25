import { describe, expect, it } from 'vitest'
import type { Outline, OutlineArc } from './outline'
import { outlinePoints, reverseOutline } from './outline'
import { partSectionForCode, stockOutlineForCode } from './stock'

/** Arc edges of a generated contour, in order. */
function arcs(contour: Outline | undefined): OutlineArc[] {
  return (contour?.edges ?? []).filter((edge): edge is OutlineArc => edge.kind === 'arc')
}

const round = (values: number[]): number[] => values.map((v) => Math.round(v * 1000) / 1000).sort()

/**
 * The stock is **generated**, so its rounded corners are known at build time and are emitted as
 * real arcs — no polyline sampling and no fitting. These are the primitives the STEP rebuild
 * extrudes.
 */
describe('generated stock outlines carry real arcs', () => {
  it('draws each RHS corner once, outer and void', () => {
    // 150 × 100 × 9 RHS: 2.5t = 22.5 outer corners, 13.5 inner.
    const section = partSectionForCode('RHS150*100*9.0', [])
    const outer = section?.outline
    // Four straight sides, but a contour is drawn as a chain and the closing side is implicit.
    expect(outer?.edges.filter((edge) => edge.kind === 'line')).toHaveLength(3)
    expect(round(arcs(outer).map((arc) => Math.abs(arc.radius)))).toEqual([22.5, 22.5, 22.5, 22.5])
    // Every arc is a quarter turn.
    for (const arc of arcs(outer)) expect(Math.abs(arc.sweep)).toBeCloseTo(Math.PI / 2, 9)

    const voidOutline = section?.voidOutlines?.[0]
    expect(voidOutline?.edges.filter((edge) => edge.kind === 'line')).toHaveLength(3)
    expect(round(arcs(voidOutline).map((arc) => Math.abs(arc.radius)))).toEqual([
      13.5, 13.5, 13.5, 13.5,
    ])
  })

  it('derives the void radius from the caller-supplied corner radius', () => {
    // item35's SHS75*75*6 models a 10 mm outer corner (not the standard 15): the void is 4 mm.
    const section = partSectionForCode('SHS75*75*6.0', [75, 75, 6, 6, 10])
    expect(round(arcs(section?.outline).map((arc) => arc.radius))).toEqual([10, 10, 10, 10])
    expect(round(arcs(section?.voidOutlines?.[0]).map((arc) => arc.radius))).toEqual([4, 4, 4, 4])
  })

  it('draws a CHS as one circle, not a 48-gon', () => {
    const section = partSectionForCode('CHS508*9.5', [])
    expect(section?.outline.edges).toHaveLength(1)
    const [outer] = section?.outline.edges ?? []
    expect(outer?.kind).toBe('circle')
    expect(outer?.kind === 'circle' ? outer.radius : 0).toBeCloseTo(254, 6)
    const [voidEdge] = section?.voidOutlines?.[0].edges ?? []
    expect(voidEdge?.kind).toBe('circle')
    expect(voidEdge?.kind === 'circle' ? voidEdge.radius : 0).toBeCloseTo(244.5, 6)
  })

  it('draws one root fillet arc per UB junction', () => {
    const section = partSectionForCode('250UB31.4', [])
    const fillets = arcs(section?.outline)
    expect(fillets).toHaveLength(4)
    const [first, ...rest] = round(fillets.map((arc) => arc.radius))
    for (const radius of rest) expect(radius).toBeCloseTo(first as number, 6)
    expect(first).toBeGreaterThan(5)
    expect(first).toBeLessThan(15)
  })

  it('draws the PFC root fillets inside the cavity', () => {
    const section = partSectionForCode('PFC100*50', [])
    expect(arcs(section?.outline)).toHaveLength(2)
    expect(arcs(section?.innerOutline)).toHaveLength(2)
  })

  it('draws an angle root fillet and both toe radii', () => {
    const section = partSectionForCode('EA75*75*6', [])
    const radii = round(arcs(section?.outline).map((arc) => arc.radius))
    expect(radii).toHaveLength(3)
    // The two toes share a radius; the root is a different one.
    expect(radii[0]).toBe(radii[1])
    expect(radii[0]).not.toBe(radii[2])
  })

  it('keeps a sharp corner sharp (radius 0 is straight edges)', () => {
    const section = partSectionForCode('RHS100*50*3.0', [100, 50, 3, 3, 0])
    expect(arcs(section?.outline)).toHaveLength(0)
    // Four sides: three edges plus the implicit closing one.
    expect(section?.outline.edges).toHaveLength(3)
  })

  it('gives the ghost the same generated primitives (no second representation)', () => {
    const stock = stockOutlineForCode('SHS75*75*6.0', [])
    expect(arcs(stock?.outline)).toHaveLength(4)
    expect(arcs(stock?.voidOutlines?.[0])).toHaveLength(4)
    // The type carries primitives only; a polyline is a local tessellation, never stored.
    expect(Object.keys(stock ?? {})).not.toContain('points')
    expect(Object.keys(stock ?? {})).not.toContain('holes')
    expect(outlinePoints(stock?.outline).length).toBeGreaterThan(20)
  })

  it('winds a void opposite to its outer outline', () => {
    const section = partSectionForCode('RHS150*100*9.0', [])
    const outer = outlinePoints(section?.outline ?? { start: [0, 0], edges: [] })
    const voidOutline = section?.voidOutlines?.[0]
    if (!voidOutline) throw new Error('no void')
    const inner = outlinePoints(voidOutline)
    const signedArea = (points: [number, number][]) => {
      let twice = 0
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        twice += (points[j] as [number, number])[0] * (points[i] as [number, number])[1]
        twice -= (points[i] as [number, number])[0] * (points[j] as [number, number])[1]
      }
      return twice / 2
    }
    expect(Math.sign(signedArea(outer))).toBe(-Math.sign(signedArea(inner)))
    // Reversing is stable: reversing back restores the same polyline.
    const twice = outlinePoints(reverseOutline(reverseOutline(voidOutline)))
    expect(twice.length).toBe(inner.length)
  })
})
