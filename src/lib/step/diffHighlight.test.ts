import { describe, expect, it } from 'vitest'
import { computeDiffMasks, diffFraction, resolveDiffTolerance } from './diffHighlight'

// A 10 mm cube at the origin: 8 vertices, 12 triangles.
const CUBE_VERTS = [
  0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10,
]
const CUBE_TRIS = [
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2,
  7, 3, 3, 7, 4, 3, 4, 0,
]

function translated(verts: number[], dx: number, dy: number, dz: number): number[] {
  return verts.map((value, index) =>
    index % 3 === 0 ? value + dx : index % 3 === 1 ? value + dy : value + dz,
  )
}

describe('mesh diff highlighting', () => {
  it('flags nothing for identical meshes', () => {
    const { aDiff, bDiff } = computeDiffMasks(CUBE_VERTS, CUBE_TRIS, [...CUBE_VERTS], [...CUBE_TRIS], 1.5)
    expect([...aDiff].every((flag) => flag === 0)).toBe(true)
    expect([...bDiff].every((flag) => flag === 0)).toBe(true)
    expect(diffFraction(aDiff)).toBe(0)
  })

  it('flags a shifted copy on both sides', () => {
    const moved = translated(CUBE_VERTS, 5, 0, 0)
    const { aDiff, bDiff } = computeDiffMasks(CUBE_VERTS, CUBE_TRIS, moved, CUBE_TRIS, 1.5)
    expect(diffFraction(aDiff)).toBeGreaterThan(0.3)
    expect(diffFraction(bDiff)).toBeGreaterThan(0.3)
  })

  it('ignores sub-tolerance tessellation jitter', () => {
    const jittered = translated(CUBE_VERTS, 0.2, -0.1, 0.15)
    const { aDiff, bDiff } = computeDiffMasks(CUBE_VERTS, CUBE_TRIS, jittered, CUBE_TRIS, 1.5)
    expect(diffFraction(aDiff)).toBe(0)
    expect(diffFraction(bDiff)).toBe(0)
  })

  it('finds large triangles far from their centroid', () => {
    // One big 200 mm triangle; the query point sits over its middle, far from any vertex.
    const big = [0, 0, 0, 200, 0, 0, 0, 200, 0]
    const bigTris = [0, 1, 2]
    const same = computeDiffMasks(big, bigTris, [...big], [...bigTris], 1.5)
    expect(diffFraction(same.aDiff)).toBe(0)
    const lifted = [100, 100, 8, 200, 0, 0, 0, 200, 0]
    const { aDiff } = computeDiffMasks(lifted, bigTris, big, bigTris, 1.5)
    expect(aDiff[0]).toBe(1)
  })

  it('flags everything when one side is empty', () => {
    const { aDiff, bDiff } = computeDiffMasks(CUBE_VERTS, CUBE_TRIS, [], [], 1.5)
    expect(diffFraction(aDiff)).toBe(1)
    expect(diffFraction(bDiff)).toBe(0)
  })

  it('resolves a sane tolerance for small and large parts', () => {
    expect(resolveDiffTolerance(0)).toBe(1.5)
    expect(resolveDiffTolerance(200)).toBe(1)
    expect(resolveDiffTolerance(1500)).toBe(2)
  })
})
