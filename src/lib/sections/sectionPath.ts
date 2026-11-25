/**
 * Turns a sampled stock-section contour into real primitives.
 *
 * The section builders in `stock.ts` (and the catalogue outlines they draw from) return a
 * **polyline** — rounded corners are sampled into ~6 chords each. That is fine for a cheap ghost
 * or an area estimate, but it is not the geometry to manufacture: a hollow's corner must be one
 * circular edge, not a fan of facets, or WiseCAM reads the section as a custom profile instead of
 * the standard RHS/SHS/UB it is.
 *
 * `sectionPath` fits a circle through each run of co-circular samples and collapses the run into a
 * single arc (or, for a full circular contour, a single circle). Everything else stays a line, so
 * a sharp corner is never rounded off.
 *
 * The samples the builders emit are **exactly** on their circle (they come from `cos`/`sin`, and
 * the stance rotations are exact), so the merge tolerance can be tight enough that a mixed fit
 * across a straight edge and the start of an arc never passes as one circle. On top of that a run
 * must turn like an arc (fine sample steps, tangent continuity with the chords inside the run) and
 * must be a plausible section radius.
 */

export type Pt = [number, number]

/** Distance within which two fitted circles are the same circle. Builder samples agree to ~1e-12. */
const SAME_CIRCLE_MM = 1e-6
/** Chord-to-tangent angle allowed for a sampled arc's own (internal) chords, in radians (~14°). */
const TANGENT_TOL = 0.25
/** Largest angle a single sample step may subtend on its circle before it is not a sampled arc. */
const MAX_STEP_RAD = Math.PI / 3

/** Fitted circle through three points, or null when they are collinear. */
export interface FittedCircle {
  center: Pt
  radius: number
}

export type SectionSegment =
  | { kind: 'line'; to: Pt }
  /** A real circular arc from the previous point to `to`. `radius` is signed by turn direction. */
  | { kind: 'arc'; to: Pt; center: Pt; radius: number; sagitta: number }
  /** The whole contour is one circle (CHS, a bored circle, a round void). */
  | { kind: 'circle'; center: Pt; radius: number }

export interface SectionPath {
  start: Pt
  segments: SectionSegment[]
}

/** Circle through three points: its centre and radius, or null if they are collinear. */
export function circleThrough(a: Pt, b: Pt, c: Pt, eps = 1e-9): FittedCircle | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < eps) return null
  const aa = a[0] ** 2 + a[1] ** 2
  const bb = b[0] ** 2 + b[1] ** 2
  const cc = c[0] ** 2 + c[1] ** 2
  const cx = (aa * (b[1] - c[1]) + bb * (c[1] - a[1]) + cc * (a[1] - b[1])) / d
  const cy = (aa * (c[0] - b[0]) + bb * (a[0] - c[0]) + cc * (b[0] - a[0])) / d
  const radius = Math.hypot(b[0] - cx, b[1] - cy)
  return Number.isFinite(radius) && radius > 0 ? { center: [cx, cy], radius } : null
}

/** `a` and `b` are the same circle (centre and radius within `tol`). */
function sameCircle(a: FittedCircle | null, b: FittedCircle | null, tol: number): boolean {
  if (!a || !b) return false
  return (
    Math.abs(a.radius - b.radius) <= tol &&
    Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) <= tol
  )
}

/** Angle at `center` between two samples. */
function stepAngle(center: Pt, a: Pt, b: Pt): number {
  const a0 = Math.atan2(a[1] - center[1], a[0] - center[0])
  const a1 = Math.atan2(b[1] - center[1], b[0] - center[0])
  let angle = Math.abs(a1 - a0)
  if (angle > Math.PI) angle = 2 * Math.PI - angle
  return angle
}

/**
 * Angle between the chord `a → b` and the circle's tangent where the chord leaves `a`.
 *
 * A sampled arc's chords leave within half a sample step of the tangent; a chord that cuts across
 * a straight edge (the mixed fit where a flat meets an arc) leaves at a large angle.
 */
function tangentGap(a: Pt, b: Pt, center: Pt, ccw: boolean): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length = Math.hypot(dx, dy)
  if (!(length > 1e-9)) return Number.POSITIVE_INFINITY
  const rx = a[0] - center[0]
  const ry = a[1] - center[1]
  const tx = ccw ? -ry : ry
  const ty = ccw ? rx : -rx
  const tLength = Math.hypot(tx, ty)
  if (!(tLength > 1e-9)) return Number.POSITIVE_INFINITY
  const cos = (dx * tx + dy * ty) / (length * tLength)
  return Math.acos(Math.max(-1, Math.min(1, cos)))
}

/** Signed turn at `b` along `a → b → c` (positive = counter-clockwise). */
function turn(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
}

/** Drops repeated points and a duplicated closing vertex. */
function cleanLoop(points: Pt[], eps = 1e-6): Pt[] {
  const out: Pt[] = []
  for (const point of points) {
    const last = out[out.length - 1]
    if (last && Math.hypot(last[0] - point[0], last[1] - point[1]) < eps) continue
    out.push(point)
  }
  const first = out[0]
  const last = out[out.length - 1]
  if (first && last && out.length > 1 && Math.hypot(first[0] - last[0], first[1] - last[1]) < eps) {
    out.pop()
  }
  return out
}

