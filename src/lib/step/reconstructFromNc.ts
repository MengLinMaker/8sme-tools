import { contourHasBevel, contourStepDepth } from '@/lib/audit/manufacturability'
import { parseDstv } from '@/lib/parsers/dstv'
import { type NcContour, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { partSectionForCode } from '@/lib/sections/stock'
import { ensureOc } from './occInit'

/**
 * EXPERIMENTAL / standalone: rebuild a prismatic part's solid from its DSTV `.nc1`.
 *
 * Kept separate from the nesting/preflight pipeline (the preflight viewer is the only caller).
 * The NC is treated as ground truth: the cross-section comes from the profile code + `ST` header
 * dims (via `partSectionForCode`), the outline from the `AK` contours, and holes from `BO`.
 *
 * Faces are paired as DSTV defines them — `v`/`h` share one cross-section axis, `o`/`u` the other
 * — and which is which is matched by comparing the contour's Y-extent to the section's two
 * dimensions. Validated against healthy sibling parts: bounding box within a few mm and volume
 * within ~2% (the deficit is end-arc radii, drawn straight for now).
 *
 * Handles `T`, `RHS`/`SHS`, `PFC`/`TFC`, `EA`/`UA`, `UB` and `CHS`. Returns `null` otherwise.
 */

type Pt = [number, number]
type Axis = 0 | 1

interface SolidOps {
  intersect: (other: SolidOps) => SolidOps
  cut: (other: SolidOps) => SolidOps
}

function extent(points: Pt[], axis: Axis): number {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const p of points) {
    min = Math.min(min, p[axis])
    max = Math.max(max, p[axis])
  }
  return max - min
}

function maxCoord(contour: NcContour, axis: Axis): number {
  return Math.max(...contour.points.map((p) => p[axis]))
}

function dedupe(pts: Pt[]): Pt[] {
  const out = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1])
  if (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  )
    out.pop()
  return out
}

interface ShapeOps {
  boundingBox: { bounds: [number[], number[]] }
  clone: () => ShapeOps
  translate: (x: number, y: number, z: number) => ShapeOps
  mirror: (plane: string) => ShapeOps
  rotate: (angle: number, position: number[], direction: number[]) => ShapeOps
  intersect: (other: ShapeOps) => ShapeOps
}

/**
 * Align the NC-built solid to a reference STEP (the part's own file), so the manufactured view
 * matches the file's orientation.
 *
 * The eight 90°-step transforms about the member axis are ranked cheaply by centre-of-mass distance
 * (a volume moment, no booleans), which already separates the correct orientation — including the
 * mirror that a rotation-only seating cannot undo for asymmetric sections (PFC/angle). Only the
 * top candidate is confirmed with an overlap test; the full overlap search is a fallback for the
 * rare case the moment does not settle it. This replaces eight boolean intersections (the old
 * bottleneck) with eight volume moments plus at most one intersection.
 */
