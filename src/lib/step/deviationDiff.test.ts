import { BoxGeometry, Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import type { DiffSoup } from './booleanDiff'
import { cachedDeviationDiff, DEVIATION_TOLERANCE_MM, deviationDiff } from './deviationDiff'

const IDENTITY = new Matrix4()

/** A box soup centred on (cx, cy, cz) — outward winding, like an OCC tessellation. */
function boxSoup(w: number, h: number, d: number, cx = 0, cy = 0, cz = 0): DiffSoup {
  const geometry = new BoxGeometry(w, h, d)
  geometry.translate(cx, cy, cz)
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  return {
    vertices: Array.from(position.array as Float32Array),
    triangles: index ? Array.from(index.array as Uint16Array | Uint32Array) : [],
  }
}

describe('deviation diff (STEP is nominal)', () => {
  it('is empty for identical models', () => {
    const result = deviationDiff([boxSoup(10, 10, 10)], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)
    expect(result).not.toBeNull()
    expect(result?.over).toBeNull()
    expect(result?.under).toBeNull()
    expect(result?.primaryVolume).toBeCloseTo(1000, 0)
  })

  it('flags undercut (leftover) when the manufactured model is bigger', () => {
    // Manufactured 10³, ideal 7³ centred inside: every manufactured face sits 1.5 mm outside the
    // ideal surface ⇒ positive deviation ⇒ leftover. Flat faces integrate to 6·100·1.5 = 900; the
    // 12 convex corner vertices read the Euclidean 1.5·√3 gap, pushing the integral to ~1559.
    const result = deviationDiff([boxSoup(10, 10, 10)], [boxSoup(7, 7, 7)], IDENTITY, IDENTITY)
    expect(result?.under).not.toBeNull()
    expect(result?.over).toBeNull()
    expect(result?.underVolume ?? 0).toBeGreaterThan(1400)
    expect(result?.underVolume ?? 0).toBeLessThan(1700)
  })

  it('flags overcut (scrap) when the manufactured model is smaller', () => {
    // Manufactured 7³ inside ideal 10³: negative deviation ⇒ material the ideal keeps is gone.
    // Integral = 6·49·1.5 = 441.
    const result = deviationDiff([boxSoup(7, 7, 7)], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)
    expect(result?.over).not.toBeNull()
    expect(result?.under).toBeNull()
    expect(result?.overVolume ?? 0).toBeGreaterThan(350)
    expect(result?.overVolume ?? 0).toBeLessThan(550)
  })

  it('hides deviations below the tolerance', () => {
    // 9.9³ inside 10³: faces sit 0.05 mm out — below the 0.15 mm default, not drawn.
    const result = deviationDiff([boxSoup(10, 10, 10)], [boxSoup(9.9, 9.9, 9.9)], IDENTITY, IDENTITY)
    expect(result?.over).toBeNull()
    expect(result?.under).toBeNull()
  })

  it('respects a custom tolerance', () => {
    // 9.5³ inside 10³: faces sit 0.25 mm out.
    const hidden = deviationDiff(
      [boxSoup(10, 10, 10)],
      [boxSoup(9.5, 9.5, 9.5)],
      IDENTITY,
      IDENTITY,
      0.5,
    )
    expect(hidden?.under).toBeNull()
    const shown = deviationDiff(
      [boxSoup(10, 10, 10)],
      [boxSoup(9.5, 9.5, 9.5)],
      IDENTITY,
      IDENTITY,
      0.25,
    )
    expect(shown?.under).not.toBeNull()
  })

  it('returns null when either side is empty', () => {
    expect(deviationDiff([], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)).toBeNull()
    expect(deviationDiff([boxSoup(10, 10, 10)], [], IDENTITY, IDENTITY)).toBeNull()
  })

  it('caches by input identity', () => {
    const primary = boxSoup(10, 10, 10)
    const compare = boxSoup(7, 7, 7)
    const a = new Uint8Array([1])
    const b = new Uint8Array([2])
    const first = cachedDeviationDiff([primary], [compare], IDENTITY, IDENTITY, a, b)
    const second = cachedDeviationDiff([primary], [compare], IDENTITY, IDENTITY, a, b)
    expect(first?.underVolume).toBeCloseTo(second?.underVolume ?? -1, 6)
    expect(DEVIATION_TOLERANCE_MM).toBeGreaterThan(0)
  })
})
