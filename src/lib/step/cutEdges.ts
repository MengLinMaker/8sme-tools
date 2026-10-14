/**
 * Classifies a meshed STEP part's edge lines against the **raw-stock cross-section**, so the STEP
 * viewer can colour the *cut* edges by the wall thickness they pass through — the same colour key
 * the projected NC toolpath uses (`ncProject`).
 *
 * A prismatic stock's surface is made of lengthwise faces (the extrude of its section outline).
 * An edge is **raw stock** when it runs along the member *and* sits on that outline (the section's
 * silhouette); every other edge belongs to a cut face (a end/mitre/cope/notch, a hole rim, a
 * lengthwise split). Cut edges are grouped by the local wall thickness at their midpoint: the
 * distance from the surface to the nearest opposite edge of the section, projected onto the local
 * face normal — i.e. the plate the cut bores through.
 *
 * Pure (no three.js / OCC): the caller seats the model (length on `X`) and passes the section
 * outline plus the two cross-section basis vectors, so this is unit-tested directly.
 */

export type Vec3 = [number, number, number]

/** Flat XYZ pairs, `[x0,y0,z0, x1,y1,z1, …]`. */
export type SegmentList = number[]

/** A run of cut segments that share one wall thickness. */
export interface CutEdgeGroup {
  /** Wall thickness (mm) the group's cuts pass through. */
  thickness: number
  /** Flat XYZ pairs for every segment in the group. */
  points: SegmentList
}

export interface CutEdgeResult {
  /** Raw-stock silhouette edges (drawn in the model's normal edge colour). */
  stock: SegmentList
  /** Cut edges grouped by wall thickness, ascending. */
  cuts: CutEdgeGroup[]
}

export interface ClassifyCutEdgesOptions {
  /** Member long-axis component in the seated frame (the model is seated with its length on X). */
  alongAxis?: 0 | 1 | 2
  /** Max deviation (deg) from the member axis for an edge to still count as a stock edge. */
  alongToleranceDeg?: number
  /** Max distance (mm) to the section outline for an along-member edge to count as stock. */
  outlineToleranceMm?: number
}

const DEFAULT_ALONG_TOLERANCE_DEG = 12
const DEFAULT_OUTLINE_TOLERANCE_MM = 1.5
/** Thicknesses below this (mm) are treated as "same face" hits and ignored. */
const MIN_THICKNESS_MM = 0.05

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Distance from a section-frame point to the outer outline boundary. */
export function distanceToOutline(section: [number, number][], point: [number, number]): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < section.length; i++) {
    const a = section[i] as [number, number]
    const b = section[(i + 1) % section.length] as [number, number]
    const d = segmentDistance(point[0], point[1], a[0], a[1], b[0], b[1])
    if (d < best) best = d
  }
  return best
}

/** Signed area of a closed polygon (positive = counter-clockwise). */
function signedArea(points: [number, number][]): number {
  let twice = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j] as [number, number]
    const b = points[i] as [number, number]
    twice += a[0] * b[1] - b[0] * a[1]
  }
  return twice / 2
}

/** Outward unit normals of each edge of a closed polygon (uses the polygon's winding). */
function edgeNormals(points: [number, number][]): [number, number][] {
  const ccw = signedArea(points) >= 0
  const normals: [number, number][] = []
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as [number, number]
    const b = points[(i + 1) % points.length] as [number, number]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    normals.push(ccw ? [dy / len, -dx / len] : [-dy / len, dx / len])
  }
  return normals
}

/** Outward normal of the outline edge nearest to `point`. */
function nearestEdgeOutwardNormal(
  section: [number, number][],
  point: [number, number],
): [number, number] {
  const normals = edgeNormals(section)
  let best = Number.POSITIVE_INFINITY
  let normal: [number, number] = [0, 0]
  for (let i = 0; i < section.length; i++) {
    const a = section[i] as [number, number]
    const b = section[(i + 1) % section.length] as [number, number]
    const d = segmentDistance(point[0], point[1], a[0], a[1], b[0], b[1])
    if (d < best) {
      best = d
      normal = normals[i] as [number, number]
    }
  }
  return normal
}

/**
 * Minimum distance (along `normal`) from `point` to a face of `poly` facing back toward it. For a
 * void (`flip`, a hole) the polygon's own winding faces *away* from the hole interior, so the
 * normals are negated to get the material→void direction.
 */
