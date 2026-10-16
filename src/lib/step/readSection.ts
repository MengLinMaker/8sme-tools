import { Matrix4, Quaternion, Vector3 } from 'three'
import {
  inferSectionFromCross,
  type MeasuredSection,
  type SectionGuess,
} from '@/lib/sections/detect'
import { principalAxes } from '@/lib/sections/pca'
import { ensureOc } from './occInit'

/**
 * Reads a part's **cross-section** out of its real STEP geometry, for the STEP-only path where no
 * NC / drawing carries a profile code.
 *
 * The part is a prismatic member, so a thin slab cut perpendicular to its length exposes the raw
 * stock section (outer outline + any enclosed voids). Intersecting with a ~1 mm slab at a few
 * stations along the length and keeping the sample with the largest outer area avoids a drilled
 * hole or a local cutout at any one station: the stock section is the most material the beam
 * presents.
 *
 * The extracted outline is handed to {@link file://./../sections/detect.ts} to name the section.
 */

interface Vec3 {
  x: number
  y: number
  z: number
}

interface EdgeLike {
  geomType: string
  length: number
  startPoint: Vec3
  endPoint: Vec3
  pointAt(position?: number): Vec3
  delete(): void
}

interface WireLike {
  edges: EdgeLike[]
  delete(): void
}

interface FaceLike {
  geomType: string
  clone(): FaceLike
  outerWire(): WireLike
  innerWires(): WireLike[]
  delete(): void
}

interface BoxLike {
  bounds: [number[], number[]]
}

/** The subset of a replicad `Shape3D` / imported STEP shape this module uses. */
export interface SectionShape {
  boundingBox: BoxLike
  faces: FaceLike[]
  mesh(options?: { tolerance?: number; angularTolerance?: number }): { vertices: number[] }
  clone(): SectionShape
  translate(x: number, y: number, z: number): SectionShape
  /** `angle` in degrees, about `direction` through `position`. Returns the transformed shape. */
  rotate(angle: number, position?: number[], direction?: number[]): SectionShape
  intersect(tool: SectionShape): SectionShape
  delete(): void
}

/** Curve sampling: ~1 sample per 1.5 mm, clamped, so arcs do not read faceted. */
const SAMPLE_MM = 1.5
const MIN_SAMPLES = 12
const MAX_SAMPLES = 72

function sampleEdge(edge: EdgeLike): Vec3[] {
  if (edge.geomType === 'LINE') return [edge.startPoint, edge.endPoint]
  const length = edge.length
  const steps = Number.isFinite(length)
    ? Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.round(length / SAMPLE_MM)))
    : 24
  const points: Vec3[] = []
  for (let i = 0; i <= steps; i++) points.push(edge.pointAt(i / steps))
  return points
}

function component(point: Vec3, axis: number): number {
  return axis === 0 ? point.x : axis === 1 ? point.y : point.z
}

/**
 * Projects a wire's edges into the cross-section plane (the two non-length axes), walking them in
 * order and flipping any edge that runs against the traversal — an edge is stored with its own
 * direction, so a reversed edge would zig-zag the polygon and wreck its area.
 */
function wireToPoints(wire: WireLike, crossA: number, crossB: number): [number, number][] {
  const points: [number, number][] = []
  for (const edge of wire.edges) {
    let sampled = sampleEdge(edge).map((point): [number, number] => [
      component(point, crossA),
      component(point, crossB),
    ])
    const last = points[points.length - 1]
    if (last && sampled.length >= 2) {
      const first = sampled[0] as [number, number]
      const end = sampled[sampled.length - 1] as [number, number]
      const toFirst = (first[0] - last[0]) ** 2 + (first[1] - last[1]) ** 2
      const toEnd = (end[0] - last[0]) ** 2 + (end[1] - last[1]) ** 2
      if (toEnd < toFirst) sampled = sampled.reverse()
    }
    for (const value of sampled) {
      const previous = points[points.length - 1]
      if (
        previous &&
        Math.abs(previous[0] - value[0]) < 1e-6 &&
        Math.abs(previous[1] - value[1]) < 1e-6
      ) {
        continue
      }
      points.push(value)
    }
    edge.delete()
  }
  wire.delete()
  return points
}

