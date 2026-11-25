import type { NcFace } from '@/lib/parsers/ncGeometry'

/**
 * WiseCAM's unrolled part layout, derived from 17 real `.ncep` exports.
 *
 * A part is developed onto a rectangle: `x` = perimeter station, `y` = along the member.
 * Only the **cuttable/front** surface is developed — for an I-section that is the two
 * flange outer faces plus the web (the back/inner faces are not drawn).
 *
 * Two origins are used by WiseCAM:
 * - `centered` (`I`, `U`): stations run `-seam/2 … +seam/2`.
 * - `zero` (`M`): stations run `0 … seam`, with the seam starting at the **`v` face centre**.
 */

export interface FaceRegion {
  /** Station where the face's developed span starts. */
  start: number
  /** Developed face length (mm). */
  length: number
  /** Whether the NC's Y axis runs against the station axis. */
  reversed: boolean
  /** NC face width (mm) — the Y coordinate spans `0 … width`. */
  width?: number
  /** Outer corner radius (mm); the face edges are arcs, not flat. */
  radius?: number
}

export interface UnrolledLayout {
  seam: number
  origin: 'centered' | 'zero'
  faces: Partial<Record<NcFace, FaceRegion>>
}

/** Straight-corner deduction for one rounded corner: `2 − π/2`. */
const CORNER_FACTOR = 2 - Math.PI / 2

const face = (
  start: number,
  length: number,
  width = length,
  radius = 0,
  reversed = false,
): FaceRegion => ({ start, length, reversed, width, radius })

/**
 * Maps an NC across-coordinate `y` (`0 … width`) onto the developed face (`0 … length`).
 *
 * A rounded face is `half-corner arc + flat + half-corner arc`; the middle of the face maps to
 * the middle of the flat, which is why the hole at the face centre lands at `length / 2`.
 */
function localCoordinate(region: FaceRegion, y: number): number {
  const radius = region.radius ?? 0
  const width = region.width ?? region.length
  if (radius <= 0 || width <= 2 * radius) return y
  const halfArc = (Math.PI / 2) * radius * 0.5
  const flat = width - 2 * radius
  if (y <= radius) return (halfArc * y) / radius
  if (y >= width - radius) return halfArc + flat + (halfArc * (y - (width - radius))) / radius
  return halfArc + (y - radius)
}

/**
 * The unrolled layout for a DSTV profile type + header dims, or null for families we have no
 * worked example for (`T`, `L`, `RO`).
 *
 * DSTV header dims for `I`/`U`: `[depth, flangeWidth, tf, tw, r]`.
 * For `M`: `[width, height, wall, wall, r]`.
 */
export interface LayoutOptions {
  /**
   * Mirrored/handed part: swap the `o`/`u` flange regions. Handedness is not in the NC
   * header, so this is an explicit per-part choice until a rule is derived.
   */
  flipFlanges?: boolean
}

