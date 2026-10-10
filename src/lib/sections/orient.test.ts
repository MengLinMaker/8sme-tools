import { describe, expect, it } from 'vitest'
import { detectOrientation, orientationFit } from './orient'

// A T section (flange 100 wide/tf 10, web 12 to y=30), centred.
const T: [number, number][] = [
  [-50, -30],
  [50, -30],
  [50, -20],
  [6, -20],
  [6, 30],
  [-6, 30],
  [-6, -20],
  [-50, -20],
]

/** Embeds a cross-section so X→component 0, Y→component 2 (length along component 1). */
function embed(points: [number, number][]): number[] {
  const vertices: number[] = []
  for (const [x, y] of points) vertices.push(x, 0, y)
  return vertices
}
const ORIGIN: [number, number, number] = [0, 0, 0]

describe('detectOrientation', () => {
  it('detects the identity orientation', () => {
    expect(detectOrientation(T, embed(T), 0, 2, ORIGIN)).toBe(0)
    expect(orientationFit(T, 0, embed(T), 0, 2, ORIGIN)).toBeCloseTo(1)
  })

  it('detects a 90° rotation', () => {
    const rotated = T.map(([x, y]) => [-y, x] as [number, number])
    expect(detectOrientation(T, embed(rotated), 0, 2, ORIGIN)).toBe(1)
    expect(orientationFit(T, 1, embed(rotated), 0, 2, ORIGIN)).toBeCloseTo(1)
  })

  it('detects a 180° rotation', () => {
    const rotated = T.map(([x, y]) => [-x, -y] as [number, number])
    expect(detectOrientation(T, embed(rotated), 0, 2, ORIGIN)).toBe(2)
    expect(orientationFit(T, 2, embed(rotated), 0, 2, ORIGIN)).toBeCloseTo(1)
  })

  it('cannot fully seat a mirrored chiral section — a mirror is not a rotation', () => {
    // Unequal angle (long leg along +x, short leg along +y): flipping it is NOT a rotation.
    const L: [number, number][] = [
      [-30, -20],
      [30, -20],
      [30, -12],
      [-22, -12],
      [-22, 20],
      [-30, 20],
    ]
    const mirrored = L.map(([x, y]) => [x, -y] as [number, number])
    const best = detectOrientation(L, embed(mirrored), 0, 2, ORIGIN)
    expect(orientationFit(L, best, embed(mirrored), 0, 2, ORIGIN)).toBeLessThan(0.999)
  })
})