/** Rotates 2-D points by `angle` radians. */
function rotatePoints(points: [number, number][], angle: number): [number, number][] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return points.map(([x, y]) => [x * c - y * s, x * s + y * c] as [number, number])
}

/** Area of a point set's axis-aligned bounding box. */
function bboxArea(points: [number, number][]): number {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return (maxX - minX) * (maxY - minY)
}

/**
 * Rotates a section in-plane so its outline sits square to the axes (minimum-area bounding box).
 * A slice of a rotated part lands rotated in-plane, whose bounding box does not match the
 * catalogue's axis-aligned callout — normalising it restores the nominal `d × b` before matching.
 */
function normalizeSection(section: MeasuredSection): MeasuredSection {
  let bestAngle = 0
  let bestArea = Number.POSITIVE_INFINITY
  const edges = section.outer
  for (let i = 0, j = edges.length - 1; i < edges.length; j = i++) {
    const angle = Math.atan2(
      (edges[i] as [number, number])[1] - (edges[j] as [number, number])[1],
      (edges[i] as [number, number])[0] - (edges[j] as [number, number])[0],
    )
    const area = bboxArea(rotatePoints(edges, -angle))
    if (area < bestArea - 1e-6) {
      bestArea = area
      bestAngle = angle
    }
  }
  if (bestAngle === 0) return section
  return {
    outer: rotatePoints(section.outer, -bestAngle),
    holes: section.holes?.map((hole) => rotatePoints(hole, -bestAngle)),
  }
}

function polygonArea(points: [number, number][]): number {
  let twice = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    twice += points[j][0] * points[i][1] - points[i][0] * points[j][1]
  }
  return Math.abs(twice) / 2
}

function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as [number, number]
    const [xj, yj] = polygon[j] as [number, number]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Grid resolution (mm) for the additive merge of slice silhouettes. */
const UNION_CELL_MM = 1.5

/** Marks every grid cell whose centre lies inside `polygon` as `value`. */
function fillPolygon(
  grid: Uint8Array,
  cols: number,
  rows: number,
  originX: number,
  originY: number,
  cell: number,
  polygon: [number, number][],
  value: number,
): void {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of polygon) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const i0 = Math.max(0, Math.floor((minX - originX) / cell))
  const i1 = Math.min(cols - 1, Math.ceil((maxX - originX) / cell))
  const j0 = Math.max(0, Math.floor((minY - originY) / cell))
  const j1 = Math.min(rows - 1, Math.ceil((maxY - originY) / cell))
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (pointInPolygon(originX + (i + 0.5) * cell, originY + (j + 0.5) * cell, polygon)) {
        grid[j * cols + i] = value
      }
    }
  }
}

/** Traces the outer + inner loops of a binary occupancy grid (boundary-edge walk). */
function occupancyOutline(occupancy: Uint8Array, cols: number, rows: number): [number, number][][] {
  const occupied = (i: number, j: number): boolean =>
    i >= 0 && i < cols && j >= 0 && j < rows && occupancy[j * cols + i] === 1
  // Directed boundary edges (cell-corner coords), CCW around occupied cells (+1 corner in x/y).
  const edges = new Map<string, [number, number]>()
  const add = (i1: number, j1: number, i2: number, j2: number): void => {
    edges.set(`${i1},${j1}`, [i2, j2])
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!occupied(i, j)) continue
      if (!occupied(i, j - 1)) add(i, j, i + 1, j)
      if (!occupied(i, j + 1)) add(i + 1, j + 1, i, j + 1)
      if (!occupied(i - 1, j)) add(i, j + 1, i, j)
      if (!occupied(i + 1, j)) add(i + 1, j, i + 1, j + 1)
    }
  }
  const loops: [number, number][][] = []
  const visited = new Set<string>()
  for (const start of edges.keys()) {
    if (visited.has(start)) continue
    const loop: [number, number][] = []
    let current: string | undefined = start
    while (current && !visited.has(current)) {
      visited.add(current)
      const [i, j] = current.split(',').map(Number) as [number, number]
      loop.push([i, j])
      const next = edges.get(current)
      current = next ? `${next[0]},${next[1]}` : undefined
    }
    if (loop.length >= 4) loops.push(loop)
  }
  return loops
}

