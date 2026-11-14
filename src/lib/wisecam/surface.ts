import type { NcFaceFrame } from '@/lib/parsers/ncFaces'
import { arcSamples, type NcContour, type NcFace, type NcGeometry } from '@/lib/parsers/ncGeometry'
import type { SeatedBrepFace, Vec3 } from '@/lib/step/cutEdges'
import { type FaceSegment, projectCutEdgesToFaces } from '@/lib/step/cutProjection'
import { rawStationFor, stationFor, type UnrolledLayout } from './layout'
import type { NcexCut, NcexHole, NcexMark } from './ncex'

/**
 * The **surface** layer shared by every NCEP source.
 *
 * A part is cut on the surface of its stock: a cut line is `(along the member, across the face)`
 * on one of the four DSTV faces, exactly where the laser meets the material (no viewer offset).
 * WiseCAM's NCEP part is the *unrolled* version of that surface, so the last step is purely a
 * mapping: `across → perimeter station`. Keeping the on-face cut geometry as the source of truth
 * means NC (`projectNc` / `parseNcGeometry`) and STEP (`projectCutEdgesToFaces`) feed the **same**
 * development, and two NCEP flavours become possible:
 *
 * - **NC → NCEP** — `developNcGeometry` (already face-space).
 * - **STEP → NCEP** — `projectStepCutEdges` (3-D cut edges → face-space → surface).
 *
 * The output is deliberately the same `NcexCut` / `NcexHole` / `NcexMark` shapes the writer wants;
 * `fromNc` and a future `fromStep` only differ in how they supply the on-face geometry.
 */

/** One point on the developed NCEP surface: `[perimeter station, along the member]` (mm). */
export type SurfacePoint = [number, number]

/** Developed cut/hole/mark geometry, ready for `buildNcex`. */
export interface SurfaceDevelopment {
  cuts: NcexCut[]
  holes: NcexHole[]
  marks: NcexMark[]
  /** Developed start/end cut boundaries; absent means the writer draws a straight end. */
  startCut?: SurfacePoint[]
  endCut?: SurfacePoint[]
}

export interface DevelopNcOptions {
  /** Member length (mm) — used to tell a stock edge from a start/end cut. */
  length: number
  /** Tube wall (mm) for the mitre/root-line correction; 0 for open sections. */
  wall?: number
  /** Wall thickness of a face, for the hole preview/legend colour. */
  thicknessForFace?: (face: NcFace) => number
}

export interface DevelopStepOptions {
  /** Outer corner radius (mm) — how far a rounded-corner cut reaches onto adjacent flats. */
  radius?: number
  /**
   * Add this to every `X` from the STEP projection. The seated model is usually centred on 0,
   * while NCEP `along` runs from the piece start, so pass `-minAlong`.
   */
  alongOffset?: number
}

interface ContourEnds {
  start: SurfacePoint[]
  end: SurfacePoint[]
}

/**
 * Expands a DSTV contour so its radius arcs (the `R` field on each vertex) are sampled into the
 * polyline. Without this the developed cut chords every fillet/notch arc, drawing a straight
 * line across the real curve (the NCEP view's overlay artifacts and the missed end-cut curve).
 */
export function densifyContour(contour: NcContour): SurfacePoint[] {
  const radii = contour.radii
  if (!radii?.some((radius) => radius)) return contour.points
  const count = contour.points.length
  const out: SurfacePoint[] = []
  for (let index = 0; index < count; index++) {
    const from = contour.points[index] as SurfacePoint
    const to = contour.points[(index + 1) % count] as SurfacePoint
    const samples = arcSamples(from, to, radii[index] ?? 0)
    // Drop each segment's end point; it is the next segment's start (or the closing duplicate).
    for (let step = 0; step < samples.length - 1; step++) out.push(samples[step] as SurfacePoint)
  }
  return out
}

/**
 * Splits a face's closed `AK` contour into the start-cut and end-cut arcs. The stock edges are
 * the long segments at constant face coordinate; everything between them is an end cut.
 */