export function unrolledLayout(
  profileType: string | undefined,
  dims: number[],
  options: LayoutOptions = {},
): UnrolledLayout | null {
  const type = (profileType ?? '').trim().toUpperCase()
  const [first, second, , tw, r] = dims
  if (first == null || second == null) return null

  if (type === 'U') {
    const depth = first
    const flange = second
    const seam = depth + 2 * flange
    const half = seam / 2
    const faces: UnrolledLayout['faces'] = {
      // The bottom view (`u`) looks up the member, so its across axis runs opposite the top view.
      u: face(-half, flange, flange, 0, true),
      v: face(-half + flange, depth),
      o: face(-half + flange + depth, flange),
    }
    if (options.flipFlanges) {
      const u = faces.u
      faces.u = faces.o
      faces.o = u
    }
    return { seam, origin: 'centered', faces }
  }

  if (type === 'I') {
    const depth = first
    const flange = second
    const web = tw ?? 0
    const radius = r ?? 0
    const gap = (flange - web) / 2 - radius * CORNER_FACTOR
    const seam = 2 * flange + depth + 2 * gap
    const half = seam / 2
    const faces: UnrolledLayout['faces'] = {
      o: face(-half, flange),
      v: face(-half + flange + gap, depth),
      // The bottom view (`u`) looks up the member, so its across axis runs opposite the top view.
      u: face(half - flange, flange, flange, 0, true),
    }
    if (options.flipFlanges) {
      const u = faces.u
      faces.u = faces.o
      faces.o = u
    }
    return { seam, origin: 'centered', faces }
  }

  if (type === 'L') {
    // An angle is a section of a prism, not a closed tube: the cuttable surface is the two outer
    // leg faces, developed as one continuous strip around the sharp outer corner. The NC authors
    // each face's across coordinate from that corner (`y = 0` at the corner, `y = leg` at the toe)
    // — a1's mitre confirms it (the `u` and `v` start arcs meet at along 0 only when both read
    // `y = 0` at the corner). Per the first real articles, `v` spans the **horizontal** leg
    // (`dims[0]`) and `u` the **vertical** leg (`dims[1]`, the bottom view, so reversed). `u` sits
    // on the negative side and `v` on the positive, sharing the corner station.
    const horizontal = first
    const vertical = second
    const seam = horizontal + vertical
    const half = seam / 2
    return {
      seam,
      origin: 'centered',
      faces: {
        u: face(-half, vertical, vertical, 0, true),
        v: face(-half + vertical, horizontal, horizontal),
      },
    }
  }

  if (type === 'M') {
    const short = Math.min(first, second)
    const long = Math.max(first, second)
    const radius = r ?? 0
    // Developed face = flat + one corner arc.
    const developedLong = long - radius * CORNER_FACTOR
    const developedShort = short - radius * CORNER_FACTOR
    const seam = 2 * (developedLong + developedShort)
    return {
      seam,
      origin: 'zero',
      faces: {
        // Tekla authors the tube long-side vertical: v/h are the long faces, o/u the short.
        v: face(-developedLong / 2, developedLong, long, radius),
        o: face(developedLong / 2, developedShort, short, radius, true),
        h: face(developedLong / 2 + developedShort, developedLong, long, radius, true),
        u: face(developedLong / 2 + developedShort + developedLong, developedShort, short, radius),
      },
    }
  }

  return null
}

/** Stations are wrapped into WiseCAM's `0 … seam` for zero-origin layouts. */
export function wrapStation(station: number, layout: UnrolledLayout): number {
  if (layout.origin === 'centered') return station
  const seam = layout.seam
  return ((station % seam) + seam) % seam
}

/**
 * The unrolled station **before** wrapping. Zero-origin layouts (`M`) put the `v` face across
 * the seam (`start < 0`); callers that assemble a boundary crossing the seam need this raw value.
 */
export function rawStationFor(layout: UnrolledLayout, faceName: NcFace, y: number): number | null {
  const region = layout.faces[faceName]
  if (!region) return null
  const local = localCoordinate(region, y)
  const oriented = region.reversed ? region.length - local : local
  return region.start + oriented
}

/**
 * The unrolled station for an NC point on `face` at across-coordinate `y`, or null when the
 * family/layout has no region for that face.
 */
export function stationFor(layout: UnrolledLayout, faceName: NcFace, y: number): number | null {
  const raw = rawStationFor(layout, faceName, y)
  return raw == null ? null : wrapStation(raw, layout)
}

/**
 * Midpoint of the layout's raw station span. Centred layouts (`I`/`U`) are already around 0;
 * a zero-origin tube (`M`) starts at the `v` face edge, so its raw span is shifted. Subtracting
 * this makes one canonical UV origin for every family: the seam is at `±seam/2`.
 */
export function layoutCenter(layout: UnrolledLayout): number {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const region of Object.values(layout.faces)) {
    if (!region) continue
    min = Math.min(min, region.start)
    max = Math.max(max, region.start + region.length)
  }
  return Number.isFinite(min) && Number.isFinite(max) ? (min + max) / 2 : 0
}

/** Raw station mapped to the canonical centred UV origin (seam at `±seam/2`). */
export function centeredStationFor(
  layout: UnrolledLayout,
  faceName: NcFace,
  y: number,
): number | null {
  const raw = rawStationFor(layout, faceName, y)
  if (raw == null) return null
  return raw - layoutCenter(layout)
}

/** A DSTV face + authored across coordinate recovered from a centred chart station. */
export interface FaceStation {
  face: NcFace
  y: number
}

/**
 * Inverse of {@link centeredStationFor}: recover the face and authored across coordinate for a
 * chart point. Each face region is monotonic in `y`, so a short binary search is exact enough for
 * export. Returns null when the station falls in a non-developed gap.
 */
