/**
 * The cross-section face frame shared by the NC→solid rebuild and the viewer's toolpath
 * projection.
 *
 * DSTV faces pair up: `v`/`h` (web) share one cross-section axis, `o`/`u` (flange) the other.
 * Which section axis is which is decided by matching a contour's across-extent to the section's
 * two dimensions — the same rule `reconstructFromNc` uses to build the solid, so the viewer
 * projects each cut onto exactly the face the laser cuts.
 *
 * Everything here is pure (no three.js / OCC): axes are the section outline's own 2D axes
 * (0 = x/width, 1 = y/depth), matching `partSectionForCode` / `stockOutlineForCode`.
 */

import type { NcContour, NcFace, NcGeometry } from './ncGeometry'

export type Axis = 0 | 1

export interface NcFaceFrame {
  /** Section extent along each axis. */
  extent: [number, number]
  /** Section axis the `v`/`h` faces span. */
  axisVH: Axis
  /** Section axis the `o`/`u` faces span. */
  axisOU: Axis
}

function extentOf(points: [number, number][], axis: Axis): number {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const p of points) {
    min = Math.min(min, p[axis])
    max = Math.max(max, p[axis])
  }
  return max - min
}

function maxAcross(contour: NcContour): number {
  return Math.max(...contour.points.map((p) => p[1]))
}

/** Resolves the section axis each face pair lives on, matching the NC→solid rebuild. */
export function resolveNcFaceFrame(section: [number, number][], nc: NcGeometry): NcFaceFrame {
  const ex = extentOf(section, 0)
  const ey = extentOf(section, 1)
  const match = (across: number): Axis => (Math.abs(across - ex) <= Math.abs(across - ey) ? 0 : 1)
  const vh = nc.contours.find((c) => c.kind === 'outer' && (c.face === 'v' || c.face === 'h'))
  const ou = nc.contours.find((c) => c.kind === 'outer' && (c.face === 'o' || c.face === 'u'))
  const axisVH: Axis = vh ? match(maxAcross(vh)) : ou ? ((1 - match(maxAcross(ou))) as Axis) : 0
  return { extent: [ex, ey], axisVH, axisOU: (1 - axisVH) as Axis }
}

/** Section axis a face's width spans. */
export function faceSpanAxis(frame: NcFaceFrame, face: NcFace): Axis {
  return face === 'v' || face === 'h' ? frame.axisVH : frame.axisOU
}

/**
 * The face's outward normal: the other section axis, and the side it sits on. Empirically the
 * projected toolpath lines up with the manufactured model (o/Ø-small and u/Ø-big on the correct
 * flanges) only with `u`/`h` positive and `o`/`v` negative.
 */
export function faceNormal(frame: NcFaceFrame, face: NcFace): { axis: Axis; sign: 1 | -1 } {
  return {
    axis: (1 - faceSpanAxis(frame, face)) as Axis,
    sign: face === 'u' || face === 'h' ? 1 : -1,
  }
}

/** Half the section extent along an axis. */
export function faceHalf(frame: NcFaceFrame, axis: Axis): number {
  return frame.extent[axis] / 2
}

/**
 * Places an NC per-face point into the section frame: `along` runs down the member,
 * `cross` is the 2D section coordinate the line sits at.
 */
export function placeNcFace(
  frame: NcFaceFrame,
  face: NcFace,
  x: number,
  y: number,
): { along: number; cross: [number, number] } {
  const span = faceSpanAxis(frame, face)
  const other = (1 - span) as Axis
  const cross: [number, number] = [0, 0]
  cross[span] = y - faceHalf(frame, span)
  cross[other] = (face === 'u' || face === 'h' ? 1 : -1) * faceHalf(frame, other)
  return { along: x, cross }
}

/**
 * Cross-section interior span along one axis at a position on the other (even-odd scanline over
 * the outline). Picks the drill side for one-sided sections: a T flange lives on one side only,
 * so face-pair symmetry (+v/−h) cannot tell where the material is — but the outline can.
 */
export function sectionSpanAt(
  points: [number, number][],
  crossAxis: Axis,
  c: number,
): [number, number] {
  const drillAxis = (1 - crossAxis) as Axis
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let i = 0; i < points.length; i++) {
    const p = points[i] ?? [0, 0]
    const q = points[(i + 1) % points.length] ?? [0, 0]
    const pc = p[crossAxis] ?? 0
    const qc = q[crossAxis] ?? 0
    if (pc <= c === qc <= c) continue
    const t = (c - pc) / (qc - pc)
    const xd = (p[drillAxis] ?? 0) + t * ((q[drillAxis] ?? 0) - (p[drillAxis] ?? 0))
    if (xd < lo) lo = xd
    if (xd > hi) hi = xd
  }
  return [lo, hi]
}

/**
 * Whether the section has material at a face's outward plane for a given across position. A cut
 * that lines up with the edge of the stock (no material on that side, e.g. the stem side of a T)
 * removes nothing, so the viewer drops it.
 */
export function materialReaches(
  frame: NcFaceFrame,
  section: [number, number][],
  face: NcFace,
  cross: [number, number],
): boolean {
  const span = faceSpanAxis(frame, face)
  const normal = faceNormal(frame, face)
  const [lo, hi] = sectionSpanAt(section, span, cross[span])
  const half = faceHalf(frame, normal.axis)
  return normal.sign > 0 ? hi >= half - 2 : lo <= -half + 2
}