export function splitContourEnds(points: SurfacePoint[], length: number): ContourEnds | null {
  const contour = points.slice()
  if (contour.length > 2) {
    const first = contour[0] as SurfacePoint
    const last = contour[contour.length - 1] as SurfacePoint
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) contour.pop()
  }
  const count = contour.length
  if (count < 3) return null

  const minLong = Math.max(5, length * 0.25)
  const longEdge = (index: number): boolean => {
    const from = contour[index] as SurfacePoint
    const to = contour[(index + 1) % count] as SurfacePoint
    return Math.abs(to[0] - from[0]) >= minLong && Math.abs(to[1] - from[1]) <= 0.5
  }
  let firstLong = -1
  for (let index = 0; index < count; index++) {
    if (longEdge(index)) {
      firstLong = index
      break
    }
  }
  if (firstLong < 0) return null

  const arcs: SurfacePoint[][] = []
  let current: SurfacePoint[] | null = null
  for (let step = 1; step <= count; step++) {
    const index = (firstLong + step) % count
    const from = contour[index] as SurfacePoint
    const to = contour[(index + 1) % count] as SurfacePoint
    if (longEdge(index)) {
      if (current) arcs.push(current)
      current = null
      continue
    }
    if (!current) current = [from]
    current.push(to)
  }
  if (current) arcs.push(current)
  if (arcs.length !== 2) return null

  const meanX = (arc: SurfacePoint[]): number =>
    arc.reduce((sum, point) => sum + point[0], 0) / arc.length
  arcs.sort((a, b) => meanX(a) - meanX(b))
  return { start: arcs[0] as SurfacePoint[], end: arcs[1] as SurfacePoint[] }
}

function dedupePoints(points: SurfacePoint[]): SurfacePoint[] {
  const merged: SurfacePoint[] = []
  for (const point of points) {
    const last = merged[merged.length - 1]
    if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) > 0.01) merged.push(point)
  }
  return merged
}

/** Drops vertices that lie on the straight line between their neighbours. */
function simplifyCollinear(points: SurfacePoint[]): SurfacePoint[] {
  const out: SurfacePoint[] = []
  for (const point of points) {
    while (out.length >= 2) {
      const a = out[out.length - 2] as SurfacePoint
      const b = out[out.length - 1] as SurfacePoint
      const cross = (b[0] - a[0]) * (point[1] - b[1]) - (b[1] - a[1]) * (point[0] - b[0])
      if (Math.abs(cross) > 1e-6) break
      out.pop()
    }
    out.push(point)
  }
  return out
}

function inRange(points: SurfacePoint[], min: number, max: number): SurfacePoint[] | null {
  if (points.length < 2) return null
  const stations = points.map(([x]) => x)
  if (Math.min(...stations) < min - 0.5 || Math.max(...stations) > max + 0.5) return null
  return points
}

/** Along-coordinate on a face end polyline at across-coordinate `y`. */
function alongAt(points: SurfacePoint[], y: number): number {
  let nearest = points[0] as SurfacePoint
  let nearestDist = Infinity
  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index] as SurfacePoint
    const to = points[index + 1] as SurfacePoint
    const span = to[1] - from[1]
    if (Math.abs(span) < 1e-9) {
      const dist = Math.abs(y - from[1])
      if (dist < nearestDist) {
        nearest = from
        nearestDist = dist
      }
      continue
    }
    const t = (y - from[1]) / span
    if (t >= -1e-6 && t <= 1 + 1e-6)
      return from[0] + Math.min(1, Math.max(0, t)) * (to[0] - from[0])
    const end = t < 0 ? from : to
    const dist = Math.abs(y - end[1])
    if (dist < nearestDist) {
      nearest = end
      nearestDist = dist
    }
  }
  return nearest[0]
}

function alongSlope(points: SurfacePoint[], y: number): number {
  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index] as SurfacePoint
    const to = points[index + 1] as SurfacePoint
    const span = to[1] - from[1]
    if (Math.abs(span) < 1e-9) continue
    const t = (y - from[1]) / span
    if (t >= -0.05 && t <= 1.05) return (to[0] - from[0]) / span
  }
  return 0
}

