import { describe, expect, it } from 'vitest'
import { type Pt, sectionPath } from './sectionPath'
import { partSectionForCode } from './stock'

type Seg = ReturnType<typeof sectionPath>
type ArcSeg = { kind: 'arc'; to: Pt; center: Pt; radius: number; sagitta: number }

function arcsOf(path: Seg): ArcSeg[] {
  return (path?.segments ?? []).filter((s): s is ArcSeg => s.kind === 'arc')
}

/** Circles of a section contour, outer and every void, as radius lists. */
function radii(points: Pt[], tol = 1e-3): number[] {
  return arcsOf(sectionPath(points, tol)).map((a) => Math.abs(a.radius))
}

const round = (values: number[]): number[] => values.map((v) => Math.round(v * 100) / 100).sort()

describe('sectionPath — sampled contours as real primitives', () => {
  it('collapses each hollow corner to one arc, outer and inner', () => {
    // 150 × 100 × 9 RHS: 2.5t = 22.5 outer corners, 13.5 inner (the standard corner radius).
    const section = partSectionForCode('RHS150*100*9.0', [])
    expect(section).not.toBeNull()
    const outer = sectionPath(section?.points ?? [])
    expect(outer?.segments.filter((s) => s.kind === 'line')).toHaveLength(4)
    expect(round(radii(section?.points ?? []))).toEqual([22.5, 22.5, 22.5, 22.5])

    // The void is the part that used to stay faceted: four arcs, not a 28-gon.
    const voidPoints = section?.holes?.[0] ?? []
    expect(voidPoints.length).toBeGreaterThan(20)
    expect(round(radii(voidPoints))).toEqual([13.5, 13.5, 13.5, 13.5])
  })

  it('collapses a UB root fillet to one arc per junction', () => {
    const section = partSectionForCode('250UB31.4', [])
    const sampled = section?.points ?? []
    expect(sampled.length).toBeGreaterThan(16)
    const arcs = radii(sampled)
    expect(arcs).toHaveLength(4)
    // All four root fillets are the same tabulated radius — one arc each, not six chords each.
    const [first, ...rest] = round(arcs)
    for (const radius of rest) expect(radius).toBeCloseTo(first as number, 3)
    expect(first).toBeGreaterThan(5)
    expect(first).toBeLessThan(15)
  })

  it('collapses a PFC root fillet to one arc per junction', () => {
    const section = partSectionForCode('PFC100*50', [])
    const arcs = radii(section?.points ?? [])
    expect(arcs).toHaveLength(2)
    for (const radius of arcs) expect(radius).toBeGreaterThan(1)
  })

  it('keeps both angle radii — root fillet and toe — as single arcs', () => {
    const section = partSectionForCode('EA75*75*6', [])
    const arcs = radii(section?.points ?? [])
    // Root fillet + the two toe radii.
    expect(arcs.length).toBe(3)
  })

  it('turns a round contour into one circle instead of a 48-gon', () => {
    const section = partSectionForCode('CHS508*9.5', [])
    const path = sectionPath(section?.points ?? [])
    expect(path?.segments).toHaveLength(1)
    expect(path?.segments[0]?.kind).toBe('circle')
    const voidPath = sectionPath(section?.holes?.[0] ?? [])
    expect(voidPath?.segments[0]?.kind).toBe('circle')
  })

  it('leaves sharp corners sharp', () => {
    const box: Pt[] = [
      [-50, -30],
      [50, -30],
      [50, 30],
      [-50, 30],
    ]
    const path = sectionPath(box)
    expect(path?.segments).toHaveLength(4)
    expect(path?.segments.every((s) => s.kind === 'line')).toBe(true)
  })

  it('returns null for a degenerate contour', () => {
    expect(
      sectionPath([
        [0, 0],
        [1, 0],
      ]),
    ).toBeNull()
    expect(
      sectionPath([
        [0, 0],
        [0, 0],
        [0, 0],
      ]),
    ).toBeNull()
  })
})
