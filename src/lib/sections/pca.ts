/**
 * Principal-axis analysis of a point cloud, shared by STEP section detection (which slices along
 * these axes) and the viewer's seating (which rotates the member axis to X). A prismatic member's
 * member axis is one of these axes regardless of how the STEP was exported — a rotated export puts
 * none of them on a world axis, which is exactly when the raw X/Y/Z axes fail.
 */

export type Vec = [number, number, number]

export interface PrincipalFrame {
  centre: Vec
  /** orthonormal, right-handed, longest-variance first */
  axes: [Vec, Vec, Vec]
}

function normalize(v: Vec): Vec {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a: Vec, b: Vec): Vec {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

type Mat3 = [number[], number[], number[]]

function matVec(m: Mat3, v: Vec): Vec {
  const [r0, r1, r2] = m
  return [
    r0[0] * v[0] + r0[1] * v[1] + r0[2] * v[2],
    r1[0] * v[0] + r1[1] * v[1] + r1[2] * v[2],
    r2[0] * v[0] + r2[1] * v[1] + r2[2] * v[2],
  ]
}

/** Dominant eigenvector of a symmetric 3×3 by power iteration. */
function dominantAxis(m: Mat3): Vec {
  let v: Vec = [1, 0, 0]
  for (let i = 0; i < 48; i++) {
    const next = matVec(m, v)
    const length = Math.hypot(next[0], next[1], next[2])
    if (length < 1e-12) break
    v = [next[0] / length, next[1] / length, next[2] / length]
  }
  return v
}

/**
 * Principal axes (PCA of the points): for a prismatic member one axis is the member axis, the other
 * two the cross-section directions. Returns the centroid and an orthonormal, right-handed basis, or
 * null when the cloud is too small/degenerate.
 */
export function principalAxes(vertices: number[]): PrincipalFrame | null {
  const count = Math.floor(vertices.length / 3)
  if (count < 4) return null
  const stride = Math.max(1, Math.floor(count / 4000)) * 3
  let mx = 0
  let my = 0
  let mz = 0
  let n = 0
  for (let i = 0; i + 2 < vertices.length; i += stride) {
    mx += vertices[i] as number
    my += vertices[i + 1] as number
    mz += vertices[i + 2] as number
    n++
  }
  if (n < 4) return null
  const centre: Vec = [mx / n, my / n, mz / n]
  let xx = 0
  let yy = 0
  let zz = 0
  let xy = 0
  let xz = 0
  let yz = 0
  for (let i = 0; i + 2 < vertices.length; i += stride) {
    const dx = (vertices[i] as number) - centre[0]
    const dy = (vertices[i + 1] as number) - centre[1]
    const dz = (vertices[i + 2] as number) - centre[2]
    xx += dx * dx
    yy += dy * dy
    zz += dz * dz
    xy += dx * dy
    xz += dx * dz
    yz += dy * dz
  }
  const cov: Mat3 = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ]
  const e0 = normalize(dominantAxis(cov))
  const lambda = matVec(cov, e0).reduce((sum, value, index) => sum + value * e0[index], 0)
  // Deflate to get the second axis, then complete the basis.
  const cov2: Mat3 = cov.map((row, i) =>
    row.map((value, j) => value - lambda * e0[i] * e0[j]),
  ) as Mat3
  let e1 = normalize(dominantAxis(cov2))
  if (Math.abs(e1[0] * e0[0] + e1[1] * e0[1] + e1[2] * e0[2]) > 0.9) {
    e1 = normalize(cross(e0, Math.abs(e0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
  }
  let e2 = normalize(cross(e0, e1))
  if (!Number.isFinite(e2[0]) || Math.hypot(e2[0], e2[1], e2[2]) < 0.5) {
    e2 = normalize(cross(e0, [0, 0, 1]))
  }
  e1 = normalize(cross(e2, e0))
  return { centre, axes: [e0, e1, e2] }
}
