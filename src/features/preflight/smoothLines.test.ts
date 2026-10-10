import { BufferGeometry, Float32BufferAttribute } from 'three'
import { describe, expect, it } from 'vitest'
import { SMOOTH_LINE_THRESHOLD_DEG, smoothLines } from './smoothLines'

/** Indexed triangle soup → segment count after smoothing. */
function smoothedSegments(vertices: number[], triangles: number[]): number {
  const faces = new BufferGeometry()
  faces.setAttribute('position', new Float32BufferAttribute(vertices, 3))
  faces.setIndex(triangles)
  const lines = new BufferGeometry()
  smoothLines(lines, faces)
  const count = Math.floor((lines.getAttribute('position')?.count ?? 0) / 2)
  faces.dispose()
  lines.dispose()
  return count
}

describe('smoothLines', () => {
  it(`drops the diagonal of a coplanar split quad (threshold ${SMOOTH_LINE_THRESHOLD_DEG}°)`, () => {
    // Two triangles, same plane: the shared diagonal is a modelling seam, not a cut.
    const segments = smoothedSegments([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3])
    // Only the 4 boundary edges remain.
    expect(segments).toBe(4)
  })

  it('keeps a 90° box edge', () => {
    // Two quads meeting at a right angle (e.g. a hole rim or square end).
    const segments = smoothedSegments(
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1],
      [0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1],
    )
    // 7 unique boundary edges (the shared one counted once), hinge included.
    expect(segments).toBe(7)
  })

  it('drops a shallow 20° hinge but keeps a 45° mitre hinge', () => {
    const hinge = (degrees: number): number => {
      // The 90° box corner above, with its second quad rotated about the shared x-axis
      // edge so the planes meet at `degrees`. Rotation preserves the consistent winding,
      // so the normals genuinely differ by the dihedral angle.
      const phi = ((90 - degrees) * Math.PI) / 180
      const y = -Math.sin(phi)
      const z = Math.cos(phi)
      return smoothedSegments(
        [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, y, z, 1, y, z],
        [0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1],
      )
    }
    expect(hinge(20)).toBe(6)
    expect(hinge(45)).toBe(7)
  })
})