async function orientToReference(solid: SolidOps, reference: Uint8Array): Promise<SolidOps> {
  const { importSTEP, measureShapeVolumeProperties, measureVolume } = await import('replicad')
  const ref = (await importSTEP(
    new Blob([new Uint8Array(reference)], { type: 'model/step' }),
  )) as unknown as ShapeOps
  const [rmin, rmax] = ref.boundingBox.bounds
  const refCentre = rmin.map((v, k) => (v + rmax[k]) / 2)
  const refVolume = measureVolume(ref as never)
  if (!(refVolume > 0)) return solid
  const refCentroid = (measureShapeVolumeProperties(ref as never) as { centerOfMass: number[] })
    .centerOfMass

  const base = solid as unknown as ShapeOps
  const candidates: { shape: ShapeOps; score: number }[] = []
  for (const mirrored of [false, true]) {
    for (const angle of [0, 90, 180, 270]) {
      const candidate = mirrored ? base.clone().mirror('XZ') : base.clone()
      const oriented = angle ? candidate.rotate(angle, [0, 0, 0], [1, 0, 0]) : candidate
      const [cmin, cmax] = oriented.boundingBox.bounds
      const shift = rmin.map((_v, k) => refCentre[k] - (cmin[k] + cmax[k]) / 2)
      const moved = oriented.translate(shift[0], shift[1], shift[2])
      let score = Number.POSITIVE_INFINITY
      try {
        const centroid = (
          measureShapeVolumeProperties(moved as never) as { centerOfMass: number[] }
        ).centerOfMass
        score = Math.hypot(
          centroid[0] - refCentroid[0],
          centroid[1] - refCentroid[1],
          centroid[2] - refCentroid[2],
        )
      } catch {
        score = Number.POSITIVE_INFINITY
      }
      candidates.push({ shape: moved, score })
    }
  }
  candidates.sort((a, b) => a.score - b.score)

  const overlap = (shape: ShapeOps): number => {
    try {
      return measureVolume(shape.clone().intersect(ref.clone()) as never) / refVolume
    } catch {
      return 0
    }
  }

  // Confirm the best-ranked candidate; only fall back to testing the rest if it does not fit.
  let best: ShapeOps | null = null
  let bestScore = -1
  for (const candidate of candidates) {
    const score = overlap(candidate.shape)
    if (score > bestScore) {
      bestScore = score
      best = candidate.shape
    }
    if (score >= 0.9) break
  }
  // No transform fits (e.g. the reference is a corrupt/degenerate STEP): keep the native frame.
  if (!best || bestScore < 0.1) return solid
  return best as unknown as SolidOps
}

export interface ReconstructOptions {
  /**
   * Leave a flat surface where a face carries a sudden thickness step (a cut the laser can't
   * sweep), instead of reproducing the step. Used for the "simplify to flat surface" fix.
   */
  simplify?: boolean
  /**
   * The part's own STEP file, if available: the built solid is oriented to match it, so the
   * manufactured view uses the file's orientation rather than the reconstruction's own frame.
   */
  reference?: Uint8Array
}