function oppositeFaceDistance(
  poly: [number, number][],
  point: [number, number],
  normal: [number, number],
  flip = false,
): number {
  const normals = edgeNormals(poly)
  const sign = flip ? -1 : 1
  let min = Number.POSITIVE_INFINITY
  for (let i = 0; i < poly.length; i++) {
    const raw = normals[i] as [number, number]
    const n: [number, number] = [raw[0] * sign, raw[1] * sign]
    // Only an opposite-facing edge bounds the plate the cut bores through.
    if (n[0] * normal[0] + n[1] * normal[1] > -0.5) continue
    const a = poly[i] as [number, number]
    const d = Math.abs((a[0] - point[0]) * normal[0] + (a[1] - point[1]) * normal[1])
    if (d > MIN_THICKNESS_MM && d < min) min = d
  }
  return min
}

/**
 * Wall thickness (mm) at a point on the stock surface: distance from the surface, along the
 * nearest face's inward normal, to the opposite face of the plate it passes through — the same
 * notion the NC toolpath's face thickness uses. Only edges facing *back* toward the point are
 * considered, so an adjacent fillet/corner vertex can't collapse the measurement.
 */
export function cutEdgeThicknessAt(
  section: [number, number][],
  holes: [number, number][][],
  point: [number, number],
): number {
  const normal = nearestEdgeOutwardNormal(section, point)
  let min = oppositeFaceDistance(section, point, normal)
  for (const hole of holes) {
    const d = oppositeFaceDistance(hole, point, normal, true)
    if (d < min) min = d
  }
  return Number.isFinite(min) ? min : 0
}

/** One edge segment's classification: raw stock, or a cut through `thickness` mm of plate. */
export interface EdgeClassification {
  kind: 'stock' | 'cut'
  /** Wall thickness (mm) for a cut; 0 for a stock edge. */
  thickness: number
}

/**
 * Classifies each seated model edge segment as raw-stock silhouette or a cut.
 *
 * `segments` are in the seated model frame (length on X); `section`/`holes` are the raw-stock
 * outline in cross-section coordinates; `xAxis`/`yAxis` are the orthonormal basis mapping
 * cross-section `(x, y)` into the seated model frame (the same basis the stock ghost is drawn on).
 */
export function classifyEdgeSegments(
  segments: SegmentList,
  section: [number, number][],
  holes: [number, number][][],
  xAxis: Vec3,
  yAxis: Vec3,
  options: ClassifyCutEdgesOptions = {},
): EdgeClassification[] {
  const alongAxis = options.alongAxis ?? 0
  const alongDot = Math.cos(
    ((options.alongToleranceDeg ?? DEFAULT_ALONG_TOLERANCE_DEG) * Math.PI) / 180,
  )
  const outlineTol = options.outlineToleranceMm ?? DEFAULT_OUTLINE_TOLERANCE_MM
  const result: EdgeClassification[] = []

  for (let i = 0; i + 5 < segments.length; i += 6) {
    const p0: Vec3 = [segments[i] as number, segments[i + 1] as number, segments[i + 2] as number]
    const p1: Vec3 = [
      segments[i + 3] as number,
      segments[i + 4] as number,
      segments[i + 5] as number,
    ]
    const dx = p1[0] - p0[0]
    const dy = p1[1] - p0[1]
    const dz = p1[2] - p0[2]
    const length = Math.hypot(dx, dy, dz)
    if (length < 1e-6) {
      result.push({ kind: 'stock', thickness: 0 })
      continue
    }
    const alongFraction = Math.abs(alongAxis === 0 ? dx : alongAxis === 1 ? dy : dz) / length
    const mid: Vec3 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2]
    const cross: [number, number] = [dot(mid, xAxis), dot(mid, yAxis)]
    const onOutline = distanceToOutline(section, cross) <= outlineTol
    if (alongFraction >= alongDot && onOutline) {
      result.push({ kind: 'stock', thickness: 0 })
      continue
    }
    result.push({ kind: 'cut', thickness: cutEdgeThicknessAt(section, holes, cross) })
  }
  return result
}

/**
 * A B-rep face already seated into the model frame — the input to {@link brepCutSegments}. Same
 * shape as `mesh.ts`'s `BrepFace` but with points/normals transformed and neighbours as indices.
 */
export interface SeatedBrepFace {
  normal: Vec3
  center: Vec3
  planar: boolean
  /** Points sampled on the face *surface* (seated, flat XYZ) — the stock/cut outline test. */
  samples: number[]
  wires: { enclosed: boolean; edges: { points: number[]; neighbours: number[] }[] }[]
}

