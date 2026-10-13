import { MACHINE } from '@/lib/machine/profile'
import { type NcContour, type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import type { CutMarker } from './cutReach'

/**
 * Bevel-change check.
 *
 * On the bevel head the tilt is set per cut. A **single cut line on one face** must carry **one**
 * bevel: if the bevel angle changes while the head traverses that line — a weld prep that swings
 * through a taper, or a sign (direction) flip — the head has to rotate the nozzle while it is still
 * in the kerf and grinds the nozzle down.
 *
 * A cut line is found geometrically, not from the bevel data: the face contour is split into chains
 * between the **raw-stock edges** (segments lying along the member on the face boundary — the
 * section's silhouette, not a cut). Each chain is a cut that runs edge to edge across the face; it
 * carries every bevel the head applies over that traverse, including a square (0°) portion, which
 * is why the marker spans the whole chain. A chain whose bevel angles are not all the same within
 * {@link BEVEL_SAME_DEG} is flagged. The finding carries the distinct angles and an auto-suggested
 * one (the angle used by the most vertices), so the operator can either unify the line to that
 * angle or drop the bevel. Values outside the head's bevel range are not weld prep (Tekla writes
 * e.g. `-64.2` there) and are ignored.
 */

/** Angles within this many degrees are treated as the same bevel (absorbs CAD rounding). */
export const BEVEL_SAME_DEG = 2

/** The head's bevel range, from the machine profile; values outside it are not weld-prep. */
const MAX_BEVEL_DEG = Math.max(Math.abs(MACHINE.bevel.minDeg), Math.abs(MACHINE.bevel.maxDeg))

export interface BevelChangeIssue extends CutMarker {
  code: 'CUT_BEVEL_CHANGE'
  /** A changed bevel mid-cut rotates the nozzle into the work — unmanufacturable, so an error. */
  severity: 'error'
  message: string
  /** Index of the contour in `parseNcGeometry(...).contours`, so the NC can be edited in place. */
  contourIndex: number
  /** Contour vertex indices (`points`/`bevels` order) that make up this cut line, for the edit. */
  vertices: number[]
  params: {
    face: NcFace
    /** Location along the member (NC X, mm) at the middle of the cut line. */
    x: number
    /** Length of the cut line along the face (mm). */
    span: number
    /** Distinct bevel angles on the line, e.g. `-20.1°, -12.6°`. */
    angles: string
    /** Auto-suggested single bevel to unify the line to (deg). */
    suggested: string
  }
}

/**
 * Signed bevel angle (deg) at a contour vertex — the larger-magnitude welding-prep *angle* that is
 * within the head's ±45° range. `0` means no bevel (a plain/square cut).
 */
function bevelAngleAt(contour: NcContour, index: number): number {
  const values = contour.bevels[index] ?? []
  let best = 0
  for (const angle of [values[0], values[2]]) {
    if (Number.isFinite(angle) && Math.abs(angle as number) <= MAX_BEVEL_DEG) {
      if (Math.abs(angle as number) > Math.abs(best)) best = angle as number
    }
  }
  return best
}

interface LineVertex {
  angle: number
  x: number
  y: number
  /** Index of this vertex in the contour's `points`/`bevels` arrays. */
  index: number
  /** Length along the cut line attributed to this vertex (mm). */
  weight: number
}

/**
 * The **cut lines** on a face's outer contour: maximal chains of consecutive edges between the
 * raw-stock edges (an edge lying along the member on the face's own boundary — its Y at the
 * section extreme). The contour is walked cyclically and its repeated closing point dropped, so
 * each chain is one cut running edge to edge across the face.
 */
function cutLines(contour: NcContour): LineVertex[][] {
  const points = contour.points
  let n = points.length
  const first = points[0]
  const last = points[n - 1]
  if (
    n > 1 &&
    first &&
    last &&
    Math.abs(first[0] - last[0]) < 1e-6 &&
    Math.abs(first[1] - last[1]) < 1e-6
  ) {
    n -= 1
  }
  if (n < 2) return []

  const ys = Array.from({ length: n }, (_, i) => points[i]?.[1] ?? 0)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  // A raw-stock edge runs along the member and sits on the face boundary (Y at the extreme).
  const stock = Array.from({ length: n }, (_, i) => {
    const a = points[i] ?? [0, 0]
    const b = points[(i + 1) % n] ?? [0, 0]
    const along = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])
    const atMin = Math.abs(a[1] - minY) < 0.5 && Math.abs(b[1] - minY) < 0.5
    const atMax = Math.abs(a[1] - maxY) < 0.5 && Math.abs(b[1] - maxY) < 0.5
    return along && (atMin || atMax)
  })

  const vertexAt = (i: number): LineVertex => {
    const point = points[i] ?? [0, 0]
    return { angle: bevelAngleAt(contour, i), x: point[0], y: point[1], index: i, weight: 0 }
  }

  const chains: LineVertex[][] = []
  if (stock.every((s) => !s)) {
    // No boundary edge anywhere — the whole contour is the one cut.
    chains.push(Array.from({ length: n }, (_, i) => vertexAt(i)))
  } else {
    const start = (stock.indexOf(true) + 1) % n
    let current: LineVertex[] = []
    for (let k = 0; k < n; k++) {
      const v = (start + k) % n
      current.push(vertexAt(v))
      if (stock[v]) {
        if (current.length >= 2) chains.push(current)
        current = []
      }
    }
    if (current.length >= 2) chains.push(current)
  }

  // Attribute each vertex the length of the edge it starts (endpoints fall back to their one edge).
  for (const line of chains) {
    for (let i = 0; i < line.length; i++) {
      const a = line[i] as LineVertex
      const b = (line[i + 1] ?? line[i - 1] ?? a) as LineVertex
      a.weight = Math.hypot(a.x - b.x, a.y - b.y)
    }
  }
  return chains
}

