/**
 * Detects which of the four 90° rotations about a part's length axis seats it in a
 * section profile — the core of the canonical-frame alignment. Pure (no three.js) so
 * it can be unit-tested against synthetic cross-sections.
 */

/** Applies one of the four 90° rotations (world u,v → profile-local x,y). */
const ORIENTATIONS: ((u: number, v: number) => [number, number])[] = [
  (u, v) => [u, v],
  (u, v) => [v, -u],
  (u, v) => [-u, -v],
  (u, v) => [-v, u],
]

/** Tolerance (mm) so points on the section boundary count as inside. */
const TOLERANCE = 2

function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Inside the outline, or within tolerance of its boundary (handles vertices exactly on it). */
function nearPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  if (pointInPolygon(x, y, polygon)) return true
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const d = segmentDistance(x, y, polygon[j][0], polygon[j][1], polygon[i][0], polygon[i][1])
    if (d <= TOLERANCE) return true
  }
  return false
}

function strideFor(vertices: number[]): number {
  return Math.max(3, Math.floor(vertices.length / 3 / 4000) * 3)
}

/**
 * Returns the orientation index (0..3) whose rotation, applied to `profile`, contains the
 * most of the part's cross-section vertices. `vertices` are flat x/y/z triples;
 * `crossA`/`crossB` are the two (non-length) world components to read, relative to `centre`.
 */
export function detectOrientation(
  profile: [number, number][],
  vertices: number[],
  crossA: number,
  crossB: number,
  centre: [number, number, number],
): number {
  const stride = strideFor(vertices)
  let best = 0
  let bestScore = -1
  for (let orientation = 0; orientation < ORIENTATIONS.length; orientation++) {
    const map = ORIENTATIONS[orientation]
    let score = 0
    for (let i = 0; i + 2 < vertices.length; i += stride) {
      const [x, y] = map(
        vertices[i + crossA] - centre[crossA],
        vertices[i + crossB] - centre[crossB],
      )
      if (nearPolygon(x, y, profile)) score++
    }
    if (score > bestScore) {
      bestScore = score
      best = orientation
    }
  }
  return best
}

/** Fraction (0..1) of the part's cross-section vertices inside the rotated profile. */
export function orientationFit(
  profile: [number, number][],
  orientation: number,
  vertices: number[],
  crossA: number,
  crossB: number,
  centre: [number, number, number],
): number {
  const map = ORIENTATIONS[orientation]
  const stride = strideFor(vertices)
  let inside = 0
  let total = 0
  for (let i = 0; i + 2 < vertices.length; i += stride) {
    const [x, y] = map(vertices[i + crossA] - centre[crossA], vertices[i + crossB] - centre[crossB])
    if (nearPolygon(x, y, profile)) inside++
    total++
  }
  return total === 0 ? 0 : inside / total
}