/**
 * Additive merge of several cross-section slices into one **stock silhouette**: each slice's solid
 * region (outer minus its voids) is rasterised and OR-ed together, then the merged occupancy is
 * traced back to an outline. So the stock section survives even when no single slice shows all of
 * it, and a hollow's void is preserved as long as it is open at every station.
 */
function unionSections(sections: MeasuredSection[]): MeasuredSection | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const section of sections) {
    for (const [x, y] of section.outer) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) return null
  const cols = Math.max(1, Math.ceil((maxX - minX) / UNION_CELL_MM) + 1)
  const rows = Math.max(1, Math.ceil((maxY - minY) / UNION_CELL_MM) + 1)
  const occupancy = new Uint8Array(cols * rows)
  const slice = new Uint8Array(cols * rows)
  for (const section of sections) {
    slice.fill(0)
    fillPolygon(slice, cols, rows, minX, minY, UNION_CELL_MM, section.outer, 1)
    for (const hole of section.holes ?? []) {
      fillPolygon(slice, cols, rows, minX, minY, UNION_CELL_MM, hole, 0)
    }
    for (let i = 0; i < occupancy.length; i++) if (slice[i]) occupancy[i] = 1
  }
  const loops = occupancyOutline(occupancy, cols, rows)
    .map((loop) =>
      loop.map(
        ([i, j]) => [minX + i * UNION_CELL_MM, minY + j * UNION_CELL_MM] as [number, number],
      ),
    )
    .sort((a, b) => polygonArea(b) - polygonArea(a))
  const outer = loops[0]
  if (!outer) return null
  const holes = loops.slice(1).filter((loop) => pointInPolygon(loop[0][0], loop[0][1], outer))
  return { outer, holes: holes.length > 0 ? holes : undefined }
}

/** The largest planar face of a slab's end caps is the cross-section; its wires are the outline. */
function sectionFromSlab(
  slab: SectionShape,
  crossA: number,
  crossB: number,
): MeasuredSection | null {
  let best: { area: number; section: MeasuredSection } | null = null
  for (const face of slab.faces) {
    if (face.geomType !== 'PLANE') continue
    // A fresh clone per wire access: deleting a clone's child edges invalidates that clone, and
    // mesh.ts clones the same way (reusing one face after its edges are freed throws).
    const outer = wireToPoints(face.clone().outerWire(), crossA, crossB)
    if (outer.length < 3) continue
    const area = polygonArea(outer)
    if (!best || area > best.area) {
      const holes: [number, number][][] = []
      for (const inner of face.clone().innerWires()) {
        const loop = wireToPoints(inner, crossA, crossB)
        if (loop.length >= 3) holes.push(loop)
      }
      best = { area, section: { outer, holes: holes.length > 0 ? holes : undefined } }
    }
  }
  return best?.section ?? null
}

/** Reads the cross-section from a 1 mm slab perpendicular to `axis`, at one station. */
function slabSection(
  shape: SectionShape,
  makeBox: (a: number[], b: number[]) => SectionShape,
  axis: number,
  bounds: { min: number[]; max: number[]; size: number[]; centre: number[] },
  fraction: number,
): MeasuredSection | null {
  const { min, size, centre } = bounds
  const crossAxes = [0, 1, 2].filter((candidate) => candidate !== axis)
  const crossA = crossAxes[0] as number
  const crossB = crossAxes[1] as number
  const dims = [0, 0, 0]
  for (const cross of crossAxes) dims[cross] = (size[cross] as number) + 40
  dims[axis] = 1
  const station = (min[axis] as number) + (size[axis] as number) * fraction
  const origin = [0, 1, 2].map((candidate) =>
    candidate === axis
      ? station - 0.5
      : (centre[candidate] as number) - (dims[candidate] as number) / 2,
  )
  const far = [0, 1, 2].map(
    (candidate) => (origin[candidate] as number) + (dims[candidate] as number),
  )

  const slab = makeBox(origin as number[], far as number[])
  let section: SectionShape
  try {
    section = shape.intersect(slab)
  } catch {
    // an empty intersection (a station beyond a coped end)
    slab.delete()
    return null
  }
  try {
    return sectionFromSlab(section, crossA, crossB)
  } finally {
    section.delete()
    slab.delete()
  }
}

