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
 * Rotates a canonical section outline into the DSTV/Tekla **authored stance** the NC face coordinates
 * live in. Only channels differ: Tekla exports a PFC/TFC web-vertical, a 90° rotation of our canonical
 * `n` stance (`stock.ts:channel`), so `reconstructFromNc` builds in this stance and rolls the finished
 * solid back. Returns the points unchanged for every other family (authored = canonical).
 */
export function ncAuthoredStancePoints(
  profile: string | undefined,
  points: [number, number][],
): [number, number][] {
  if (!profile || profileFamily(profile) !== 'channel') return points
  return points.map(([x, y]) => [-y, x] as [number, number])
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
  const axis = (1 - span) as Axis
  const half = faceHalf(frame, axis)
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
  // Symmetric sections tie; the letter's side depends on the family's canonical rotation. A
  // long-side-horizontal tube puts `o` (short right face) and `h` (long top face) on the +side; a
  // square (SHS) keeps the authored DSTV pairing (no rotation).
  const family = frame.profile ? profileFamily(frame.profile) : null
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
  cross[other] = sign * faceHalf(frame, other)
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
  const half = faceHalf(frame, normal.axis)
  return normal.sign > 0 ? hi >= half - 2 : lo <= -half + 2
}
