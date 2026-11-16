import { MACHINE } from '@/lib/machine/profile'
import {
  type NcContour,
  type NcFace,
  type NcGeometry,
  parseNcGeometry,
} from '@/lib/parsers/ncGeometry'
import { profileFamily } from '@/lib/sections/canonical'
import type { CutMarker } from './cutReach'

/**
 * Root-fillet longitudinal cut check.
 *
 * A cut line that runs **along the member** on the rolled web/flange root of an I-section (UB /
 * WB / UC / WC / TFB) sits on the concave fillet. The fillet is thicker than the flat plate and
 * curves away, so the beam cannot cut through cleanly there — the remaining material can foul the
 * head and damage the nozzle / lens. `cutReach` deliberately skips lengthwise edges (they are
 * normally the stock silhouette), so this is a separate check.
 *
 * Detection is pure 2D: for each face, the fillet is a known band in the face's across (NC Y)
 * coordinate. A **longitudinal** cut edge whose across coordinate lies strictly inside that band
 * is flagged. The stock edge exactly on the flat/fillet tangent is excluded, so the normal web
 * outline is not a finding.
 *
 * Each finding carries the NC Y shift that clears the fillet, so the operator can apply the edit
 * in one click (see `moveCutInNc`). Moving a cut line here is a deliberate manufacturing fix, not
 * the "never nudge a cut to make a probe hit" rule in `docs/cut-depth-architecture.md`.
 */

/** A longitudinal edge shorter than this is not the "long cut line" this check targets. */
export const MIN_LONGITUDINAL_MM = 10

/** Keep this far (mm) from the tangent so the cut lands on the flat, not on the curve. */
const FILLET_CLEAR_MM = MACHINE.placementToleranceMm + 1

/** A cut must be at least this far (mm) inside the band to be "on" the fillet, not the stock edge. */
const FILLET_EDGE_EPS_MM = 0.5

/** Accepted as "along the member": the across coordinate changes by at most this much (mm). */
const LONGITUDINAL_Y_TOL_MM = 1

/** Amber is for warnings; this is a machine-damage risk, so the marker stays the error red. */
export const ROOT_FILLET_COLOR = 0xef4444

/** One curved root-fillet band, in the face's NC across coordinate. */
export interface RootFilletBand {
  /** Lower bound of the curved band (NC Y, mm). */
  lo: number
  /** Upper bound of the curved band (NC Y, mm). */
  hi: number
  /** NC Y of the nearest flat material beyond the band. */
  target: number
  /** Which way that flat is from the fillet. */
  direction: 'inward' | 'outward'
}

export interface RootFilletIssue extends CutMarker {
  code: 'CUT_ROOT_FILLET'
  severity: 'error'
  message: string
  params: {
    face: NcFace
    /** Location along the member (NC X, mm) at the middle of the flagged run. */
    x: number
    /** Cut length along the member (mm). */
    span: number
    /** Distance the cut must move (mm). */
    move: number
    direction: 'inward' | 'outward'
    /** Signed NC-Y offset that clears the fillet (the value the fix prefills). */
    delta: number
  }
  /** Index of the owning contour in `NcGeometry.contours` (for the NC edit). */
  contourIndex: number
  /** Contour vertex indices whose across (Y) coordinate should move by `delta`. */
  vertices: number[]
  /** Signed NC-face Y shift (mm) that clears the fillet. */
  delta: number
}

export interface RootFilletOptions {
  /** The stock cross-section outline (canonical stance). */
  section: [number, number][]
  /**
   * NC header cross-section dims `[d, b, tf, tw, r]`. Required for the fillet geometry; without
   * them the check is skipped rather than guessed.
   */
  dimensions?: number[]
  /** DSTV/Tekla profile code, so the face frame matches the authored stance. */
  profile?: string
}

/**
 * The curved root-fillet bands of an I-section face, in the face's NC across coordinate.
 *
 * For the web faces (`v`/`h`) the flat web spans `[tf + r, d − tf − r]` and the two fillets sit
 * between that and each flange inner face. For the flange faces (`o`/`u`) the flat is the whole
 * flange width and each fillet sits around the central web.
 */