/**
 * The part's cross-section is only exposed by slicing **perpendicular to the member axis** — but a
 * short part's member axis need not be its longest bounding-box extent (an angle cut to 60 mm has
 * 75 mm legs), so the axis cannot be read off the bbox alone. Slice along all three axes and return
 * one candidate section per axis; the caller's match (which knows the stocked sections) tells the
 * member axis from a wrong-axis slice, which lines up with no section. It returns **every** station's
 * slice along all three axes — the caller matches them all and keeps the best, so the stock section
 * is found wherever it survives rather than only at one "representative" station.
 *
 * The stations span the **ends** as well as the middle. A cut/gusset piece keeps the raw stock
 * section only near its square-cut ends while the middle is notched/coped; sampling only the middle
 * (or only the largest slice) reads the cut, not the stock.
 */
export function measureSections(
  shape: SectionShape,
  makeBox: (a: number[], b: number[]) => SectionShape,
  fractions: number[] = [0.5],
): MeasuredSection[] {
  const [min, max] = shape.boundingBox.bounds
  const bounds = {
    min: min as number[],
    max: max as number[],
    size: [0, 1, 2].map((axis) => (max[axis] as number) - (min[axis] as number)),
    centre: [0, 1, 2].map((axis) => ((min[axis] as number) + (max[axis] as number)) / 2),
  }

  const sections: MeasuredSection[] = []
  for (const axis of [0, 1, 2]) {
    const stations: MeasuredSection[] = []
    for (const fraction of fractions) {
      const measured = slabSection(shape, makeBox, axis, bounds, fraction)
      if (measured) stations.push(measured)
    }
    if (stations.length === 0) continue
    // The raw stations keep their exact outlines (the merge rasterises, losing ~a cell of accuracy,
    // which can tip an exact size-variant match). The additive merge of all stations is added on top
    // so a stock silhouette that no single station shows is still available.
    for (const station of stations) sections.push(normalizeSection(station))
    if (stations.length > 1) {
      const merged = unionSections(stations)
      if (merged) sections.push(normalizeSection(merged))
    }
  }
  return sections
}

/** `{ angle (deg), axis }` for a rotation quaternion, for replicad's `rotate`. */
function axisAngle(quaternion: Quaternion): { angleDeg: number; axis: [number, number, number] } {
  const halfSin = Math.sqrt(Math.max(0, 1 - quaternion.w * quaternion.w))
  return {
    angleDeg: (2 * Math.acos(Math.min(1, Math.max(-1, quaternion.w))) * 180) / Math.PI,
    axis:
      halfSin > 1e-6
        ? [quaternion.x / halfSin, quaternion.y / halfSin, quaternion.z / halfSin]
        : [0, 0, 1],
  }
}

/** Applies a rotation quaternion to a clone of the shape about `centre`. */
function alignRotated(
  shape: SectionShape,
  quaternion: Quaternion,
  centre: [number, number, number],
): SectionShape {
  const { angleDeg, axis } = axisAngle(quaternion)
  return shape
    .clone()
    .translate(-centre[0], -centre[1], -centre[2])
    .rotate(angleDeg, [0, 0, 0], axis)
}

/** Rotates a clone of the shape into its principal-axis frame, so world X/Y/Z slice the section. */
function alignToPrincipalAxes(shape: SectionShape, vertices: number[]): SectionShape | null {
  const frame = principalAxes(vertices)
  if (!frame) return null
  const basis = new Matrix4().makeBasis(
    new Vector3(...frame.axes[0]),
    new Vector3(...frame.axes[1]),
    new Vector3(...frame.axes[2]),
  )
  const quaternion = new Quaternion().setFromRotationMatrix(new Matrix4().copy(basis).invert())
  return alignRotated(shape, quaternion, frame.centre)
}

