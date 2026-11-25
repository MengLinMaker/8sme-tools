/**
 * A generated cross-section contour: **lines and real circular arcs**, not a sampled polyline.
 *
 * Every stock outline in `stock.ts` is built from known parameters (widths, thicknesses, root /
 * corner / toe radii), so the corner geometry is known exactly at generation time. Keeping it as
 * primitives means the STEP rebuild extrudes the *actual* rounded section — one cylindrical brep
 * face per corner, outer outline and inner void alike — with nothing to re-fit or approximate.
 *
 * A polyline is still available on demand ({@link outlinePoints}) for consumers that genuinely
 * need one (canvas ghost, SVG, area, NCEP `cadgroup`). It is derived from the primitives, so the
 * primitives stay the single source of truth.
 *
 * An outline is **not closed**: the last edge's end connects back to `start`.
 */

export type Pt = [number, number]

/** Samples per generated arc when a polyline is requested. */
export const ARC_STEPS = 6
/** Samples for a full round contour when a polyline is requested. */
export const CIRCLE_STEPS = 48

export interface OutlineLine {
  kind: 'line'
  to: Pt
}

export interface OutlineArc {
  kind: 'arc'
  to: Pt
  center: Pt
  radius: number
  /** Angle (radians) of the arc's first point on its circle. */
  start: number
  /** Signed sweep (radians); positive is counter-clockwise. */
  sweep: number
}

/** A whole contour that is one circle (a CHS wall, a round void). */
export interface OutlineCircle {
  kind: 'circle'
  center: Pt
  radius: number
  /** Direction the contour runs: a void is wound opposite to its outer outline. */
  ccw: boolean
}

export type OutlineEdge = OutlineLine | OutlineArc | OutlineCircle

export interface Outline {
  start: Pt
  edges: OutlineEdge[]
}

export function pointOnCircle(center: Pt, radius: number, angle: number): Pt {
  return [center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius]
}

const same = (a: Pt, b: Pt, eps = 1e-9): boolean =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps

export interface OutlineBuilder {
  /** Straight edge to `to` (skipped when the pen is already there). */
  lineTo(to: Pt): OutlineBuilder
  /** Arc on `center`, from angle `start` to `end` (radians), adding a lead-in line if the arc
   * does not begin at the pen — the contour is a chain, so every edge starts where the last one
   * ended. */
  arcTo(center: Pt, radius: number, start: number, end: number): OutlineBuilder
  /** Whole-circle contour, for a round stock or void. */
  circle(center: Pt, radius: number): OutlineBuilder
  done(): Outline
}

export function outline(start: Pt): OutlineBuilder {
  const edges: OutlineEdge[] = []
  let pen = start
  const builder: OutlineBuilder = {
    lineTo(to) {
      if (!same(pen, to)) {
        edges.push({ kind: 'line', to })
        pen = to
      }
      return builder
    },
    arcTo(center, radius, start, end) {
      if (!(radius > 0) || Math.abs(end - start) < 1e-12)
        return builder.lineTo(pointOnCircle(center, radius, end))
      builder.lineTo(pointOnCircle(center, radius, start))
      const to = pointOnCircle(center, radius, end)
      edges.push({ kind: 'arc', to, center, radius, start, sweep: end - start })
      pen = to
      return builder
    },
    circle(center, radius) {
      builder.lineTo(pointOnCircle(center, radius, 0))
      edges.push({ kind: 'circle', center, radius, ccw: true })
      return builder
    },
    done() {
      return { start, edges: [...edges] }
    },
  }
  return builder
}

/**
 * Polyline form of the contour, sampled at the historical resolution (6 steps per arc, 48 for a
 * full circle) so existing consumers — ghost, area, NCEP — see exactly the section they saw before.
 */
