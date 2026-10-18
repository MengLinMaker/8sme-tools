/**
 * The cross-section face frame shared by the NC→solid rebuild and the viewer's toolpath
 * projection.
 *
 * DSTV faces pair up: `v`/`h` (web) share one cross-section axis, `o`/`u` (flange) the other.
 * Which section axis is which is decided by matching a contour's across-extent to the section's
 * two dimensions — the same rule `reconstructFromNc` uses to build the solid, so the viewer
 * projects each cut onto exactly the face the laser cuts.
 *
 * DSTV reference (Klietsch poster / DSTV standard): `o`=Topview, `u`=Bottomview, `v`=Frontview
 * (the *right* face), `h`=Rearview (the *left* face). That letter→side mapping is anchored to
 * each profile's reference pose and is unreliable for one-sided sections (T, channel, angle),
 * which is exactly why nothing here trusts the letter — the side is resolved from the section's
 * own material (`resolveFaceSign`), with the letter only as a tie-break.
 *
 * Everything here is pure (no three.js / OCC): axes are the section outline's own 2D axes
 * (0 = x/width, 1 = y/depth), matching `partSectionForCode` / `stockOutlineForCode`.
 */

import { profileFamily } from '@/lib/sections/canonical'
import type { NcContour, NcFace, NcGeometry } from './ncGeometry'

export type Axis = 0 | 1

export interface NcFaceFrame {
  /** Section extent along each axis. */
  extent: [number, number]
  /** Section axis the `v`/`h` faces span. */
  axisVH: Axis
  /** Section axis the `o`/`u` faces span. */
  axisOU: Axis
  /**
   * DSTV/Tekla profile code the frame was resolved for, when known. A channel's face coordinates are
   * authored in Tekla's web-vertical stance — a 90° rotation of our canonical `n` (`stock.ts:channel`)
   * — so its across direction is reversed on one axis. See {@link ncAuthoredAcrossSign}.
   */
  profile?: string
  /**
   * Half-thickness of an I-section's web, measured on the axis its `v`/`h` faces are normal to.
   * The web is **interior** (near the section's mid-width), so `v`/`h` cuts sit on the web's
   * surface rather than the bounding-box edge. Absent for every other family.
   */
  webHalf?: number
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

/**
 * Resolves the section axis each face pair lives on, matching the NC→solid rebuild. Pass the DSTV
 * `profile` code when known so the frame carries the authored-stance info {@link ncAuthoredAcrossSign}
 * needs to place a channel's across coordinate correctly.
 */
export function resolveNcFaceFrame(
  section: [number, number][],
  nc: NcGeometry,
  profile?: string,
): NcFaceFrame {
  const ex = extentOf(section, 0)
  const ey = extentOf(section, 1)
  const match = (across: number): Axis => (Math.abs(across - ex) <= Math.abs(across - ey) ? 0 : 1)
  const vh = nc.contours.find((c) => c.kind === 'outer' && (c.face === 'v' || c.face === 'h'))
  const ou = nc.contours.find((c) => c.kind === 'outer' && (c.face === 'o' || c.face === 'u'))
  const axisVH: Axis = vh ? match(maxAcross(vh)) : ou ? ((1 - match(maxAcross(ou))) as Axis) : 0
  const frame: NcFaceFrame = { extent: [ex, ey], axisVH, axisOU: (1 - axisVH) as Axis }
  if (profile) frame.profile = profile
  // An I-section's `v`/`h` faces are the **web** (interior), not the width edges. Its surface sits
  // at the smallest |cross coordinate| in the section (the web half-thickness); the outline's width
  // extremes are the flange edges.
  if (profile && profileFamily(profile) === 'i') {
    const widthAxis = (1 - axisVH) as Axis
    let min = Number.POSITIVE_INFINITY
    for (const p of section) {
      const value = Math.abs(p[widthAxis] ?? 0)
      if (value > 1e-6 && value < min) min = value
    }
    if (Number.isFinite(min)) frame.webHalf = min
  }
  return frame
}

/** Section axis a face's width spans. */
export function faceSpanAxis(frame: NcFaceFrame, face: NcFace): Axis {
  return face === 'v' || face === 'h' ? frame.axisVH : frame.axisOU
}

/** Half the section extent along an axis. */
export function faceHalf(frame: NcFaceFrame, axis: Axis): number {
  return frame.extent[axis] / 2
}

/**
 * Half-distance from the section centre to the surface a face's cuts sit on. For every family but
 * `I` this is the bounding-box half-extent (the face is on the silhouette). An I-section's `v`/`h`
 * web faces are **interior**, so their plane is the web half-thickness (`frame.webHalf`) — a cut on
 * `v` touches the web's top surface, near the middle of the section, not the top edge.
 */
export function facePlaneHalf(frame: NcFaceFrame, face: NcFace): number {
  if (frame.webHalf !== undefined && (face === 'v' || face === 'h')) return frame.webHalf
  return faceHalf(frame, (1 - faceSpanAxis(frame, face)) as Axis)
}

/**
 * Rotates a canonical section outline into the DSTV/Tekla **authored stance** the NC face coordinates
 * live in. Two families differ: a `PFC`/`TFC` channel is authored web-vertical, a 90° rotation of our
 * canonical `n` stance (`stock.ts:channel`); and an I-section (UB/WB/UC/WC/TFB) is authored
 * web-vertical, a 90° rotation of our canonical `H` stance (`stock.ts:iSectionOutline`). Either way
 * `reconstructFromNc` builds in this authored stance and rolls the finished solid back — the axis and
 * sign maths below stay the web-vertical ones they were validated on. Returns the points unchanged
 * for every other family (authored = canonical).
 */
export function ncAuthoredStancePoints(
  profile: string | undefined,
  points: [number, number][],
): [number, number][] {
  const family = profile ? profileFamily(profile) : null
  if (family === 'channel') return points.map(([x, y]) => [-y, x] as [number, number])
  // Canonical H is the authored pose rotated 90° CCW (`iSectionCanonical`), so the inverse is CW.
  if (family === 'i') return points.map(([x, y]) => [y, -x] as [number, number])
  return points
}

/**
 * Sign to apply to a face's across (span) coordinate so a DSTV/Tekla-authored NC point lands in our
 * canonical stance. Two families differ:
 *
 *  - **Channel**: rotating the authored channel stance back to canonical (`[-y,x]` then a −90° roll
 *    about the member axis) reverses both across directions relative to how the face letters read,
 *    so every channel face is negated.
 *  - **Tube (RHS)**: the canonical long-side-horizontal stance is the authored long-side-vertical
 *    stance rotated 90° CW, so the short faces (`o`/`u`) read the opposite way along the member; the
 *    long faces (`v`/`h`) keep the authored direction. A **square** (SHS) is rotationally symmetric,
 *    so it keeps Tekla's authored stance (no rotation) — the seat finds no cross-section cue.
 *
 * Every other family shares our stance (sign +1).
 */
export function ncAuthoredAcrossSign(frame: NcFaceFrame, face: NcFace): 1 | -1 {
  const family = frame.profile ? profileFamily(frame.profile) : null
  if (family === 'channel') return -1
  if (family === 'i') {
    // Canonical H is the authored reference pose rotated 90° CCW, so the web faces' across
    // direction (the depth) runs the opposite way in the canonical section. Flange faces keep it.
    return face === 'v' || face === 'h' ? -1 : 1
  }
  if (family === 'tube') {
    if (isSquareTube(frame)) return 1
    return face === 'o' || face === 'u' ? -1 : 1
  }
  return 1
}

/** A tube whose two cross-section dimensions are equal (SHS) — no long-side rotation to apply. */
export function isSquareTube(frame: NcFaceFrame): boolean {
  return Math.abs(frame.extent[0] - frame.extent[1]) < 0.5
}

/**
 * Which side of the section a face sits on when the profile is asymmetric (a one-sided T flange, a
 * channel web, an angle leg). The DSTV pairing (`+u/−o`, `+h/−v`) is a *rotation* rule that only
 * holds for a symmetric section; where the section has material on one side only, the face must be
 * projected onto that side or its cut line lands in mid-air. Samples the outline along the face
 * span and picks the side whose outward plane the material reaches; ties fall back to the letter.
 */
export function resolveFaceSign(
  frame: NcFaceFrame,
  section: [number, number][],
  face: NcFace,
): 1 | -1 {
  const span = faceSpanAxis(frame, face)
  const half = facePlaneHalf(frame, face)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const p of section) {
    min = Math.min(min, p[span])
    max = Math.max(max, p[span])
  }
  const steps = 12
  let plus = 0
  let minus = 0
  for (let i = 0; i <= steps; i++) {
    const c = min + ((max - min) * i) / steps
    const [lo, hi] = sectionSpanAt(section, span, c)
    if (hi >= half - 2) plus++
    if (lo <= -half + 2) minus++
  }
  if (plus > minus) return 1
  if (minus > plus) return -1
  // Symmetric sections tie; the letter's side depends on the family's canonical rotation. An
  // I-section sits in the H stance (`iSectionCanonical` rotated the reference pose 90° CCW): the
  // flange faces `o`/`u` are the two sides and the web faces `v`/`h` bottom/top. The CCW rotation
  // swaps which depth side `o` and `u` land on relative to the authored pose, so `o` is + and `u`
  // is − (matching the manufactured solid); `v` stays +. A long-side-horizontal tube puts `o`
  // (short right face) and `h` (long top face) on the +side; a square (SHS) keeps the authored
  // DSTV pairing (no rotation).
  const family = frame.profile ? profileFamily(frame.profile) : null
  if (family === 'i') return face === 'o' || face === 'v' ? 1 : -1
  if (family === 'tube') {
    if (isSquareTube(frame)) return face === 'u' || face === 'h' ? 1 : -1
    return face === 'o' || face === 'h' ? 1 : -1
  }
  return face === 'u' || face === 'h' ? 1 : -1
}