/** Below this |normal · member| a face is lengthwise (a stock face, not a transverse cut). */
const LENGTHWISE_DOT = 0.3
/** A raw-stock face's boundary points sit within this (mm) of the section outline. */
const OUTLINE_TOL_MM = 2
/** Fraction of a face's boundary points that must lie on the outline for it to be raw stock. */
const OUTLINE_FRACTION = 0.7

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/**
 * Whether a seated face is part of the raw-stock surface. It must be lengthwise AND its *surface*
 * must lie on the section outline — sampling the surface (not just the boundary) distinguishes a
 * rounded stock corner (its arc *is* the outline) from a chamfer cut across that corner (whose
 * boundary edges touch the outline but whose surface is inset).
 */
function isStockFace(
  face: SeatedBrepFace,
  section: [number, number][],
  xAxis: Vec3,
  yAxis: Vec3,
  memberAxis: Vec3,
): boolean {
  if (Math.abs(dot(face.normal, memberAxis)) > LENGTHWISE_DOT) return false
  const samples = face.samples
  if (samples.length === 0) return false
  let on = 0
  let total = 0
  for (let i = 0; i + 2 < samples.length; i += 3) {
    const cross: [number, number] = [
      (samples[i] as number) * xAxis[0] +
        (samples[i + 1] as number) * xAxis[1] +
        (samples[i + 2] as number) * xAxis[2],
      (samples[i] as number) * yAxis[0] +
        (samples[i + 1] as number) * yAxis[1] +
        (samples[i + 2] as number) * yAxis[2],
    ]
    total++
    if (distanceToOutline(section, cross) <= OUTLINE_TOL_MM) on++
  }
  return total > 0 && on / total >= OUTLINE_FRACTION
}

/**
 * The coloured cut-edge segments of a seated B-rep. Faces are classified stock vs cut **by
 * topology**: a cut is any edge (on a stock face) bordering a cut face, so lengthwise cuts survive
 * — they are never dropped as "silhouette". Every cut is then **projected onto the nearest target
 * face** (`o`/`u`/`h`; every planar stock face when `targetNormals` is null) and its thickness is
 * taken there, so a cut riding a rounded corner (or the section's inner surface) reads flat on the
 * right face with that face's wall thickness.
 */
export function brepCutSegments(
  faces: SeatedBrepFace[],
  section: [number, number][],
  holes: [number, number][][],
  xAxis: Vec3,
  yAxis: Vec3,
  memberAxis: Vec3,
  targetNormals: Vec3[] | null,
): { thickness: number; points: number[] }[] {
  const stock = faces.map((face) => isStockFace(face, section, xAxis, yAxis, memberAxis))

  // Target faces: the planar o/u/h stock faces (a hollow section's inset inner wall shares a normal
  // direction with the opposite outer wall, so keep only the outermost face per direction).
  const targetIndices = new Set<number>()
  const byNormal = new Map<string, { index: number; offset: number }[]>()
  faces.forEach((face, i) => {
    if (!stock[i] || !face.planar) return
    if (targetNormals && !targetNormals.some((t) => dot(face.normal, t) > 0.98)) return
    const key = `${Math.round(face.normal[0])},${Math.round(face.normal[1])},${Math.round(face.normal[2])}`
    const list = byNormal.get(key)
    const entry = { index: i, offset: dot(face.center, face.normal) }
    if (list) list.push(entry)
    else byNormal.set(key, [entry])
  })
  for (const list of byNormal.values()) {
    const outermost = Math.max(...list.map((entry) => entry.offset))
    for (const entry of list) if (entry.offset >= outermost - 0.5) targetIndices.add(entry.index)
  }
  // A rounded corner / fillet (a curved stock face) adjacent to a target is included so a cut
  // crossing it is captured; it is projected onto the nearest target face. Only curved faces grow,
  // so an open section's inner groove faces are not swept in.
  let growing = true
  while (growing) {
    growing = false
    faces.forEach((face, i) => {
      if (targetIndices.has(i) || !stock[i] || face.planar) return
      const adjacent = face.wires.some((wire) =>
        wire.edges.some((edge) => edge.neighbours.some((n) => targetIndices.has(n))),
      )
      if (adjacent) {
        targetIndices.add(i)
        growing = true
      }
    })
  }

  const planarTargets = [...targetIndices]
    .map((i) => faces[i] as SeatedBrepFace)
    .filter((face) => face.planar)

  // Project a polyline onto the nearest target face (identity when it is already on one of them).
  const project = (points: number[]): number[] => {
    if (planarTargets.length === 0) return points
    const last = points.length - 3
    const mid: Vec3 = [
      ((points[0] as number) + (points[last] as number)) / 2,
      ((points[1] as number) + (points[last + 1] as number)) / 2,
      ((points[2] as number) + (points[last + 2] as number)) / 2,
    ]
    let best = Number.POSITIVE_INFINITY
    let plane: SeatedBrepFace | null = null
    for (const target of planarTargets) {
      const distance = Math.abs(dot(sub(mid, target.center), target.normal))
      if (distance < best) {
        best = distance
        plane = target
      }
    }
    if (!plane) return points
    const projected: number[] = []
    for (let k = 0; k + 2 < points.length; k += 3) {
      const p: Vec3 = [points[k] as number, points[k + 1] as number, points[k + 2] as number]
      const d = dot(sub(p, plane.center), plane.normal)
      projected.push(
        p[0] - d * plane.normal[0],
        p[1] - d * plane.normal[1],
        p[2] - d * plane.normal[2],
      )
    }
    return projected
  }

  const out: { thickness: number; points: number[] }[] = []
  for (const i of targetIndices) {
    const face = faces[i] as SeatedBrepFace
    for (const wire of face.wires) {
      for (const edge of wire.edges) {
        if (!wire.enclosed && !edge.neighbours.some((n) => !stock[n])) continue
        const points = face.planar ? edge.points : project(edge.points)
        out.push(...edgeCutSegments(points, section, holes, xAxis, yAxis, true))
      }
    }
  }
  return out
}

