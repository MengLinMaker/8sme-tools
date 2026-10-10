import { BoxGeometry, Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import { booleanDiff, type DiffSoup } from './booleanDiff'

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

describe('boolean diff (STEP is ideal)', () => {
  it('is empty for identical models', () => {
    const result = booleanDiff([boxSoup(10, 10, 10)], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)
    expect(result).not.toBeNull()
    expect(result?.extra).toBeNull()
    expect(result?.missing).toBeNull()
    expect(result?.primaryVolume).toBeCloseTo(1000, 0)
  })

  it('finds extra material around a smaller STEP ideal', () => {
    // Manufactured 10³, STEP ideal 8³ centred inside: extra = 1000 − 512.
    const result = booleanDiff([boxSoup(10, 10, 10)], [boxSoup(8, 8, 8)], IDENTITY, IDENTITY)
    expect(result?.extra).not.toBeNull()
    expect(result?.missing).toBeNull()
    expect(result?.extraVolume ?? 0).toBeCloseTo(1000 - 512, -1)
  })

  it('finds missing material when the STEP ideal is bigger', () => {
    const result = booleanDiff([boxSoup(8, 8, 8)], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)
    expect(result?.extra).toBeNull()
    expect(result?.missing).not.toBeNull()
    expect(result?.missingVolume ?? 0).toBeCloseTo(1000 - 512, -1)
  })

  it('splits a half-overlap into extra and missing', () => {
    // Two 10³ boxes offset 5 along x: overlap is 5×10×10 = 500 each way.
    const result = booleanDiff(
      [boxSoup(10, 10, 10, 0, 0, 0)],
      [boxSoup(10, 10, 10, 5, 0, 0)],
      IDENTITY,
      IDENTITY,
    )
    expect(result?.extraVolume ?? 0).toBeCloseTo(500, -1)
    expect(result?.missingVolume ?? 0).toBeCloseTo(500, -1)
  })

  it('bails out over the triangle budget', () => {
    const big = boxSoup(10, 10, 10)
    const huge: DiffSoup = {
      vertices: big.vertices,
      // Far more triangles than the budget allows (indices cycle the 8 vertices).
      triangles: Array.from({ length: 3_000_000 }, (_, i) => i % 8),
    }
    expect(booleanDiff([huge], [big], IDENTITY, IDENTITY)).toBeNull()
  })
})