function bevelOnArc(contour: NcContour, arc: SurfacePoint[]): number {
  let angle = 0
  contour.points.forEach((point, index) => {
    const onArc = arc.some(([along, y]) => Math.hypot(point[0] - along, point[1] - y) < 0.5)
    if (!onArc) return
    const value = contour.bevels[index]?.[0] ?? 0
    if (Math.abs(value) > Math.abs(angle)) angle = value
  })
  return angle
}

/**
 * A tube end cut is the mitre plane meeting the outer skin. On each flat that is a straight
 * line in the development; through a corner it is the unrolled cylinder intersection
 * `along = A0 + r·m0·sinθ + (A1 − A0 − r·m0)·(1 − cosθ)`. A square face whose AK line is
 * short of the neighbouring mitre by `wall·tan(bevel)` is the inner/root line — the outer
 * trim snaps onto the mitre.
 */
function developTubeEnd(
  layout: UnrolledLayout,
  contours: NcContour[],
  length: number,
  end: 'start' | 'end',
  wall: number,
): SurfacePoint[] | null {
  const order: NcFace[] = ['v', 'o', 'h', 'u']
  const cuts = new Map<NcFace, SurfacePoint[]>()
  const angles = new Map<NcFace, number>()
  let radius = 0
  for (const face of order) {
    const region = layout.faces[face]
    const contour = contours.find((entry) => entry.kind === 'outer' && entry.face === face)
    if (!region || !contour || !(region.radius && region.radius > 0)) return null
    radius = region.radius
    const ends = splitContourEnds(densifyContour(contour), length)
    if (!ends) return null
    const arc = (end === 'start' ? ends.start : ends.end).map(
      (point) => [point[0], point[1]] as SurfacePoint,
    )
    cuts.set(face, arc)
    angles.set(face, bevelOnArc(contour, arc))
  }
  const web = layout.faces.v
  if (!web || web.start >= 0 || radius >= (web.width ?? web.length) / 2) return null

  const boundaryY = (face: NcFace, side: 'low' | 'high'): number => {
    const region = layout.faces[face]
    const width = region?.width ?? region?.length ?? 0
    if (!region) return 0
    if (side === 'high') return region.reversed ? 0 : width
    return region.reversed ? width : 0
  }
  const shift = (face: NcFace, delta: number): void => {
    const points = cuts.get(face)
    if (!points) return
    cuts.set(
      face,
      points.map(([along, y]) => [along + delta, y]),
    )
  }
  if (wall > 0) {
    for (const face of order) {
      const points = cuts.get(face)
      if (!points) continue
      const alongs = points.map(([along]) => along)
      if (Math.max(...alongs) - Math.min(...alongs) > 0.05) continue
      const deltas: number[] = []
      for (const side of ['low', 'high'] as const) {
        const index = order.indexOf(face)
        const neighbor = order[
          (index + (side === 'high' ? 1 : order.length - 1)) % order.length
        ] as NcFace
        const neighborSide = side === 'high' ? 'low' : 'high'
        const mine = alongAt(points, boundaryY(face, side))
        const theirs = alongAt(cuts.get(neighbor) ?? [], boundaryY(neighbor, neighborSide))
        const angle = Math.max(Math.abs(angles.get(face) ?? 0), Math.abs(angles.get(neighbor) ?? 0))
        const expected = wall * Math.tan((angle * Math.PI) / 180)
        const delta = theirs - mine
        if (expected > 0.2 && Math.abs(Math.abs(delta) - expected) < 0.4) deltas.push(delta)
      }
      if (deltas.length > 0 && deltas.every((delta) => Math.abs(delta - (deltas[0] ?? 0)) < 0.4)) {
        shift(face, deltas[0] ?? 0)
      }
    }
  }

  const tangentY = (face: NcFace, side: 'low' | 'high'): number => {
    const region = layout.faces[face]
    const width = region?.width ?? region?.length ?? 0
    const corner = region?.radius ?? 0
    if (!region) return 0
    const highY = region.reversed ? corner : width - corner
    const lowY = region.reversed ? width - corner : corner
    return side === 'high' ? highY : lowY
  }
  const tangent = (
    face: NcFace,
    side: 'low' | 'high',
  ): { station: number; along: number; slope: number } => {
    const region = layout.faces[face]
    const y = tangentY(face, side)
    const raw = rawStationFor(layout, face, y) ?? 0
    const station = raw < -1e-6 ? raw + layout.seam : raw
    const points = cuts.get(face) ?? []
    const dAlong = alongSlope(points, y)
    return {
      station,
      along: alongAt(points, y),
      slope: region?.reversed ? -dAlong : dAlong,
    }
  }
  const appendArc = (
    points: SurfacePoint[],
    from: { station: number; along: number; slope: number },
    to: { station: number; along: number },
  ): void => {
    const steps = 36
    for (let step = 1; step <= steps; step++) {
      const theta = ((Math.PI / 2) * step) / steps
      const along =
        from.along +
        radius * from.slope * Math.sin(theta) +
        (to.along - from.along - radius * from.slope) * (1 - Math.cos(theta))
      points.push([from.station + radius * theta, along])
    }
  }

  const centerY = (web.width ?? web.length) / 2
  const centerAlong = alongAt(cuts.get('v') ?? [], centerY)
  const points: SurfacePoint[] = [[0, centerAlong]]
  let cursor = tangent('v', 'high')
  points.push([cursor.station, cursor.along])
  for (const face of ['o', 'h', 'u', 'v'] as const) {
    const low = tangent(face, 'low')
    appendArc(points, cursor, low)
    if (face === 'v') {
      points.push([layout.seam, centerAlong])
      break
    }
    cursor = tangent(face, 'high')
    points.push([cursor.station, cursor.along])
  }
  const simplified = simplifyCollinear(dedupePoints(points))
  for (let index = 1; index < simplified.length; index++) {
    const previous = simplified[index - 1] as SurfacePoint
    const point = simplified[index] as SurfacePoint
    if (Math.abs(point[0] - previous[0]) > layout.seam / 2) return null
  }
  return inRange(simplified, 0, layout.seam)
}

