import type { NcGeometry } from '@/lib/parsers/ncGeometry'
import type { SabreFailure } from './sabre'

/**
 * Maps light-sabre failures (STEP native coordinates) onto the NC's length axis, so the NC
 * visualisation can show *which* cut line is responsible.
 *
 * The mapping is deliberately rotation-invariant: only the position along the member's long
 * axis is transferred (normalised 0–1 on the STEP side, scaled to the NC length). Faces are
 * *not* mapped — the STEP and NC cross-section frames share no guaranteed roll convention,
 * so claiming a face would risk flagging the wrong line. The NC view instead highlights every
 * outer-contour segment near the guilty station; the manufactured 3D view shows the exact face.
 *
 * End flip: the STEP's long-axis sign may run opposite the NC's X. When the STEP failures
 * cluster at one end *and* the NC shows exactly one ragged end (faces ending at different X —
 * the signature of a slanted cut), the flip is resolved so the station lands on the ragged
 * end. Otherwise the exports are assumed to run the same direction.
 */

export interface SabreStation {
  /** guilty cut position in NC X coordinates (mm along the member) */
  x: number
  /** half-width (mm) of the highlight window around `x` */
  window: number
  /** failures clustered at this station */
  count: number
}

/** Normalised clustering tolerance along the member (plus an absolute floor in `locate`). */
const CLUSTER_GAP_FRACTION = 0.005
const CLUSTER_GAP_FLOOR_MM = 5
/** An NC end counts as ragged (slanted cut) past this face-extent spread. */
const RAGGED_THRESHOLD_MM = 2
/**
 * Weld-prep angle fields are `[angleA, distA, angleB, distB]` per contour vertex. Angles below
 * this (degrees) never survive rounding to a whole-degree label, so they don't count.
 */
const BEVEL_ANGLE_MIN_DEG = 0.5
const WINDOW_MARGIN_MM = 12
const WINDOW_MIN_MM = 10
const WINDOW_MAX_MM = 40

function longAxisOf(vertices: number[]): { axis: number; min: number; max: number } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (vertices[i + a] < min[a]) min[a] = vertices[i + a]
      if (vertices[i + a] > max[a]) max[a] = vertices[i + a]
    }
  }
  const extents = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const axis = extents.indexOf(Math.max(...extents))
  return { axis, min: min[axis], max: max[axis] }
}

function ncLengthOf(nc: NcGeometry): number {
  let length = 0
  for (const contour of nc.contours) {
    for (const [x] of contour.points) length = Math.max(length, x)
  }
  for (const hole of nc.holes) length = Math.max(length, hole.x + hole.diameter / 2)
  return length
}

/** Per-face outer-contour X extents, for ragged-end (slanted cut) detection. */
function outerExtents(nc: NcGeometry): { min: number; max: number }[] {
  const out: { min: number; max: number }[] = []
  for (const contour of nc.contours) {
    if (contour.kind !== 'outer') continue
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const [x] of contour.points) {
      if (x < min) min = x
      if (x > max) max = x
    }
    if (min <= max) out.push({ min, max })
  }
  return out
}

export function locateSabreStations(
  stepVertices: number[],
  failures: SabreFailure[],
  nc: NcGeometry,
): SabreStation[] {
  if (failures.length === 0 || stepVertices.length < 9) return []
  const { axis, min, max } = longAxisOf(stepVertices)
  const span = max - min
  if (!(span > 0)) return []
  const ncLength = ncLengthOf(nc)
  if (!(ncLength > 0)) return []

  const positions = failures
    .map((failure) => (failure.point[axis] - min) / span)
    .sort((a, b) => a - b)
  const gap = Math.max(CLUSTER_GAP_FLOOR_MM / span, CLUSTER_GAP_FRACTION)
  const clusters: { sum: number; count: number; lo: number; hi: number }[] = []
  for (const s of positions) {
    const current = clusters[clusters.length - 1]
    if (current && s - current.hi <= gap) {
      current.sum += s
      current.count += 1
      current.hi = s
    } else {
      clusters.push({ sum: s, count: 1, lo: s, hi: s })
    }
  }

  // Resolve a possible end flip: a single guilty STEP end should land on the NC's ragged end.
  const total = failures.length
  const weightedMean = positions.reduce((sum, s) => sum + s, 0) / total
  const stepEnd = weightedMean > 0.66 ? 'max' : weightedMean < 0.34 ? 'min' : null
  let flip = false
  if (stepEnd) {
    const extents = outerExtents(nc)
    if (extents.length >= 2) {
      const raggedStart =
        Math.max(...extents.map((e) => e.min)) - Math.min(...extents.map((e) => e.min))
      const raggedEnd =
        Math.max(...extents.map((e) => e.max)) - Math.min(...extents.map((e) => e.max))
      const ncRagged =
        raggedStart > raggedEnd + RAGGED_THRESHOLD_MM
          ? 'min'
          : raggedEnd > raggedStart + RAGGED_THRESHOLD_MM
            ? 'max'
            : null
      if (ncRagged && ncRagged !== stepEnd) flip = true
    }
  }

  return clusters
    .map((cluster) => {
      const mean = cluster.sum / cluster.count
      const s = flip ? 1 - mean : mean
      const spreadMm = (cluster.hi - cluster.lo) * ncLength
      return {
        x: s * ncLength,
        window: Math.min(WINDOW_MAX_MM, Math.max(WINDOW_MIN_MM, spreadMm / 2 + WINDOW_MARGIN_MM)),
        count: cluster.count,
      }
    })
    .sort((a, b) => a.x - b.x)
}

/**
 * The bevel angle the NC *specifies* at the guilty cut: the largest weld-prep angle on any
 * outer-contour vertex inside a guilty station window, in whole degrees. A bevel is a side
 * cut line with an angle — not the face normal — so it is read from the cut data, never
 * derived from the 3D surface. Null when the NC specifies no bevel there (a STEP-only
 * shave the NC cannot express).
 */
export function specifiedBevelAngle(nc: NcGeometry, stations: SabreStation[]): number | null {
  let best = 0
  for (const contour of nc.contours) {
    if (contour.kind !== 'outer') continue
    for (let i = 0; i < contour.points.length; i++) {
      const [x] = contour.points[i]
      const near = stations.some(
        (station) => x > station.x - station.window && x < station.x + station.window,
      )
      if (!near) continue
      const bevel = contour.bevels[i] ?? []
      for (const angle of [bevel[0], bevel[2]]) {
        if (Number.isFinite(angle) && Math.abs(angle) >= BEVEL_ANGLE_MIN_DEG) {
          best = Math.max(best, Math.abs(angle))
        }
      }
    }
  }
  return best > 0 ? Math.round(best) : null
}