export function centeredStationRange(
  layout: UnrolledLayout,
  faceName: NcFace,
): [number, number] | null {
  const region = layout.faces[faceName]
  if (!region) return null
  const width = region.width ?? region.length
  const start = centeredStationFor(layout, faceName, 0)
  const end = centeredStationFor(layout, faceName, width)
  if (start == null || end == null) return null
  return [Math.min(start, end), Math.max(start, end)]
}

export function acrossAtCenteredStation(
  layout: UnrolledLayout,
  faceName: NcFace,
  station: number,
  clamp = true,
): number | null {
  const region = layout.faces[faceName]
  if (!region) return null
  const width = region.width ?? region.length
  const range = centeredStationRange(layout, faceName)
  if (!range) return null
  const [min, max] = range
  if (!clamp && (station < min - 0.01 || station > max + 0.01)) return null
  const start = centeredStationFor(layout, faceName, 0)
  const end = centeredStationFor(layout, faceName, width)
  if (start == null || end == null) return null
  // A cut may overrun the nominal face at a mitre/corner. The developed mapping is still defined
  // just outside `0…width`, so search a margin and return the real across value instead of
  // clamping (which would move the cut line).
  const margin = Math.max(2, width * 0.25)
  let lo = -margin
  let hi = width + margin
  const ascending = end >= start
  for (let step = 0; step < 48; step++) {
    const mid = (lo + hi) / 2
    const value = centeredStationFor(layout, faceName, mid)
    if (value == null) break
    if ((ascending && value < station) || (!ascending && value > station)) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export function faceAtCenteredStation(layout: UnrolledLayout, station: number): FaceStation | null {
  for (const face of ['v', 'o', 'u', 'h'] as NcFace[]) {
    const y = acrossAtCenteredStation(layout, face, station, false)
    if (y != null) return { face, y }
  }
  return null
}

/**
 * Face coordinate → centred station, applying the true corner-arc correction when `y` overruns
 * the authored face width. This is the forward mapping used by STEP extraction.
 */
export function surfaceStationFor(
  layout: UnrolledLayout,
  faceName: NcFace,
  y: number,
): number | null {
  const region = layout.faces[faceName]
  if (!region) return null
  const width = region.width ?? region.length
  const radius = region.radius ?? 0
  if (radius <= 0 || (y >= 0 && y <= width)) return centeredStationFor(layout, faceName, y)
  const boundaryY = y < 0 ? 0 : width
  const boundaryStation = centeredStationFor(layout, faceName, boundaryY)
  if (boundaryStation == null) return null
  const overrun = Math.abs(y - boundaryY)
  const theta = Math.asin(Math.min(1, overrun / radius))
  const direction = (y > width ? 1 : -1) * (region.reversed ? -1 : 1)
  return boundaryStation + direction * radius * theta
}

/** Inverse of {@link surfaceStationFor} for a specific face. */
export function acrossAtSurfaceStation(
  layout: UnrolledLayout,
  faceName: NcFace,
  station: number,
): number | null {
  const region = layout.faces[faceName]
  if (!region) return null
  const width = region.width ?? region.length
  const radius = region.radius ?? 0
  const margin = radius > 0 ? radius : Math.max(2, width * 0.25)
  let lo = -margin
  let hi = width + margin
  const start = surfaceStationFor(layout, faceName, lo)
  const end = surfaceStationFor(layout, faceName, hi)
  if (start == null || end == null) return null
  const min = Math.min(start, end)
  const max = Math.max(start, end)
  if (station < min - 0.01 || station > max + 0.01) return null
  const ascending = end >= start
  for (let step = 0; step < 48; step++) {
    const mid = (lo + hi) / 2
    const value = surfaceStationFor(layout, faceName, mid)
    if (value == null) break
    if ((ascending && value < station) || (!ascending && value > station)) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Inverse of {@link surfaceStationFor}: recover the DSTV face + authored across coordinate. */
export function faceAtSurfaceStation(layout: UnrolledLayout, station: number): FaceStation | null {
  for (const face of ['v', 'o', 'u', 'h'] as NcFace[]) {
    const y = acrossAtSurfaceStation(layout, face, station)
    if (y != null) return { face, y }
  }
  return null
}