/** The highest-scoring guess among candidate sections. */
function bestGuess(sections: MeasuredSection[]): SectionGuess | null {
  let best: SectionGuess | null = null
  for (const measured of sections) {
    const guess = inferSectionFromCross(measured)
    if (guess && (!best || guess.score > best.score)) best = guess
  }
  return best
}

/** The measured outline area behind a guess — a prism's cut area, used only to break score ties. */
function guessOuterArea(guess: SectionGuess): number {
  return guess.outline ? polygonArea(guess.outline.outer) : Number.POSITIVE_INFINITY
}

/**
 * Slice stations, tried in increasing order. A single mid-slice resolves a straight member (most
 * parts), so the wider sets — which add the ends for a notched/coped piece — are only paid for when
 * the minimal set does not resolve.
 */
const STATION_LEVELS: number[][] = [[0.5], [0.5, 0.3, 0.7], [0.5, 0.1, 0.9, 0.3, 0.7]]

/**
 * Confidence a slice must reach to stop widening the search. Kept near-perfect: a *cut* slice (a
 * cope/notch through the middle) can match a sibling section at a merely-high score, so stopping on
 * that would misread the stock. Below this the wider, end-inclusive levels decide.
 */
const STOP_CONFIDENCE = 0.99

/** The higher-scoring of two guesses; on a tie, the smaller cut area wins. */
function betterGuess(a: SectionGuess | null, b: SectionGuess | null): SectionGuess | null {
  if (!a) return b
  if (!b) return a
  if (b.score > a.score) return b
  if (a.score > b.score) return a
  return guessOuterArea(b) <= guessOuterArea(a) ? b : a
}

/**
 * Reads the section out of a part's real geometry: slice each axis (and, when needed, its principal
 * axes) and keep the cross-section that best matches a stocked section — the member axis reveals
 * itself as the slice that resolves. Slicing widens only as far as it must: the minimal mid-slice is
 * tried first, and the ends are added (merged additively) only when nothing resolves, so a
 * notched/coped piece is still read from the stock section at its square-cut ends. World axes are
 * tried before the principal axes; ties go to the smaller cut area (a prism's perpendicular section
 * is its minimum-area cut). Returns null when nothing matches.
 */
export function inferStepSection(
  shape: SectionShape,
  makeBox: (a: number[], b: number[]) => SectionShape,
): SectionGuess | null {
  let best: SectionGuess | null = null
  let aligned: SectionShape | null = null
  try {
    aligned = alignToPrincipalAxes(
      shape,
      shape.mesh({ tolerance: 1, angularTolerance: 1 }).vertices,
    )
  } catch {
    aligned = null
  }
  try {
    for (const fractions of STATION_LEVELS) {
      // Both passes are compared before exiting: an oblique slice of a rotated part can resolve
      // *wrongly* at full score (a hollow read at an angle reconstructs as an oversized `RHS…`), so
      // the area tie-break against the principal-axis slice is what tells the true section apart.
      const world = bestGuess(measureSections(shape, makeBox, fractions))
      const principal = aligned ? bestGuess(measureSections(aligned, makeBox, fractions)) : null
      best = betterGuess(best, betterGuess(world, principal))
      if (best && best.score >= STOP_CONFIDENCE) return best
    }
    return best
  } finally {
    aligned?.delete()
  }
}

/** Imports a STEP and reads its section. Convenience for tests; the worker reuses a shape. */
export async function detectStepSection(bytes: Uint8Array): Promise<SectionGuess | null> {
  await ensureOc()
  const { importSTEP, makeBox } = (await import('replicad')) as unknown as {
    importSTEP: (blob: Blob) => Promise<SectionShape>
    makeBox: (a: number[], b: number[]) => SectionShape
  }
  const shape = await importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' }))
  try {
    return inferStepSection(shape, makeBox)
  } finally {
    shape.delete()
  }
}
