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
      u: face(-half, flange),
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
      u: face(half - flange, flange),
    }
    if (options.flipFlanges) {
      const u = faces.u
      faces.u = faces.o
      faces.o = u
    }
    return { seam, origin: 'centered', faces }
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
        o: face(developedLong / 2, developedShort, short, radius),
        h: face(developedLong / 2 + developedShort, developedLong, long, radius),
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