interface AngleCluster {
  /** Lowest angle in the cluster (its reference — members are within `BEVEL_SAME_DEG` of it). */
  base: number
  mean: number
  /** Number of vertices in the cluster (for the running mean). */
  count: number
  weight: number
}

/** Groups a line's signed bevel angles so each cluster spans at most {@link BEVEL_SAME_DEG}. */
function clusterAngles(line: LineVertex[]): AngleCluster[] {
  const sorted = [...line].sort((a, b) => a.angle - b.angle)
  const clusters: AngleCluster[] = []
  for (const vertex of sorted) {
    const last = clusters[clusters.length - 1]
    if (last && vertex.angle - last.base <= BEVEL_SAME_DEG) {
      last.mean = (last.mean * last.count + vertex.angle) / (last.count + 1)
      last.count += 1
      last.weight += vertex.weight
    } else {
      clusters.push({ base: vertex.angle, mean: vertex.angle, count: 1, weight: vertex.weight })
    }
  }
  return clusters
}

/** Runs the bevel-change check over every outer face contour in an NC file. */
export function assessBevelChange(ncText: string): BevelChangeIssue[] {
  const { contours } = parseNcGeometry(ncText)
  const issues: BevelChangeIssue[] = []

  for (let contourIndex = 0; contourIndex < contours.length; contourIndex++) {
    const contour = contours[contourIndex]
    if (contour?.kind !== 'outer') continue
    for (const line of cutLines(contour)) {
      const bevels = line.filter((vertex) => vertex.angle !== 0)
      if (bevels.length === 0) continue
      const clusters = clusterAngles(bevels)
      if (clusters.length <= 1) continue

      // Suggested single bevel: the angle used by the most vertices, ties going to the deepest —
      // the operator can then unify the line to it or drop the bevel entirely.
      const suggested = [...clusters].sort(
        (a, b) => b.count - a.count || Math.abs(b.mean) - Math.abs(a.mean),
      )[0] as AngleCluster
      const ordered = [...clusters].sort((a, b) => a.mean - b.mean)
      const angles = ordered
        .slice(0, 5)
        .map((cluster) => `${cluster.mean.toFixed(1)}°`)
        .join(', ')
      const extra = ordered.length > 5 ? `, +${ordered.length - 5}` : ''
      const xs = line.map((vertex) => vertex.x)
      const x = (Math.min(...xs) + Math.max(...xs)) / 2
      const span = line.reduce((sum, vertex) => sum + vertex.weight, 0)
      const start = line[0] as LineVertex
      const end = line[line.length - 1] as LineVertex
      // The marker is the whole cut line, edge to edge: every bevel on the run is part of the
      // error, so the operator sees the full line they must unify or strip.
      const lines = [line.map((vertex) => [vertex.x, vertex.y] as [number, number])]
      const first = lines[0]?.[0] ?? [start.x, start.y]
      const last = lines[lines.length - 1]?.at(-1) ?? [end.x, end.y]

      issues.push({
        code: 'CUT_BEVEL_CHANGE',
        severity: 'error',
        face: contour.face,
        from: [first[0], first[1]],
        to: [last[0], last[1]],
        lines,
        contourIndex,
        vertices: line.map((vertex) => vertex.index),
        message: `Bevel changes along one cut on face ${contour.face}: ${angles}${extra} — the head must rotate the nozzle mid-cut and grinds it down. Keep one bevel (${suggested.mean.toFixed(1)}°) or remove it`,
        params: {
          face: contour.face,
          x: Math.round(x),
          span: Math.round(span),
          angles: `${angles}${extra}`,
          suggested: suggested.mean.toFixed(1),
        },
      })
    }
  }

  return issues
}