/**
 * Develops one end cut onto the unrolled surface. Returns null when the NC does not give a
 * complete shaped boundary; the writer then falls back to a straight cut.
 */
export function developEndCut(
  layout: UnrolledLayout,
  contours: NcContour[],
  length: number,
  end: 'start' | 'end',
  wall = 0,
): SurfacePoint[] | null {
  if (layout.origin === 'zero') {
    const tube = developTubeEnd(layout, contours, length, end, wall)
    if (tube) return tube
  }
  // Raw stations are unwrapped so a zero-origin tube's `v` face can straddle the seam.
  const arcs: SurfacePoint[][] = []
  // Follow the developed perimeter, not the DSTV letter order: at a station shared by two faces
  // (a step in a notched/offset end) the stable sort below must keep the incoming face first.
  const faces = (['v', 'o', 'u', 'h'] as NcFace[])
    .filter((face) => layout.faces[face])
    .sort((a, b) => (layout.faces[a]?.start ?? 0) - (layout.faces[b]?.start ?? 0))
  for (const face of faces) {
    const contour = contours.find((entry) => entry.kind === 'outer' && entry.face === face)
    if (!contour) return null
    const ends = splitContourEnds(densifyContour(contour), length)
    if (!ends) return null
    const arc = end === 'start' ? ends.start : ends.end
    const developed: SurfacePoint[] = []
    for (const [x, y] of arc) {
      const station = rawStationFor(layout, face, y)
      if (station == null) continue
      developed.push([station, x])
    }
    if (developed.length < 2) return null
    arcs.push(developed)
  }
  if (arcs.length === 0) return null

  if (layout.origin === 'centered') {
    // A notched end is not a function of station (two vertices can share a station), so sorting
    // by station moves its steps. Preserve the per-face contour order for those ends only.
    if (hasRepeatedStation(arcs)) {
      const stitched = stitchEndArcs(arcs)
      if (stitched) return inRange(dedupePoints(stitched), -layout.seam / 2, layout.seam / 2)
    }
    const points = simplifyCollinear(dedupePoints(arcs.flat().sort((a, b) => a[0] - b[0])))
    return inRange(points, -layout.seam / 2, layout.seam / 2)
  }

  // Zero origin: split at the seam (raw station 0), then concatenate 0…max and min…seam.
  const seam = layout.seam
  const right: SurfacePoint[] = []
  const left: SurfacePoint[] = []
  let alongAtSeam: number | null = null
  for (const arc of arcs) {
    for (let index = 0; index < arc.length; index++) {
      const point = arc[index] as SurfacePoint
      const [raw, along] = point
      if (raw > 1e-9) right.push([raw, along])
      else if (raw < -1e-9) left.push([raw + seam, along])
      else {
        right.push([0, along])
        left.push([seam, along])
        alongAtSeam = along
      }
      const next = arc[index + 1]
      if (!next) continue
      const [nextRaw, nextAlong] = next
      if ((raw < 0 && nextRaw > 0) || (raw > 0 && nextRaw < 0)) {
        const t = -raw / (nextRaw - raw)
        alongAtSeam = along + t * (nextAlong - along)
      }
    }
  }
  if (alongAtSeam == null) return null
  right.push([0, alongAtSeam])
  left.push([seam, alongAtSeam])
  right.sort((a, b) => a[0] - b[0])
  left.sort((a, b) => a[0] - b[0])
  const points = simplifyCollinear(dedupePoints([...dedupePoints(right), ...dedupePoints(left)]))
  return inRange(points, 0, seam)
}

