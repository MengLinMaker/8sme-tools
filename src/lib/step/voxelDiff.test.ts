import { BoxGeometry, Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import type { DiffSoup } from './booleanDiff'
import { voxelDiff } from './voxelDiff'

const IDENTITY = new Matrix4()

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

describe('voxel diff', () => {
  it('is empty (near) for identical models', () => {
    const result = voxelDiff([boxSoup(10, 10, 10)], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)
    expect(result).not.toBeNull()
    console.log(
      `identical: over=${result?.overVolume.toFixed(1)} under=${result?.underVolume.toFixed(1)} primary=${result?.primaryVolume.toFixed(1)}`,
    )
    expect(result?.overVolume ?? -1).toBeLessThan(60)
    expect(result?.underVolume ?? -1).toBeLessThan(60)
  })

  it('finds undercut when manufactured is bigger', () => {
    // 10³ vs 7³ centred: leftover shell = 1000 − 343 = 657 mm³ (±1 voxel per face).
    const result = voxelDiff([boxSoup(10, 10, 10)], [boxSoup(7, 7, 7)], IDENTITY, IDENTITY)
    console.log(
      `undercut:  over=${result?.overVolume.toFixed(1)} under=${result?.underVolume.toFixed(1)}`,
    )
    expect(result?.underVolume ?? 0).toBeGreaterThan(550)
    expect(result?.underVolume ?? 0).toBeLessThan(800)
    expect(result?.overVolume ?? 999).toBeLessThan(60)
  })

  it('finds overcut when manufactured is smaller', () => {
    const result = voxelDiff([boxSoup(7, 7, 7)], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)
    console.log(
      `overcut:   over=${result?.overVolume.toFixed(1)} under=${result?.underVolume.toFixed(1)}`,
    )
    expect(result?.overVolume ?? 0).toBeGreaterThan(550)
    expect(result?.overVolume ?? 0).toBeLessThan(800)
    expect(result?.underVolume ?? 999).toBeLessThan(60)
  })

  it('returns null for empty input', () => {
    expect(voxelDiff([], [boxSoup(10, 10, 10)], IDENTITY, IDENTITY)).toBeNull()
  })
})