export function rootFilletBands(face: NcFace, dimensions: number[]): RootFilletBand[] {
  const d = dimensions[0]
  const b = dimensions[1]
  const tf = dimensions[2]
  const tw = dimensions[3]
  const r = dimensions[4]
  if (
    [d, b, tf, tw, r].some((value) => typeof value !== 'number' || !Number.isFinite(value)) ||
    !(d > 0 && b > 0 && tf > 0 && tw > 0 && r > 0)
  ) {
    return []
  }

  if (face === 'v' || face === 'h') {
    const lower: RootFilletBand = {
      lo: tf,
      hi: tf + r,
      target: tf + r + FILLET_CLEAR_MM,
      direction: 'inward',
    }
    const upper: RootFilletBand = {
      lo: d - tf - r,
      hi: d - tf,
      target: d - tf - r - FILLET_CLEAR_MM,
      direction: 'inward',
    }
    return [lower, upper].filter((band) => band.target > tf + r && band.target < d - tf - r)
  }

  const lower: RootFilletBand = {
    lo: b / 2 - tw / 2 - r,
    hi: b / 2 - tw / 2,
    target: b / 2 - tw / 2 - r - FILLET_CLEAR_MM,
    direction: 'outward',
  }
  const upper: RootFilletBand = {
    lo: b / 2 + tw / 2,
    hi: b / 2 + tw / 2 + r,
    target: b / 2 + tw / 2 + r + FILLET_CLEAR_MM,
    direction: 'outward',
  }
  return [lower, upper].filter((band) => band.target > 0 && band.target < b)
}

function isClosed(points: [number, number][]): boolean {
  if (points.length < 2) return false
  const a = points[0] as [number, number]
  const b = points[points.length - 1] as [number, number]
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6
}

interface FlaggedEdge {
  /** Edge index (vertex i → i + 1). */
  index: number
  band: RootFilletBand
}

/** All longitudinal edges of one contour that lie strictly inside a root-fillet band. */
function flaggedEdges(contour: NcContour, bands: RootFilletBand[]): FlaggedEdge[] {
  if (bands.length === 0) return []
  const points = contour.points
  const edgeCount = points.length - 1
  const out: FlaggedEdge[] = []
  for (let i = 0; i < edgeCount; i++) {
    const a = points[i] as [number, number]
    const b = points[(i + 1) % points.length] as [number, number]
    const dx = Math.abs(b[0] - a[0])
    const dy = Math.abs(b[1] - a[1])
    if (dx < MIN_LONGITUDINAL_MM || dy > LONGITUDINAL_Y_TOL_MM || dx < dy) continue
    const lo = Math.min(a[1], b[1])
    const hi = Math.max(a[1], b[1])
    const band = bands.find(
      (candidate) =>
        lo > candidate.lo + FILLET_EDGE_EPS_MM && hi < candidate.hi - FILLET_EDGE_EPS_MM,
    )
    if (band) out.push({ index: i, band })
  }
  return out
}

interface Run {
  vertices: number[]
  polyline: [number, number][]
  span: number
  x: number
  avgY: number
  band: RootFilletBand
}

