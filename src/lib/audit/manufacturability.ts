import { MACHINE } from '@/lib/machine/profile'
import { type NcContour, parseNcGeometry } from '@/lib/parsers/ncGeometry'

/**
 * Manufacturability checks for a DSTV `.nc1`, under the shop's laser-cutting model:
 *
 * - The laser cut path is a line on the surface; it is assumed **perpendicular** to that
 *   surface unless the contour carries welding-preparation (bevel) data.
 * - A **sudden change in thickness** cannot be cut, because the beam has to reach the
 *   material to remove it — only a joint where two faces meet produces an abrupt edge.
 *
 * These are heuristics on the face outlines, surfaced to the operator as findings. They are
 * advisory, not exact — the operator makes the final call on how (or whether) to cut.
 */

/** Non-zero bevel/weld-prep value threshold (mm or degrees). */
const BEVEL_EPS = 1e-6
/** The head's bevel / weld-prep range; values outside it are not bevel angles. */
const MAX_BEVEL_DEG = Math.max(Math.abs(MACHINE.bevel.minDeg), Math.abs(MACHINE.bevel.maxDeg))
/** A near-vertical outline edge: |ΔX| at most this (mm). */
const STEP_DX = 1.0
/** ...and |ΔY| at least this (mm) — a sudden, not gradual, change. */
const STEP_DY = 10.0
/**
 * The cutting head can only reach ~3 cm (30–40 mm) into a cut. A step deeper than this cannot be
 * reached by sweeping one face: it is not manufacturable as drawn and would crash the head.
 */
export const UNMANUFACTURABLE_DEPTH = MACHINE.unmachinableDepthMm

export interface ManufacturabilityIssue {
  code: 'CUT_STEP'
  /** All current issues are unmanufacturable, so they surface as errors. */
  severity: 'error'
  message: string
  params?: Record<string, string | number>
}

/** True when a contour vertex carries welding-preparation / bevel data (angled cut). */
export function contourHasBevel(contour: NcContour): boolean {
  return contour.bevels.some((values) =>
    values.some((value) => Number.isFinite(value) && Math.abs(value) > BEVEL_EPS),
  )
}

/**
 * True when the vertex carries a welding-prep **angle** within the head's range. The `bevels`
 * array interleaves angle/distance pairs, so only the angle fields (`0` and `2`) count — a
 * distance value alone is not a bevel cut (cf. {@link contourHasBevel}).
 */
function hasBevelAngleAt(contour: NcContour, index: number): boolean {
  const values = contour.bevels[index] ?? []
  return [values[0], values[2]].some(
    (angle) =>
      Number.isFinite(angle) &&
      Math.abs(angle as number) > BEVEL_EPS &&
      Math.abs(angle as number) <= MAX_BEVEL_DEG,
  )
}

/**
 * True when the edge at `index` meets a rounded corner: the edge itself is an arc, or an arc
 * starts/ends at either endpoint. A corner arc puts stock on the far side of a cut line (the
 * rounded end), which the step probes would otherwise read as a sudden thickness change.
 */
function touchesArc(contour: NcContour, index: number): boolean {
  const radii = contour.radii ?? []
  const n = contour.points.length
  return [index, index + 1, index - 1].some(
    (k) => Math.abs(radii[((k % n) + n) % n] ?? 0) > BEVEL_EPS,
  )
}

/** True when the near-vertical edge at `index` shares a line with a notch/corner instruction. */
function touchesNotch(contour: NcContour, index: number, notches: [number, number][]): boolean {
  if (notches.length === 0) return false
  const a = contour.points[index]
  if (!a) return false
  return notches.some(([x]) => Math.abs(x - a[0]) <= STEP_DX)
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
 *
 * With `ignoreBeveled`, an edge whose vertices carry welding-prep **angle** data is not a sudden
 * step: it is an angled/bevel cut, and the material the probe sees on the far side is the bevel
 * wedge the head removes. That is how a T's web/flange root and an angle's leg root are cut with
 * the machine's bevel settings, so those edges are skipped (the bevel check surfaces them).
 * With `ignoreRoundedCorners`, an edge meeting an arc is likewise skipped — the far-side material
 * is the rounded corner, not a thickness step.
 */
export function contourStepDepth(
  contour: NcContour,
  options: {
    ignoreBeveled?: boolean
    ignoreRoundedCorners?: boolean
    /** Notch/corner instruction points on this contour's face (NC face coords). */
    notches?: [number, number][]
  } = {},
): number {
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
    if (
      options.ignoreBeveled &&
      (hasBevelAngleAt(contour, i) || hasBevelAngleAt(contour, (i + 1) % points.length))
    ) {
      continue
    }
    if (options.ignoreRoundedCorners && touchesArc(contour, i)) continue
    if (touchesNotch(contour, i, options.notches ?? [])) continue
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
 * Runs the manufacturability checks over every outer face contour in an NC file. Flags a sudden
 * thickness change deeper than the head can reach (`UNMANUFACTURABLE_DEPTH`) — material on both
 * sides of a deep near-vertical step, which a single-face laser sweep cannot cut. This is a
 * judgement call (e.g. the fix is to cut at an angle on the radius so the side doesn't exist),
 * so it is surfaced as an **error** and never auto-fixed. A step bounded by bevel/weld-prep data
 * is that angled cut (a T web/flange or angle leg root) and is skipped — it is cut with the
 * machine's bevel settings, not a straight sweep.
 */
export function assessManufacturability(ncText: string): ManufacturabilityIssue[] {
  const { contours, notches } = parseNcGeometry(ncText)
  const outer = contours.filter((contour) => contour.kind === 'outer')
  const issues: ManufacturabilityIssue[] = []

  let depth = 0
  const faces: string[] = []
  for (const contour of outer) {
    const contourDepth = contourStepDepth(contour, {
      ignoreBeveled: true,
      ignoreRoundedCorners: true,
      notches: notches
        .filter((notch) => notch.face === contour.face)
        .map((notch) => [notch.x, notch.y] as [number, number]),
    })
    if (contourDepth >= UNMANUFACTURABLE_DEPTH) {
      depth = Math.max(depth, contourDepth)
      faces.push(contour.face)
    }
  }
  if (depth > 0) {
    const faceList = [...new Set(faces)].join(', ')
    issues.push({
      code: 'CUT_STEP',
      severity: 'error',
      message: `Not manufacturable: a sudden ${depth.toFixed(0)} mm thickness change on face(s) ${faceList} is past the ~${UNMANUFACTURABLE_DEPTH.toFixed(0)} mm the head can reach — it would damage the machine. Cut at an angle on the radius (a manual judgement), it can't be swept in one pass`,
      params: { depth: depth.toFixed(0), faces: faceList },
    })
  }

  return issues
}