/**
 * The face's outward normal: the other section axis, and the side it sits on. When `section` is
 * supplied the side is resolved from material presence ({@link resolveFaceSign}) so one-sided
 * profiles map correctly; without it the DSTV letter convention is used.
 */
export function faceNormal(
  frame: NcFaceFrame,
  face: NcFace,
  section?: [number, number][],
): { axis: Axis; sign: 1 | -1 } {
  return {
    axis: (1 - faceSpanAxis(frame, face)) as Axis,
    sign: section ? resolveFaceSign(frame, section, face) : face === 'u' || face === 'h' ? 1 : -1,
  }
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
  section?: [number, number][],
): { along: number; cross: [number, number] } {
  const span = faceSpanAxis(frame, face)
  const other = (1 - span) as Axis
  const sign = section
    ? resolveFaceSign(frame, section, face)
    : face === 'u' || face === 'h'
      ? 1
      : -1
  const cross: [number, number] = [0, 0]
  cross[span] = ncAuthoredAcrossSign(frame, face) * (y - faceHalf(frame, span))
  cross[other] = sign * facePlaneHalf(frame, face)
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
  const normal = faceNormal(frame, face, section)
  const [lo, hi] = sectionSpanAt(section, span, cross[span])
  const half = facePlaneHalf(frame, face)
  return normal.sign > 0 ? hi >= half - 2 : lo <= -half + 2
}