function hasRepeatedStation(arcs: SurfacePoint[][]): boolean {
  const seen = new Map<string, number>()
  for (const arc of arcs) {
    for (const [station, along] of arc) {
      const key = station.toFixed(6)
      const existing = seen.get(key)
      if (existing != null && Math.abs(existing - along) > 1e-6) return true
      seen.set(key, along)
    }
  }
  return false
}

function markPointDistance(a: SurfacePoint, b: SurfacePoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/**
 * Joins the per-face end arcs by their shared endpoints, preserving the contour order. Sorting
 * all points by station destroys small steps at a notched end: two vertices at the same station
 * can belong to different sides of a notch. Returns null if the pieces do not meet.
 */
function stitchEndArcs(arcs: SurfacePoint[][]): SurfacePoint[] | null {
  const remaining = arcs.filter((arc) => arc.length > 0).map((arc) => arc.slice())
  // Start at the leftmost piece so the path runs left-to-right across the developed net.
  remaining.sort(
    (a, b) =>
      Math.min(...a.map(([station]) => station)) - Math.min(...b.map(([station]) => station)),
  )
  const path = remaining.shift()
  if (!path) return null
  if ((path[0] as SurfacePoint)[0] > (path[path.length - 1] as SurfacePoint)[0]) {
    path.reverse()
  }
  while (remaining.length > 0) {
    const head = path[0] as SurfacePoint
    const tail = path[path.length - 1] as SurfacePoint
    let best: { index: number; distance: number; reverse: boolean; atTail: boolean } | null = null
    for (let index = 0; index < remaining.length; index++) {
      const arc = remaining[index] as SurfacePoint[]
      const first = arc[0] as SurfacePoint
      const last = arc[arc.length - 1] as SurfacePoint
      const options = [
        { distance: markPointDistance(tail, first), reverse: false, atTail: true },
        { distance: markPointDistance(tail, last), reverse: true, atTail: true },
        { distance: markPointDistance(head, last), reverse: false, atTail: false },
        { distance: markPointDistance(head, first), reverse: true, atTail: false },
      ]
      for (const option of options) {
        if (!best || option.distance < best.distance) best = { index, ...option }
      }
    }
    if (!best || best.distance > 10) return null
    const arc = remaining.splice(best.index, 1)[0] as SurfacePoint[]
    if (best.reverse) arc.reverse()
    if (best.atTail) path.push(...arc.slice(1))
    else path.unshift(...arc.slice(0, -1))
  }
  return dedupePoints(path)
}

/**
 * Splits a developed polyline where it crosses a zero-origin layout's seam, so it never draws a
 * line straight across the unrolled net.
 */
function splitAtSeam(points: SurfacePoint[], layout: UnrolledLayout): SurfacePoint[][] {
  if (layout.origin === 'centered') return [points]
  const seam = layout.seam
  const runs: SurfacePoint[][] = []
  let run: SurfacePoint[] = []
  for (let index = 0; index < points.length; index++) {
    const point = points[index] as SurfacePoint
    const previous = points[index - 1]
    if (previous && Math.abs(point[0] - previous[0]) > seam / 2) {
      // Unwrap the pair so the transition is monotonic, then interpolate the along-coordinate
      // where the line reaches the seam. The two runs meet at station `seam` / `0`.
      const from = previous[0]
      let to = point[0]
      if (to - from > seam / 2) to -= seam
      else if (from - to > seam / 2) to += seam
      const target = from < to ? seam : 0
      const span = to - from
      const t = Math.abs(span) < 1e-9 ? 0 : (target - from) / span
      const along = previous[1] + (point[1] - previous[1]) * Math.min(1, Math.max(0, t))
      if (run.length > 0) {
        run.push([target, along])
        if (run.length >= 2) runs.push(dedupePoints(run))
      }
      run = [[target === seam ? 0 : seam, along], point]
      continue
    }
    run.push(point)
  }
  if (run.length >= 2) runs.push(dedupePoints(run))
  return runs
}

/** Map a point in face coordinates `(along, across)` onto the unrolled surface. */
function developFacePoint(
  layout: UnrolledLayout,
  face: NcFace,
  point: { X: number; Y: number },
  alongOffset: number,
): SurfacePoint | null {
  const station = stationFor(layout, face, point.Y)
  if (station == null) return null
  return [station, point.X + alongOffset]
}

/**
 * Develops the **NC's face-space geometry** onto the unrolled NCEP surface. This is the NC half of
 * the shared surface layer: every contour/hole/mark keeps its face coordinates and only the
 * `across` coordinate is mapped to a station. The caller supplies the already-parsed
 * {@link NcGeometry}.
 */
export function developNcGeometry(
  nc: NcGeometry,
  layout: UnrolledLayout,
  options: DevelopNcOptions,
): SurfaceDevelopment {
  const holes: NcexHole[] = []
  for (const hole of nc.holes) {
    if (!(hole.diameter > 0)) continue
    const station = stationFor(layout, hole.face, hole.y)
    if (station == null) continue
    holes.push({
      station,
      along: hole.x,
      radius: hole.diameter / 2,
      face: hole.face,
      thickness: options.thicknessForFace?.(hole.face),
    })
  }

  const marks: NcexMark[] = []
  const seenMarks = new Set<string>()
  for (const mark of nc.marks) {
    const region = layout.faces[mark.face]
    if (!region) continue
    const points: SurfacePoint[] = []
    let developed = true
    for (const [x, y] of mark.points) {
      const station = stationFor(layout, mark.face, y)
      if (station == null) {
        developed = false
        break
      }
      points.push([station, x])
    }
    if (!developed || points.length === 0) continue
    // DSTV often carries the same mark twice (KO punch + PU scribe); keep one.
    const signature = `${mark.text?.value ?? ''}|${points
      .map(([station, along]) => `${station.toFixed(3)},${along.toFixed(3)}`)
      .join(';')}`
    if (seenMarks.has(signature)) continue
    seenMarks.add(signature)
    marks.push({
      kind: mark.kind,
      points,
      text: mark.text ? { ...mark.text, reversed: region.reversed } : undefined,
    })
  }

  const cuts: NcexCut[] = []
  for (const contour of nc.contours) {
    if (!layout.faces[contour.face]) continue
    const points: SurfacePoint[] = []
    let developed = true
    for (const [x, y] of densifyContour(contour)) {
      const station = stationFor(layout, contour.face, y)
      if (station == null) {
        developed = false
        break
      }
      points.push([station, x])
    }
    if (!developed || points.length < 2) continue
    for (const run of splitAtSeam(points, layout)) cuts.push({ kind: contour.kind, points: run })
  }

  const wall = options.wall ?? 0
  const startCut = developEndCut(layout, nc.contours, options.length, 'start', wall) ?? undefined
  const endCut = developEndCut(layout, nc.contours, options.length, 'end', wall) ?? undefined
  return { cuts, holes, marks, startCut, endCut }
}

interface SurfaceSegment {
  a: SurfacePoint
  b: SurfacePoint
}

function samePoint(a: SurfacePoint, b: SurfacePoint, tolerance = 0.05): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance
}