/** The whole loop is one circle, or null. Needs enough samples to be a real round contour. */
function wholeCircle(points: Pt[], tol: number): FittedCircle | null {
  const n = points.length
  if (n < 8) return null
  const at = (i: number): Pt => points[((i % n) + n) % n] as Pt
  // Three well-spread samples define the circle; every other sample must lie on it.
  const fit = circleThrough(at(0), at(Math.floor(n / 3)), at(Math.floor((2 * n) / 3)))
  if (!fit) return null
  const onCircle = points.every(
    (p) => Math.abs(Math.hypot(p[0] - fit.center[0], p[1] - fit.center[1]) - fit.radius) <= tol,
  )
  return onCircle ? fit : null
}

/**
 * Walks the contour starting at `offset` and returns its segments, merging every run of samples
 * that lie on one circle into a single arc.
 */
function walk(pts: Pt[], offset: number, tol: number, maxRadius: number): SectionPath {
  const n = pts.length
  const at = (i: number): Pt => pts[(((offset + i) % n) + n) % n] as Pt
  // Circle fitted at each sample through its two neighbours, in walk order.
  const vertex = (i: number): FittedCircle | null => {
    const k = ((i % n) + n) % n
    return circleThrough(at(k - 1), at(k), at(k + 1))
  }
  const atVertex = Array.from({ length: n }, (_, i) => vertex(i))

  const segments: SectionSegment[] = []
  let i = 0
  while (i < n) {
    // The fit at the sample just past `i` is the run's circle: the first whose three samples all
    // lie inside a possible arc.
    const ref = i + 1 < n ? (atVertex[i + 1] ?? null) : null
    let last = i + 1
    if (ref) {
      // Extend while the next sample's fit agrees with the run's circle. Each extension admits one
      // more sample and confirms the previous three still sit on the same circle.
      while (last + 1 < n && sameCircle(atVertex[last] ?? null, ref, tol)) last++
    }
    const from = at(i)
    const to = at(last)

    // A run needs four samples (three sampled steps) to be worth merging — the builders sample
    // every corner into at least six steps, so a three-point fit is a polygon corner, not a
    // sampled arc. It also needs a real turn, a plausible radius, a sweep below a half-turn (the
    // sagitta below describes the minor arc), fine sample steps, tangent continuity with its own
    // chords, and **evenly spaced** samples: every builder walks an arc in equal angular steps,
    // while a circle fitted across a straight edge and the start of a corner comes out with one
    // huge step beside one tiny one. Without that last test a long flat face merges into a
    // near-tangent "arc" of absurd radius.
    let merge = last - i >= 3 && ref !== null
    if (merge && ref) {
      const ccw = turn(from, at(i + 1), at(i + 2)) > 0
      let sweep = stepAngle(ref.center, from, to)
      if (sweep > Math.PI) sweep = 2 * Math.PI - sweep
      merge =
        sweep < Math.PI * 0.999 &&
        ref.radius <= maxRadius &&
        tangentGap(from, at(i + 1), ref.center, ccw) <= TANGENT_TOL &&
        tangentGap(at(last - 1), to, ref.center, ccw) <= TANGENT_TOL
      let minStep = Number.POSITIVE_INFINITY
      let maxStep = 0
      for (let k = i + 1; k <= last; k++) {
        const step = stepAngle(ref.center, at(k - 1), at(k))
        minStep = Math.min(minStep, step)
        maxStep = Math.max(maxStep, step)
      }
      merge = merge && maxStep <= MAX_STEP_RAD && maxStep <= 1.5 * minStep
    }

    if (merge && ref) {
      const ccw = turn(from, at(i + 1), at(i + 2)) > 0
      const chord = Math.hypot(to[0] - from[0], to[1] - from[1])
      const sagitta = ref.radius - Math.sqrt(Math.max(0, ref.radius ** 2 - (chord / 2) ** 2))
      // Counter-clockwise travel bulges the arc to the left, which replicad encodes as a negative
      // sagitta — the same convention the NC cut arcs use.
      segments.push({
        kind: 'arc',
        to,
        center: ref.center,
        radius: ref.radius,
        sagitta: ccw ? -sagitta : sagitta,
      })
      i = last
    } else {
      // Rejecting a long run must not skip its samples — step one edge and re-fit from there.
      segments.push({ kind: 'line', to: at(i + 1) })
      i += 1
    }
  }
  return { start: at(0), segments }
}

/**
 * Decomposes a sampled closed contour into lines and real arcs.
 *
 * The walk is tried from every sample and the decomposition with the fewest segments wins, so a
 * corner that straddles the array seam (or the start of the sample list) is still one arc instead
 * of two.
 */
export function sectionPath(points: Pt[], tol = SAME_CIRCLE_MM): SectionPath | null {
  const pts = cleanLoop(points)
  if (pts.length < 3) return null

  const circle = wholeCircle(pts, tol)
  if (circle) {
    return {
      start: pts[0] as Pt,
      segments: [{ kind: 'circle', center: circle.center, radius: circle.radius }],
    }
  }

  // A real section corner radius is a small fraction of the section; a fit far larger than the
  // contour is a near-collinear sliver, not an arc.
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  const maxRadius = 2 * diagonal

  let best: SectionPath | null = null
  for (let offset = 0; offset < pts.length; offset++) {
    const path = walk(pts, offset, tol, maxRadius)
    if (!best || path.segments.length < best.segments.length) best = path
  }
  return best
}