/** Groups adjacent flagged edges (across the seam for a closed contour) into contiguous runs. */
function flaggedRuns(contour: NcContour, bands: RootFilletBand[]): Run[] {
  const flagged = flaggedEdges(contour, bands)
  if (flagged.length === 0) return []
  const points = contour.points
  const n = points.length
  const closed = isClosed(points)
  const edgeCount = n - 1
  const byIndex = new Map(flagged.map((edge) => [edge.index, edge]))

  // Start just after a clean edge so no run straddles the contour seam.
  const firstClean = Array.from({ length: edgeCount }, (_, index) => index).find(
    (index) => !byIndex.has(index),
  )
  const start = closed && firstClean != null ? (firstClean + 1) % edgeCount : 0
  const runs: Run[] = []
  let current: FlaggedEdge[] = []

  const flush = () => {
    if (current.length === 0) return
    const band = (current[0] as FlaggedEdge).band
    const edgeIndices: number[] = []
    for (const edge of current) edgeIndices.push(edge.index)
    const firstEdge = edgeIndices[0] as number
    const raw: number[] = [firstEdge % n]
    for (let k = 0; k < edgeIndices.length; k++) raw.push((edgeIndices[k] as number) + 1)
    const vertices: number[] = []
    const uniqueCount = closed ? n - 1 : n
    for (const index of raw) {
      const value = index % uniqueCount
      if (value < 0) continue
      if (vertices[vertices.length - 1] !== value) vertices.push(value)
    }
    const polyline = vertices.map((index) => points[index] as [number, number])
    if (polyline.length < 2) {
      current = []
      return
    }
    let span = 0
    let x = 0
    let y = 0
    for (let k = 0; k < polyline.length - 1; k++) {
      const a = polyline[k] as [number, number]
      const b = polyline[k + 1] as [number, number]
      span += Math.hypot(b[0] - a[0], b[1] - a[1])
      x += (a[0] + b[0]) / 2
    }
    for (const edge of current) {
      const a = points[edge.index % n] as [number, number]
      const b = points[(edge.index + 1) % n] as [number, number]
      y += (a[1] + b[1]) / 2
    }
    runs.push({
      vertices,
      polyline,
      span,
      x: x / Math.max(1, current.length),
      avgY: y / Math.max(1, current.length),
      band,
    })
    current = []
  }

  for (let k = 0; k < edgeCount; k++) {
    const index = (start + k) % edgeCount
    const edge = byIndex.get(index)
    if (
      edge &&
      (current.length === 0 || (current[current.length - 1] as FlaggedEdge).band === edge.band)
    ) {
      current.push(edge)
    } else {
      flush()
      if (edge) current.push(edge)
    }
  }
  flush()
  return runs
}

/** Runs the root-fillet check over every contour in an NC file. */
export function assessRootFillet(ncText: string, options: RootFilletOptions): RootFilletIssue[] {
  return assessRootFilletGeometry(parseNcGeometry(ncText), options)
}

/** As {@link assessRootFillet} but on already-parsed NC geometry. */
export function assessRootFilletGeometry(
  nc: NcGeometry,
  options: RootFilletOptions,
): RootFilletIssue[] {
  const { section } = options
  if (section.length < 3) return []
  const family = options.profile ? profileFamily(options.profile) : null
  // The rolled web/flange fillet is an I-section feature. A T's root is cut with the bevel head,
  // a channel's fillet is inside the mouth, and a hollow has a corner radius (the `corner` check).
  if (family !== 'i') return []
  const dims = options.dimensions ?? []

  const issues: RootFilletIssue[] = []
  nc.contours.forEach((contour, contourIndex) => {
    const bands = rootFilletBands(contour.face, dims)
    for (const run of flaggedRuns(contour, bands)) {
      const delta = run.band.target - run.avgY
      const move = Math.abs(delta)
      if (move < 0.5) continue
      const from = run.polyline[0] as [number, number]
      const to = run.polyline[run.polyline.length - 1] as [number, number]
      const span = Math.round(run.span)
      const moveText = move.toFixed(1)
      issues.push({
        code: 'CUT_ROOT_FILLET',
        severity: 'error',
        face: contour.face,
        from: [from[0], from[1]],
        to: [to[0], to[1]],
        lines: [run.polyline.map((point) => [point[0], point[1]] as [number, number])],
        color: ROOT_FILLET_COLOR,
        message: `Long cut on face ${contour.face} (${span} mm) runs along the root fillet — it cannot cut through the curved, thicker junction and can damage the nozzle/lens. Move it ${moveText} mm ${run.band.direction} onto the flat.`,
        params: {
          face: contour.face,
          x: Math.round(run.x),
          span,
          move: Number(moveText),
          direction: run.band.direction,
          delta: Number(delta.toFixed(2)),
        },
        contourIndex,
        vertices: run.vertices,
        delta: Number(delta.toFixed(2)),
      })
    }
  })
  return issues
}