/** Greedily joins segments that share endpoints into polylines (per face). */
function chainSegments(segments: SurfaceSegment[]): SurfacePoint[][] {
  const remaining = [...segments]
  const chains: SurfacePoint[][] = []
  while (remaining.length > 0) {
    const first = remaining.shift() as SurfaceSegment
    const chain: SurfacePoint[] = [first.a, first.b]
    let matched = true
    while (matched && remaining.length > 0) {
      matched = false
      const tail = chain[chain.length - 1] as SurfacePoint
      for (let index = 0; index < remaining.length; index++) {
        const segment = remaining[index] as SurfaceSegment
        if (samePoint(tail, segment.a)) {
          chain.push(segment.b)
        } else if (samePoint(tail, segment.b)) {
          chain.push(segment.a)
        } else {
          continue
        }
        remaining.splice(index, 1)
        matched = true
        break
      }
    }
    chains.push(dedupePoints(chain))
  }
  return chains
}

/**
 * Develops per-face STEP projections (`projectCutEdgesToFaces`) onto the unrolled surface. The
 * projection already gives the cut plane's trace in `(along, across)`; this only maps `across` to
 * a station and joins the projected segments into continuous cut polylines.
 */
export function developFaceSegments(
  layout: UnrolledLayout,
  face: NcFace,
  segments: FaceSegment[],
  options: DevelopStepOptions = {},
): NcexCut[] {
  const alongOffset = options.alongOffset ?? 0
  const developed: SurfaceSegment[] = []
  for (const segment of segments) {
    const a = developFacePoint(layout, face, segment.a, alongOffset)
    const b = developFacePoint(layout, face, segment.b, alongOffset)
    if (!a || !b || samePoint(a, b, 0.01)) continue
    developed.push({ a, b })
  }
  const cuts: NcexCut[] = []
  for (const chain of chainSegments(developed)) {
    for (const run of splitAtSeam(chain, layout)) cuts.push({ kind: 'outer', points: run })
  }
  return cuts
}

