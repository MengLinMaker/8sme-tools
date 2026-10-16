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
 * member axis from a wrong-axis slice, which lines up with no section. Several stations per axis,
 * keeping the largest outer area, so a hole or cutout at any one station cannot distort the stock.
 */
export function measureSections(
  shape: SectionShape,
  makeBox: (a: number[], b: number[]) => SectionShape,
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
    let best: { area: number; section: MeasuredSection } | null = null
    for (const fraction of [0.5, 0.3, 0.7]) {
      const measured = slabSection(shape, makeBox, axis, bounds, fraction)
      if (!measured) continue
      const area = polygonArea(measured.outer)
      if (!best || area > best.area) best = { area, section: measured }
    }
    if (best) sections.push(normalizeSection(best.section))
  }
  return sections
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
  const inverse = new Matrix4().copy(basis).invert()
  const quaternion = new Quaternion().setFromRotationMatrix(inverse)
  const halfSin = Math.sqrt(Math.max(0, 1 - quaternion.w * quaternion.w))
  const axis: [number, number, number] =
    halfSin > 1e-6
      ? [quaternion.x / halfSin, quaternion.y / halfSin, quaternion.z / halfSin]
      : [0, 0, 1]
  const angleDeg = (2 * Math.acos(Math.min(1, Math.max(-1, quaternion.w))) * 180) / Math.PI
  let aligned = shape.clone().translate(-frame.centre[0], -frame.centre[1], -frame.centre[2])
  aligned = aligned.rotate(angleDeg, [0, 0, 0], axis)
  return aligned
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
 * Reads the section out of a part's real geometry: extract the candidate cross-sections (one per
 * axis) and keep the one that best matches a stocked section — the member axis reveals itself as the
 * slice that resolves. World axes are tried first; the part's **principal axes** are always also
 * tried, because an oblique slice of a rotated export can still resolve *wrongly* (a hollow read at
 * an angle reconstructs as an oversized `RHS…` that scores as well as the truth, so an early return
 * on the world result would never fall back). When both score equally, the smaller cut area wins —
 * a prism's perpendicular cross-section is the minimum-area cut, an oblique one is inflated.
 * Returns null when nothing matches.
 */
export function inferStepSection(
  shape: SectionShape,
  makeBox: (a: number[], b: number[]) => SectionShape,
): SectionGuess | null {
  const direct = bestGuess(measureSections(shape, makeBox))

  let aligned: SectionShape | null = null
  try {
    aligned = alignToPrincipalAxes(
      shape,
      shape.mesh({ tolerance: 1, angularTolerance: 1 }).vertices,
    )
    if (!aligned) return direct
    const rotated = bestGuess(measureSections(aligned, makeBox))
    if (!direct) return rotated
    if (!rotated) return direct
    if (rotated.score > direct.score) return rotated
    if (direct.score > rotated.score) return direct
    return guessOuterArea(rotated) <= guessOuterArea(direct) ? rotated : direct
  } catch {
    return direct
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