export function outlinePoints(
  contour: Outline,
  arcSteps = ARC_STEPS,
  circleSteps = CIRCLE_STEPS,
): Pt[] {
  const points: Pt[] = [contour.start]
  const push = (point: Pt) => {
    const last = points[points.length - 1]
    if (last && same(last, point, 1e-6)) return
    points.push(point)
  }
  for (const edge of contour.edges) {
    if (edge.kind === 'line') {
      push(edge.to)
    } else if (edge.kind === 'arc') {
      for (let i = 0; i <= arcSteps; i++) {
        push(pointOnCircle(edge.center, edge.radius, edge.start + (edge.sweep * i) / arcSteps))
      }
    } else {
      for (let i = 0; i < circleSteps; i++) {
        const angle = (i / circleSteps) * Math.PI * 2
        push(pointOnCircle(edge.center, edge.radius, edge.ccw ? angle : -angle))
      }
    }
  }
  const first = points[0]
  const last = points[points.length - 1]
  if (first && last && points.length > 1 && same(first, last, 1e-6)) points.pop()
  return points
}

/** Moves the whole contour. */
export function translateOutline(contour: Outline, dx: number, dy: number): Outline {
  const move = ([x, y]: Pt): Pt => [x + dx, y + dy]
  return {
    start: move(contour.start),
    edges: contour.edges.map((edge): OutlineEdge => {
      if (edge.kind === 'line') return { ...edge, to: move(edge.to) }
      if (edge.kind === 'circle') return { ...edge, center: move(edge.center) }
      return { ...edge, to: move(edge.to), center: move(edge.center) }
    }),
  }
}

/** Rotates the contour about the origin; arc angles follow the rotation exactly. */
export function rotateOutline(contour: Outline, angle: number): Outline {
  // Snap quarter/half turns so a 90° rotation stays bit-exact (cos(−π/2) is 6e-17, not 0) and the
  // rotated section samples the same points as an axis swap.
  const cos = Math.abs(Math.cos(angle)) < 1e-12 ? 0 : Math.cos(angle)
  const sin = Math.abs(Math.sin(angle)) < 1e-12 ? 0 : Math.sin(angle)
  const turn = ([x, y]: Pt): Pt => [x * cos - y * sin, x * sin + y * cos]
  return {
    start: turn(contour.start),
    edges: contour.edges.map((edge): OutlineEdge => {
      if (edge.kind === 'line') return { ...edge, to: turn(edge.to) }
      if (edge.kind === 'circle') return { ...edge, center: turn(edge.center) }
      return { ...edge, to: turn(edge.to), center: turn(edge.center), start: edge.start + angle }
    }),
  }
}

/** Reverses the contour's direction (a void is wound opposite to its outer outline). */
export function reverseOutline(contour: Outline): Outline {
  const only = contour.edges.length === 1 ? contour.edges[0] : undefined
  if (only?.kind === 'circle') return { ...contour, edges: [{ ...only, ccw: !only.ccw }] }

  // Vertex `i` is where edge `i` starts (vertex 0 is `start`); the contour then closes back to it.
  const verts: Pt[] = [contour.start]
  for (const edge of contour.edges) {
    if (edge.kind === 'circle')
      throw new Error('reverseOutline: circle mixed into a chained contour')
    verts.push(edge.to)
  }

  const edges: OutlineEdge[] = []
  for (let i = contour.edges.length - 1; i >= 0; i--) {
    const edge = contour.edges[i] as Exclude<OutlineEdge, OutlineCircle>
    const to = verts[i] as Pt
    if (edge.kind === 'line') {
      edges.push({ kind: 'line', to })
    } else {
      // Reversing starts at the far end and sweeps back the other way — exact angle arithmetic,
      // so a reversed void samples the same points it did before.
      edges.push({
        kind: 'arc',
        center: edge.center,
        radius: edge.radius,
        start: edge.start + edge.sweep,
        sweep: -edge.sweep,
        to,
      })
    }
  }
  return { start: verts[verts.length - 1] as Pt, edges }
}