export interface StepSurfaceInput {
  /** B-rep faces already seated into the model/canonical frame. */
  faces: SeatedBrepFace[]
  /** Stock section outline in that frame. */
  section: [number, number][]
  frame: NcFaceFrame
  layout: UnrolledLayout
  xAxis: Vec3
  yAxis: Vec3
  memberAxis: Vec3
}

/**
 * The STEP half of the shared surface layer: take the real part's cut edges, project them onto the
 * **stock face planes** (`projectCutEdgesToFaces`), then develop those face-space traces onto the
 * NCEP surface. Holes/marks are not inferred here yet; the STEP path starts with the cut boundary.
 */
export function developStepCutEdges(
  input: StepSurfaceInput,
  options: DevelopStepOptions = {},
): NcexCut[] {
  return developProjectedStepEdges(input, options, false)
}

/**
 * STEP → IR variant: develop only the **real B-rep rim** edges. Unlike
 * {@link developStepCutEdges}, it never projects a cut plane onto the nominal face plane, so the
 * IR cannot show a line that is absent from the STEP.
 */
export function developStepRimEdges(
  input: StepSurfaceInput,
  options: DevelopStepOptions = {},
): NcexCut[] {
  return developProjectedStepEdges(input, options, true)
}

function developProjectedStepEdges(
  input: StepSurfaceInput,
  options: DevelopStepOptions,
  preserveRim: boolean,
): NcexCut[] {
  const projected = projectCutEdgesToFaces(
    input.faces,
    input.section,
    input.frame,
    input.xAxis,
    input.yAxis,
    input.memberAxis,
    { radius: options.radius ?? 0, preserveRim },
  )
  const cuts: NcexCut[] = []
  for (const face of ['v', 'o', 'u', 'h'] as NcFace[]) {
    cuts.push(...developFaceSegments(input.layout, face, projected[face], options))
  }
  return cuts
}
