import { type NcContour, parseNcGeometry } from '@/lib/parsers/ncGeometry'

/**
 * Manufacturability checks for a DSTV `.nc1`, under the shop's laser-cutting model:
 *
 * - The laser cut path is a line on the surface; it is assumed **perpendicular** to that
 *   surface unless the contour carries welding-preparation (bevel) data.
 * - A **sudden change in thickness** cannot be cut, because the beam has to reach the
 *   material to remove it — only a joint where two faces meet produces an abrupt edge.
 *
 * These are heuristics on the face outlines, surfaced to the operator as findings with a
 * suggested simplification. They are advisory, not exact.
 */

/** Non-zero bevel/weld-prep value threshold (mm or degrees). */
const BEVEL_EPS = 1e-6
/** A near-vertical outline edge: |ΔX| at most this (mm). */
const STEP_DX = 1.0
/** ...and |ΔY| at least this (mm) — a sudden, not gradual, change. */
const STEP_DY = 10.0

export interface ManufacturabilityIssue {
  code: 'CUT_STEP'
  message: string
  params?: Record<string, string | number>
}

/** True when a contour vertex carries welding-preparation / bevel data (angled cut). */
export function contourHasBevel(contour: NcContour): boolean {
  return contour.bevels.some((values) =>
    values.some((value) => Number.isFinite(value) && Math.abs(value) > BEVEL_EPS),
  )
}

function pointInPolygon([px, py]: [number, number], polygon: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/** Whether the outline has material on both sides of a vertical line at `x`. */
function materialBothSides(
  points: [number, number][],
  x: number,
  minY: number,
  span: number,
): {
  near: boolean
  far: boolean
} {
  let near = false
  let far = false
  for (let s = 0; s <= 20; s++) {
    const y = minY + (span * s) / 20
    if (pointInPolygon([x - 2 * STEP_DX, y], points)) near = true
    if (pointInPolygon([x + 2 * STEP_DX, y], points)) far = true
  }
  return { near, far }
}

/**
 * A sudden thickness change: a near-vertical edge with material present on **both** sides
 * (an end cut has material on one side only, so it is not flagged). A jump deeper than the
 * beam can clear (~3 cm reach) cannot be cut by sweeping one face.
 */
export function contourStepDepth(contour: NcContour): number {
  const points = contour.points
  if (points.length < 4) return 0
  const xs = points.map((p) => p[0])
  const minY = Math.min(...points.map((p) => p[1]))
  const maxY = Math.max(...points.map((p) => p[1]))
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2
  const span = maxY - minY
  if (span <= 0) return 0

  let deepest = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const dx = Math.abs(b[0] - a[0])
    const dy = Math.abs(b[1] - a[1])
    if (dx > STEP_DX || dy < STEP_DY) continue
    const edgeX = (a[0] + b[0]) / 2
    if (edgeX <= midX) continue
    const { near, far } = materialBothSides(points, edgeX, minY, span)
    if (near && far) deepest = Math.max(deepest, dy)
  }
  return deepest
}

export function contourHasStep(contour: NcContour): boolean {
  return contourStepDepth(contour) > 0
}

/**
 * Runs the manufacturability checks over every outer face contour in an NC file. Currently
 * flags a sudden thickness change (a deep, near-vertical step with material both sides) —
 * which a single-face laser sweep cannot reach. Bevels are captured separately (see
 * `contourHasBevel`) and are surfaced by viewing rather than as a finding.
 */
export function assessManufacturability(ncText: string): ManufacturabilityIssue[] {
  const { contours } = parseNcGeometry(ncText)
  const outer = contours.filter((contour) => contour.kind === 'outer')
  const issues: ManufacturabilityIssue[] = []

  let depth = 0
  const faces: string[] = []
  for (const contour of outer) {
    const contourDepth = contourStepDepth(contour)
    if (contourDepth > 0) {
      depth = Math.max(depth, contourDepth)
      faces.push(contour.face)
    }
  }
  if (depth > 0) {
    const faceList = [...new Set(faces)].join(', ')
    issues.push({
      code: 'CUT_STEP',
      message: `Sudden ${depth.toFixed(0)} mm thickness change on face(s) ${faceList} — cannot be laser cut as drawn; simplify to a flat surface or split the joint`,
      params: { depth: depth.toFixed(0), faces: faceList },
    })
  }

  return issues
}