export async function reconstructStepFromNc(
  ncText: string,
  options: ReconstructOptions = {},
): Promise<string | null> {
  const header = parseDstv(ncText).header
  const geo = parseNcGeometry(ncText)
  const section = partSectionForCode(header.profile, header.dimensions)
  if (!section || section.points.length < 3) return null

  await ensureOc()
  const { draw, drawCircle } = await import('replicad')
  const poly = (pts: Pt[]) => {
    let pen = draw(pts[0])
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i])
    return pen.close()
  }

  const ex = extent(section.points, 0)
  const ey = extent(section.points, 1)
  const outer = geo.contours.filter((c) => c.kind === 'outer')
  const maxX = Math.max(
    ...geo.contours.flatMap((c) => c.points.map((p) => p[0])),
    ...geo.holes.map((h) => h.x + h.diameter),
  )
  const matchAxis = (yMax: number): Axis => (Math.abs(yMax - ex) <= Math.abs(yMax - ey) ? 0 : 1)

  // `v`/`h` faces share one cross-section axis, `o`/`u` the other. Decide which by matching
  // the contour's Y-extent to the section's two dimensions.
  const vh = outer.find((c) => c.face === 'v' || c.face === 'h')
  const ou = outer.find((c) => c.face === 'o' || c.face === 'u')
  const axisVH: Axis = vh
    ? matchAxis(maxCoord(vh, 1))
    : ou
      ? ((1 - matchAxis(maxCoord(ou, 1))) as Axis)
      : 0
  const axisOU: Axis = (1 - axisVH) as Axis
  const faceAxis = (face: string): Axis => (face === 'v' || face === 'h' ? axisVH : axisOU)
  const halfOf = (axis: Axis): number => (axis === 0 ? ex / 2 : ey / 2)
  const pointsByAxis: Record<Axis, Pt[]> = { 0: [], 1: [] }
  const drawingsByAxis: Record<Axis, ReturnType<typeof poly>[]> = { 0: [], 1: [] }

  // Base prism: cross-section in the (width=Y, depth=Z) plane, extruded along the member (X).
  let solid = poly(section.points)
    .sketchOnPlane('YZ')
    .extrude(maxX + 20) as unknown as SolidOps

  // Holes in the section (hollow RHS/SHS/CHS) are through-cuts too.
  for (const hole of section.holes ?? []) {
    const cut = poly(hole)
      .sketchOnPlane('YZ')
      .extrude(maxX + 20) as unknown as SolidOps
    solid = solid.cut(cut)
  }

  for (const c of outer) {
    const axis = faceAxis(c.face)
    const half = halfOf(axis)
    const pts = dedupe(c.points).map(([x, y]) => [x, y - half] as Pt)
    pointsByAxis[axis].push(...pts)
    drawingsByAxis[axis].push(poly(pts))
  }

  // Constrain each cross-section axis by the union of that axis's face outlines. A mitre makes
  // the top face shorter than the bottom, so the union (not either face alone) is the true
  // silhouette and stops the intersection from over-trimming the ends.
  for (const axis of [0, 1] as Axis[]) {
    const drawings = drawingsByAxis[axis]
    if (drawings.length === 0) continue
    let shape = drawings[0]
    for (let i = 1; i < drawings.length; i++) {
      const fused = (shape as unknown as { fuse: (other: unknown) => unknown }).fuse(drawings[i])
      if (fused) shape = fused as typeof shape
    }
    // Simplifying: leave the face flat rather than reproducing a step, or a bevel whose
    // straight-through cut would sever a piece it is meant to keep.
    if (
      options.simplify &&
      axis === 1 &&
      outer.some((c) => faceAxis(c.face) === 1 && (contourStepDepth(c) > 0 || contourHasBevel(c)))
    ) {
      continue
    }
    const half = halfOf(axis)
    if (axis === 0) {
      // Face plane is (X, width=Y); extrude across the depth and keep the inside.
      const prism = (shape as ReturnType<typeof poly>)
        .sketchOnPlane('XY')
        .extrude(400)
        .translate(0, 0, -150) as unknown as SolidOps
      solid = solid.intersect(prism)
    } else {
      // Face plane is (X, depth=Z). `intersect` trips an OCC boolean error with the section
      // prism, so remove the complement (bounding rectangle minus the outline) with a cut.
      const xs = pointsByAxis[axis].map((p) => p[0])
      const minX = Math.min(...xs)
      const maxXc = Math.max(...xs)
      // The rectangle must fully enclose the outline in X too, or the boolean drops the sliver
      // of removed material at the very ends (the outline reaches the rect's left/right edges).
      const rect = poly([
        [minX - 2, -half - 2],
        [maxXc + 2, -half - 2],
        [maxXc + 2, half + 2],
        [minX - 2, half + 2],
      ])
      const notch = (rect as unknown as { cut: (other: unknown) => unknown }).cut(shape)
      if (!notch) continue
      // `sketchOnPlane('XZ')` extrudes towards −Y, so shift the prism back over the section
      // (which sits at Y = −half..half) rather than away from it.
      const notchSolid = (notch as ReturnType<typeof poly>)
        .sketchOnPlane('XZ')
        .extrude(400)
        .translate(0, 250, 0) as unknown as SolidOps
      solid = solid.cut(notchSolid)
    }
  }

  // Holes, drilled perpendicular to the face they sit on.
  for (const h of geo.holes.filter((h) => h.diameter > 0)) {
    const axis = faceAxis(h.face)
    const half = halfOf(axis)
    if (axis === 0) {
      const cyl = drawCircle(h.diameter / 2)
        .translate(h.x, h.y - half)
        .sketchOnPlane('XY')
        .extrude(600)
        .translate(0, 0, -250) as unknown as SolidOps
      solid = solid.cut(cyl)
    } else {
      const cyl = drawCircle(h.diameter / 2)
        .translate(h.x, h.y - half)
        .sketchOnPlane('XZ')
        .extrude(600)
        .translate(0, -250, 0) as unknown as SolidOps
      solid = solid.cut(cyl)
    }
  }

  if (options.reference) solid = await orientToReference(solid, options.reference)

  const blob = (solid as unknown as { blobSTEP: () => Blob }).blobSTEP()
  return await blob.text()
}
