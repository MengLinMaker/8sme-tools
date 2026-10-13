import { faceSpanAxis, resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import {
  type NcContour,
  type NcFace,
  type NcGeometry,
  parseNcGeometry,
} from '@/lib/parsers/ncGeometry'
import type { CutMarker } from './cutReach'

/**
 * Unclosed / non-edge-to-edge cut check.
 *
 * A normal face profile is a **closed** loop of cuts and raw-stock edges: every cut runs **edge to
 * edge** across the face (an end cut, mitre, cope or notch), bounded by the stock's own silhouette
 * edges. A cut that does **not** — an open polyline that doesn't close, a loop that floats inside
 * the face never reaching the section boundary, or a suspiciously short stray segment — is almost
 * always a Tekla export artifact rather than a real cut, and the operator wants it gone before it
 * reaches the machine.
 *
 * Detection works from the NC (plus the section, so the face boundary is the *real* one):
 *
 *   - a non-closed outer contour (a broken/partial cut)                                          → `open`
 *   - a closed outer contour with no raw-stock edge (floats inside the face)                      → `floating`
 *   - an edge-to-edge run shorter than {@link TINY_CUT_MM} (a random little slit)                 → `tiny`
 *   - an inner cut-out (IK) that is tiny or triangular (a stray/odd opening)                      → `cutout`
 *
 * The last is the reported failure mode: a small triangular wedge cut into a face (often near a
 * drilled hole) is a Tekla modelling artifact, and WiseCAM can misread it as a tiny stray line.
 * A normal rectangular/rounded inner opening stays unflagged.
 *
 * Findings are warnings: a stray cut is worth a look, not a hard stop. Each carries an amber
 * {@link CutMarker} so the viewer can highlight it, plus the `contourIndex`/run needed to remove it.
 */

/** A cut run shorter than this (mm) is treated as a "little cut" even when it spans edge to edge. */
export const TINY_CUT_MM = 5

/**
 * An inner cut-out (IK) smaller than this area (mm²) is treated as a stray/odd opening. A triangular
 * opening is always flagged regardless of size — real cut-outs are rectangular/rounded/slotted.
 */
export const SMALL_CUTOUT_MM2 = 1000

/** How close (mm) a vertex must sit to the face edge to count as "on the boundary". */
const EDGE_TOL_MM = 0.5

/** Amber warning tone (matches the warnings table). */
const UNCLOSED_COLOR = 0xf59e0b

/** Why a cut was flagged. */
export type UnclosedReason = 'open' | 'floating' | 'tiny' | 'cutout'

export interface UnclosedCutIssue extends CutMarker {
  code: 'CUT_UNCLOSED' | 'CUT_CUTOUT'
  severity: 'warning'
  message: string
  params: {
    face: NcFace
    /** Location along the member (NC X, mm) at the middle of the flagged cut. */
    x: number
    /** Cut length along the face (mm). */
    span: number
    reason: UnclosedReason
  }
  /** Index of the owning contour in `NcGeometry.contours` (for removal). */
  contourIndex: number
  /** `outer` (AK) or `inner` (IK). */
  kind: NcContour['kind']
  /**
   * Inclusive vertex-index range to delete when removing a run inside a shared profile, or `null`
   * when the whole contour is the feature (its block is dropped instead).
   */
  removal: [number, number] | null
}

export interface UnclosedCutOptions {
  /**
   * The section outline the NC was authored for. When supplied, the face boundary is the section's
   * real cross-extent (so a loop that floats inside a wide face is caught); without it the contour's
   * own extremes are used as a fallback.
   */
  section?: [number, number][]
  /** DSTV/Tekla profile code, so a channel's authored across-stance resolves (see `ncFaces`). */
  profile?: string
}

/** Whether a contour's polyline closes back on its first vertex. */
function isClosed(points: [number, number][]): boolean {
  if (points.length < 2) return false
  const a = points[0] as [number, number]
  const b = points[points.length - 1] as [number, number]
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6
}

/**
 * Drops a repeated closing point so the cyclic walk sees each vertex once, keeping the mapping
 * back to the raw `points` indices (for removal).
 */
function unclose(points: [number, number][]): { pts: [number, number][]; raw: number[] } {
  const count = isClosed(points) ? points.length - 1 : points.length
  const pts: [number, number][] = []
  const raw: number[] = []
  for (let i = 0; i < count; i++) {
    const point = points[i]
    if (!point) continue
    pts.push(point)
    raw.push(i)
  }
  return { pts, raw }
}

/** The face's cross-extent `[min, max]` in NC face coordinates. */
type Boundary = [number, number]

/**
 * A raw-stock edge runs along the member and sits on the face boundary (the section's silhouette) —
 * the same rule `bevelChange` uses to split cuts. Such an edge is the material boundary, not a cut.
 */
function stockEdgeFlags(points: [number, number][], closed: boolean, bound: Boundary): boolean[] {
  const last = closed ? points.length : points.length - 1
  const flags: boolean[] = []
  const atBoundary = (value: number) =>
    Math.abs(value - bound[0]) < EDGE_TOL_MM || Math.abs(value - bound[1]) < EDGE_TOL_MM
  for (let i = 0; i < last; i++) {
    const a = points[i] as [number, number]
    const b = points[(i + 1) % points.length] as [number, number]
    const along = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])
    flags.push(along && atBoundary(a[1]) && atBoundary(b[1]))
  }
  return flags
}