/**
 * Splits a seated edge polyline into its cut sub-segments, each tagged with the wall thickness at
 * its midpoint. `edgeCut` short-circuits an edge already known to be a cut (an enclosed wire, or
 * one shared with a transverse face) — every segment is kept. Otherwise each segment is classified
 * against the stock silhouette, so a **lengthwise cut off the silhouette** (a cope / zig-zag step)
 * is still kept while raw-stock edges drop out.
 */
export function edgeCutSegments(
  polyline: SegmentList,
  section: [number, number][],
  holes: [number, number][][],
  xAxis: Vec3,
  yAxis: Vec3,
  edgeCut: boolean,
): { thickness: number; points: number[] }[] {
  const out: { thickness: number; points: number[] }[] = []
  for (let i = 0; i + 5 < polyline.length; i += 3) {
    const points: number[] = [
      polyline[i] as number,
      polyline[i + 1] as number,
      polyline[i + 2] as number,
      polyline[i + 3] as number,
      polyline[i + 4] as number,
      polyline[i + 5] as number,
    ]
    let thickness: number
    if (edgeCut) {
      const mx = ((points[0] as number) + (points[3] as number)) / 2
      const my = ((points[1] as number) + (points[4] as number)) / 2
      const mz = ((points[2] as number) + (points[5] as number)) / 2
      const cross: [number, number] = [
        mx * xAxis[0] + my * xAxis[1] + mz * xAxis[2],
        mx * yAxis[0] + my * yAxis[1] + mz * yAxis[2],
      ]
      thickness = cutEdgeThicknessAt(section, holes, cross)
    } else {
      const classification = classifyEdgeSegments(points, section, holes, xAxis, yAxis)[0]
      if (classification?.kind !== 'cut') continue
      thickness = classification.thickness
    }
    out.push({ thickness: Math.round(thickness * 10) / 10, points })
  }
  return out
}

/**
 * Splits seated model edges into raw-stock silhouette edges and cut edges grouped by wall
 * thickness (ascending) — a convenience over {@link classifyEdgeSegments} for callers that want
 * the grouped geometry directly.
 */
export function splitCutEdges(
  segments: SegmentList,
  section: [number, number][],
  holes: [number, number][][],
  xAxis: Vec3,
  yAxis: Vec3,
  options: ClassifyCutEdgesOptions = {},
): CutEdgeResult {
  const classes = classifyEdgeSegments(segments, section, holes, xAxis, yAxis, options)
  const stock: number[] = []
  const groups = new Map<number, number[]>()
  for (let i = 0, s = 0; i + 5 < segments.length; i += 6, s++) {
    const p0: number[] = [
      segments[i] as number,
      segments[i + 1] as number,
      segments[i + 2] as number,
    ]
    const p1: number[] = [
      segments[i + 3] as number,
      segments[i + 4] as number,
      segments[i + 5] as number,
    ]
    const cls = classes[s] as EdgeClassification
    if (cls.kind === 'stock') {
      stock.push(...p0, ...p1)
      continue
    }
    const key = Math.round(cls.thickness * 10) / 10
    const bucket = groups.get(key)
    if (bucket) bucket.push(...p0, ...p1)
    else groups.set(key, [...p0, ...p1])
  }
  const cuts = [...groups.entries()]
    .map(([thickness, points]) => ({ thickness, points }))
    .sort((a, b) => a.thickness - b.thickness)
  return { stock, cuts }
}