/** Whether a point sits on the face boundary. */
function onEdge(point: [number, number], bound: Boundary): boolean {
  return Math.abs(point[1] - bound[0]) < EDGE_TOL_MM || Math.abs(point[1] - bound[1]) < EDGE_TOL_MM
}

/** Signed area of a closed polygon (shoelace). */
function polygonArea(points: [number, number][]): number {
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as [number, number]
    const b = points[(i + 1) % points.length] as [number, number]
    twice += a[0] * b[1] - b[0] * a[1]
  }
  return twice / 2
}

interface Run {
  /** Raw vertex indices of the run's polyline (contour order). */
  raw: number[]
  polyline: [number, number][]
  length: number
}

/** Maximal runs of consecutive non-stock (cut) edges. Cyclic for a closed contour. */
function cutRuns(
  points: [number, number][],
  raw: number[],
  closed: boolean,
  bound: Boundary,
): Run[] {
  const n = points.length
  const edgeCount = closed ? n : n - 1
  if (edgeCount < 1) return []
  const isCut = stockEdgeFlags(points, closed, bound).map((stock) => !stock)

  const build = (edges: number[]): Run => {
    const polyline: [number, number][] = []
    const runRaw: number[] = []
    for (const e of edges) {
      const a = points[e % n] as [number, number]
      const b = points[(e + 1) % n] as [number, number]
      if (polyline.length === 0) {
        polyline.push(a)
        runRaw.push(raw[e % n] as number)
      }
      polyline.push(b)
      runRaw.push(raw[(e + 1) % n] as number)
    }
    let length = 0
    for (let i = 0; i < polyline.length - 1; i++) {
      const a = polyline[i] as [number, number]
      const b = polyline[i + 1] as [number, number]
      length += Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    return { raw: runRaw, polyline, length }
  }

  // Walk the edges in order, starting just after a stock edge so no cut run straddles the seam.
  const runs: Run[] = []
  const stockAt = isCut.indexOf(false)
  const startEdge = closed ? (stockAt < 0 ? 0 : (stockAt + 1) % edgeCount) : 0
  let current: number[] = []
  for (let k = 0; k < edgeCount; k++) {
    const e = closed ? (startEdge + k) % edgeCount : k
    if (isCut[e]) current.push(e)
    else if (current.length) {
      runs.push(build(current))
      current = []
    }
  }
  if (current.length) runs.push(build(current))
  return runs
}

/** Runs the unclosed-cut check over every contour in an NC file. */
export function assessUnclosedCuts(
  ncText: string,
  options: UnclosedCutOptions = {},
): UnclosedCutIssue[] {
  return assessUnclosedCutsGeometry(parseNcGeometry(ncText), options)
}

/** As {@link assessUnclosedCuts} but on already-parsed NC geometry. */
export function assessUnclosedCutsGeometry(
  nc: NcGeometry,
  options: UnclosedCutOptions = {},
): UnclosedCutIssue[] {
  const issues: UnclosedCutIssue[] = []
  const section = options.section
  const frame =
    section && section.length >= 3 ? resolveNcFaceFrame(section, nc, options.profile) : null

  /** The face boundary: the section's real cross-extent, or the contour's own extremes. */
  const boundaryOf = (face: NcFace, contour: NcContour): Boundary => {
    if (frame) {
      const extent = frame.extent[faceSpanAxis(frame, face)]
      if (Number.isFinite(extent) && extent > 0) return [0, extent]
    }
    const ys = contour.points.map((p) => p[1])
    return [Math.min(...ys), Math.max(...ys)]
  }

  nc.contours.forEach((contour, contourIndex) => {
    const closed = isClosed(contour.points)
    const { pts, raw } = unclose(contour.points)
    if (pts.length < 2) return
    const bound = boundaryOf(contour.face, contour)

    if (contour.kind === 'inner') {
      if (!closed) {
        // A broken (open) cut-out.
        issues.push(issue(contour, contourIndex, { reason: 'open', polyline: pts, removal: null }))
        return
      }
      // A normal opening (rectangular / rounded / slotted) is fine. A **triangular** one, or a very
      // small one, is a modelling artifact — and WiseCAM can misread it as a stray line near a hole.
      const area = Math.abs(polygonArea(pts))
      if (pts.length === 3 || area < SMALL_CUTOUT_MM2) {
        // Keep the closing duplicate so the viewer marker traces the whole opening.
        issues.push(
          issue(contour, contourIndex, {
            reason: 'cutout',
            polyline: contour.points,
            removal: null,
          }),
        )
      }
      return
    }

    // A valid outer profile is always a closed loop. A non-closed one is a broken/partial cut —
    // the cut chain as a whole is the feature, so it is flagged and removed block-wise.
    if (!closed) {
      issues.push(issue(contour, contourIndex, { reason: 'open', polyline: pts, removal: null }))
      return
    }

    const hasStockEdge = stockEdgeFlags(pts, closed, bound).some(Boolean)
    // A closed outer contour with no raw-stock edge at all floats inside the face — the whole loop
    // is a stray cut that never reaches the material boundary.
    if (!hasStockEdge) {
      const run = cutRuns(pts, raw, closed, bound)[0]
      issues.push(
        issue(contour, contourIndex, {
          reason: 'floating',
          polyline: run ? run.polyline : pts,
          removal: null,
        }),
      )
      return
    }

    for (const run of cutRuns(pts, raw, closed, bound)) {
      const startPoint = run.polyline[0] as [number, number]
      const endPoint = run.polyline[run.polyline.length - 1] as [number, number]
      const edgeToEdge = onEdge(startPoint, bound) && onEdge(endPoint, bound)
      const reason: UnclosedReason | null = !edgeToEdge
        ? 'open'
        : run.length < TINY_CUT_MM
          ? 'tiny'
          : null
      if (!reason) continue

      // A run inside a normal profile is excised by deleting its interior vertices. Only a
      // contiguous, seam-free run can be expressed as an index range.
      const contiguous = run.raw.every(
        (value, i) => i === 0 || value === (run.raw[i - 1] as number) + 1,
      )
      const removal: [number, number] | null =
        run.raw.length >= 3 && contiguous
          ? [run.raw[0] as number, run.raw[run.raw.length - 1] as number]
          : null

      issues.push(issue(contour, contourIndex, { reason, polyline: run.polyline, removal }))
    }
  })

  return issues
}

function issue(
  contour: NcContour,
  contourIndex: number,
  feature: {
    reason: UnclosedReason
    polyline: [number, number][]
    removal: [number, number] | null
  },
): UnclosedCutIssue {
  const start = feature.polyline[0] as [number, number]
  const end = feature.polyline[feature.polyline.length - 1] as [number, number]
  const xs = feature.polyline.map((p) => p[0])
  let span = 0
  for (let i = 0; i < feature.polyline.length - 1; i++) {
    const a = feature.polyline[i] as [number, number]
    const b = feature.polyline[i + 1] as [number, number]
    span += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  // A closed loop's last point repeats the first, so its perimeter is already summed above; an
  // open run's is not. Count the distinct vertices for a triangular-cut-out note.
  const distinct = isClosed(feature.polyline)
    ? feature.polyline.length - 1
    : feature.polyline.length
  const message =
    feature.reason === 'open'
      ? `Unclosed cut on face ${contour.face}: ${span.toFixed(0)} mm that doesn't run edge to edge — possibly a stray cut that shouldn't be there`
      : feature.reason === 'floating'
        ? `Floating cut on face ${contour.face}: a loop that never reaches the face edges — possibly a stray cut that shouldn't be there`
        : feature.reason === 'cutout'
          ? `Small ${distinct === 3 ? 'triangular ' : ''}cut-out on face ${contour.face}: ${span.toFixed(0)} mm perimeter — possibly a stray cut that shouldn't be there`
          : `Little cut on face ${contour.face}: only ${span.toFixed(0)} mm long — verify it is intended`
  return {
    code: feature.reason === 'cutout' ? 'CUT_CUTOUT' : 'CUT_UNCLOSED',
    severity: 'warning',
    face: contour.face,
    from: [start[0], start[1]],
    to: [end[0], end[1]],
    lines: [feature.polyline.map((p) => [p[0], p[1]] as [number, number])],
    color: UNCLOSED_COLOR,
    message,
    params: {
      face: contour.face,
      x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
      span: Math.round(span),
      reason: feature.reason,
    },
    contourIndex,
    kind: contour.kind,
    removal: feature.removal,
  }
}
