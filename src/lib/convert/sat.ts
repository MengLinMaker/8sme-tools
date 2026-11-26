import { inferSectionFromCross, type SectionGuess } from '@/lib/sections/detect'
import {
  type Outline,
  outlinePoints,
  rotateOutline,
  translateOutline,
} from '@/lib/sections/outline'
import { stockOutlineForCode } from '@/lib/sections/stock'

/**
 * ACIS SAT section reader.
 *
 * A `.sat` exported by a modeller is a B-rep, but the geometry that decides whether WiseCAM
 * recognises a standard section is the **cross-section**. Reading it is a small, targeted job:
 * take the edges in the square end plane, link them into one loop, measure the section, and match
 * it against the stock catalogue. Everything here is pure (no OCC), so the UI can show the findings
 * the moment a file is dropped; the prism rebuild is a separate OCC step.
 *
 * SAT ids are negative in the file; a reference `$41` points at entity `-41`. The records we need
 * are `point` / `vertex` / `edge` / `face`, plus the curve and surface records they reference.
 * `$1`-style columns are positional, so a record is parsed by index after the 4-token reference
 * header.
 */

type Vec3 = [number, number, number]
type Vec2 = [number, number]

export type SatSurface =
  | { type: 'plane'; origin: Vec3; normal: Vec3 }
  | { type: 'cone'; center: Vec3; axis: Vec3 }
  | { type: 'other'; name: string }

export type SatCurve =
  | { type: 'line'; origin: Vec3; dir: Vec3 }
  | { type: 'circle'; center: Vec3; normal: Vec3; radius: number; ratio: number }
  | { type: 'other'; name: string }

export interface SatEdgeRecord {
  /** Entity id (negative in the file). */
  id: number
  /** The two vertex refs, in edge order. */
  v: [number | null, number | null]
  /** The curve ref, when the edge is curved. */
  curve: number | null
}

export interface SatFaceRecord {
  id: number
  surface: number | null
}

export interface SatModel {
  points: Map<number, Vec3>
  vertices: Map<number, number | null>
  edges: SatEdgeRecord[]
  faces: SatFaceRecord[]
  surface: (id: number | null) => SatSurface
  curve: (id: number | null) => SatCurve
  /** The endpoints of an edge, or `[null, null]` when a vertex/point is missing. */
  pointOfEdge: (edge: SatEdgeRecord) => [Vec3 | null, Vec3 | null]
}

interface SatEntity {
  id: number
  type: string
  tokens: string[]
}

/** Parse the entity records a cross-section needs. Unknown records are kept but not interpreted. */
export function parseSat(text: string): SatModel {
  const entities = new Map<number, SatEntity>()
  for (const line of text.split(/\r?\n/)) {
    // A record is `<id> <type> <4 refs> $1 ...`; block records are not used by the geometry records
    // we read, so a line that starts with `{` is skipped.
    const match = line.match(/^(-?\d+)\s+([A-Za-z_][\w-]*)\s+(.*)$/)
    if (!match) continue
    const rest = (match[3] ?? '').replace(/#\s*$/, '').trim()
    if (!rest) continue
    entities.set(Number(match[1]), {
      id: Number(match[1]),
      type: match[2] as string,
      tokens: rest.split(/\s+/).filter(Boolean),
    })
  }

  const byId = (id: number | null): SatEntity | undefined =>
    id == null ? undefined : entities.get(id)
  const ref = (token: string | undefined): number | null =>
    token && /^\$-?\d+$/.test(token) ? -Math.abs(Number(token.slice(1))) : null
  const after = (entity: SatEntity): string[] => entity.tokens.slice(4)
  const numbers = (tokens: string[]): number[] =>
    tokens.map(Number).filter((value) => Number.isFinite(value))
  const vec3 = (values: number[]): Vec3 => [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0]

  const points = new Map<number, Vec3>()
  const vertices = new Map<number, number | null>()
  const edges: SatEdgeRecord[] = []
  const faces: SatFaceRecord[] = []

  for (const entity of entities.values()) {
    const rest = after(entity)
    if (entity.type === 'point') {
      points.set(entity.id, vec3(numbers(rest)))
    } else if (entity.type === 'vertex') {
      vertices.set(entity.id, ref(rest[rest.length - 1]))
    } else if (entity.type === 'edge') {
      edges.push({ id: entity.id, v: [ref(rest[0]), ref(rest[2])], curve: ref(rest[5]) })
    } else if (entity.type === 'face') {
      faces.push({ id: entity.id, surface: ref(rest[4]) })
    }
  }

  const surface = (id: number | null): SatSurface => {
    const entity = byId(id)
    if (!entity) return { type: 'other', name: 'unknown' }
    const values = numbers(after(entity))
    if (entity.type === 'plane-surface') {
      return { type: 'plane', origin: vec3(values.slice(0, 3)), normal: vec3(values.slice(3, 6)) }
    }
    if (entity.type === 'cone-surface') {
      return { type: 'cone', center: vec3(values.slice(0, 3)), axis: vec3(values.slice(3, 6)) }
    }
    return { type: 'other', name: entity.type }
  }

  const curve = (id: number | null): SatCurve => {
    const entity = byId(id)
    if (!entity) return { type: 'other', name: 'unknown' }
    const values = numbers(after(entity))
    if (entity.type === 'straight-curve') {
      return { type: 'line', origin: vec3(values.slice(0, 3)), dir: vec3(values.slice(3, 6)) }
    }
    if (entity.type === 'ellipse-curve') {
      const major = values.slice(6, 9)
      return {
        type: 'circle',
        center: vec3(values.slice(0, 3)),
        normal: vec3(values.slice(3, 6)),
        radius: Math.hypot(...(major as [number, number, number])),
        ratio: values[9] ?? 1,
      }
    }
    return { type: 'other', name: entity.type }
  }

  return {
    points,
    vertices,
    edges,
    faces,
    surface,
    curve,
    pointOfEdge: (edge) => {
      const a = edge.v[0] == null ? null : vertices.get(edge.v[0])
      const b = edge.v[1] == null ? null : vertices.get(edge.v[1])
      return [
        a == null ? null : (points.get(a) ?? null),
        b == null ? null : (points.get(b) ?? null),
      ]
    },
  }
}

/** One edge of the section loop, in the XY plane. */
export interface SatLoopEdge {
  type: 'line' | 'circle' | 'other'
  p1: Vec3
  p2: Vec3
  /** Present for `circle` (an `ellipse-curve` with ratio 1). */
  center?: Vec3
  radius?: number
}

/** Edges lying in the plane `z = z0`, i.e. the cross-section at that end. */
export function sectionEdges(sat: SatModel, z0: number, tolerance = 1e-6): SatLoopEdge[] {
  const out: SatLoopEdge[] = []
  for (const edge of sat.edges) {
    const [p1, p2] = sat.pointOfEdge(edge)
    if (!p1 || !p2) continue
    if (Math.abs(p1[2] - z0) > tolerance || Math.abs(p2[2] - z0) > tolerance) continue
    const curve = sat.curve(edge.curve)
    if (curve.type === 'circle' && curve.ratio === 1) {
      out.push({ type: 'circle', p1, p2, center: curve.center, radius: curve.radius })
    } else if (curve.type === 'line') {
      out.push({ type: 'line', p1, p2 })
    } else {
      out.push({ type: curve.type === 'circle' ? 'circle' : 'other', p1, p2 })
    }
  }
  return out
}

const keyOf = (point: Vec3): string => `${point[0].toFixed(4)},${point[1].toFixed(4)}`

/** Link the section edges into one closed loop by matching endpoints. */
export function orderLoop(edges: SatLoopEdge[]): SatLoopEdge[] {
  if (edges.length === 0) throw new Error('cross-section has no edges')
  const left = [...edges]
  const first = left.shift()
  if (!first) throw new Error('cross-section has no edges')
  const loop = [first]
  let guard = 0
  while (left.length > 0 && guard++ < edges.length + 2) {
    const end = keyOf(loop[loop.length - 1]!.p2)
    const index = left.findIndex((edge) => keyOf(edge.p1) === end || keyOf(edge.p2) === end)
    if (index < 0) throw new Error(`cross-section is not a single closed loop (break at ${end})`)
    const next = left.splice(index, 1)[0]!
    if (keyOf(next.p2) === end) [next.p1, next.p2] = [next.p2, next.p1]
    loop.push(next)
  }
  if (left.length > 0) throw new Error('cross-section has more than one loop')
  if (keyOf(loop[loop.length - 1]!.p2) !== keyOf(loop[0]!.p1)) {
    throw new Error('cross-section loop does not close')
  }
  return loop
}

/** Samples a loop to a polyline (arcs at `steps` each) for shape matching. */
export function sampleLoop(loop: SatLoopEdge[], steps = 16): Vec2[] {
  const first = loop[0]
  if (!first) return []
  const points: Vec2[] = [[first.p1[0], first.p1[1]]]
  for (const edge of loop) {
    if (edge.type === 'circle' && edge.center && edge.radius != null) {
      const center = edge.center
      const radius = edge.radius
      const a0 = Math.atan2(edge.p1[1] - center[1], edge.p1[0] - center[0])
      const a1 = Math.atan2(edge.p2[1] - center[1], edge.p2[0] - center[0])
      let sweep = a1 - a0
      while (sweep <= 1e-9) sweep += Math.PI * 2
      for (let i = 1; i <= steps; i++) {
        const angle = a0 + (sweep * i) / steps
        points.push([center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius])
      }
    } else {
      points.push([edge.p2[0], edge.p2[1]])
    }
  }
  return points
}

export interface SatMeasurement {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  depth: number
  /** True when the web runs along y, i.e. the depth is the y extent. */
  webAlongY: boolean
  /** Depth (the parent UB/UC's `d`). */
  d: number
  /** Flange width (`b`). */
  b: number
  tw: number
  tf: number
  r: number
  worstRadius: number
  /** Number of circular corner edges at this end. */
  corners: number
}

/**
 * The fillet centres name the section: a root fillet sits `tw/2 + r` off the web axis and
 * `d/2 − tf − r` off the depth axis, which are far apart, so the pair says which bbox axis is
 * the **depth** (web) and which is the width, even on a square section.
 */
export function measureSection(loop: SatLoopEdge[]): SatMeasurement {
  const points = loop.flatMap((edge) => [edge.p1, edge.p2])
  if (points.length === 0) throw new Error('cross-section has no points')
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const centre: Vec2 = [(minX + maxX) / 2, (minY + maxY) / 2]

  const circles = loop.filter((edge) => edge.type === 'circle' && edge.radius != null)
  if (circles.length === 0) {
    throw new Error('cross-section has no circular corners to read (only I-sections are measured)')
  }
  const r = circles.reduce((sum, edge) => sum + (edge.radius ?? 0), 0) / circles.length
  const worstRadius = Math.max(...circles.map((edge) => Math.abs((edge.radius ?? 0) - r)))
  const cx = Math.max(...circles.map((edge) => Math.abs((edge.center?.[0] ?? 0) - centre[0])))
  const cy = Math.max(...circles.map((edge) => Math.abs((edge.center?.[1] ?? 0) - centre[1])))

  const webAlongY = cx < cy
  const width = maxX - minX
  const depth = maxY - minY
  const tw = 2 * ((webAlongY ? cx : cy) - r)
  const tf = (webAlongY ? depth : width) / 2 - (webAlongY ? cy : cx) - r

  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    depth,
    webAlongY,
    d: webAlongY ? depth : width,
    b: webAlongY ? width : depth,
    tw,
    tf,
    r,
    worstRadius,
    corners: circles.length,
  }
}

/**
 * A section with no circular corner edges (a chorded/faceted export) still has usable bounds. The
 * catalogue match supplies the exact arcs; the bounds only seat the contour and bound the cutters.
 */
function measureLoopBounds(loop: SatLoopEdge[]): SatMeasurement {
  const points = loop.flatMap((edge) => [edge.p1, edge.p2])
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const width = maxX - minX
  const depth = maxY - minY
  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    depth,
    webAlongY: false,
    d: depth,
    b: width,
    tw: 0,
    tf: 0,
    r: 0,
    worstRadius: 0,
    corners: 0,
  }
}

export interface SatEndCut {
  origin: Vec3
  normal: Vec3
  /** Angle off square, in degrees (the member axis is Z). */
  angleDeg: number
}

/** Planar faces that are not square to the member axis: the end cuts (bevels/rakes). */
export function endCuts(sat: SatModel, zMin: number, zMax: number): SatEndCut[] {
  const cuts: SatEndCut[] = []
  for (const face of sat.faces) {
    const surface = sat.surface(face.surface)
    if (surface.type !== 'plane') continue
    const [nx, ny, nz] = surface.normal
    const length = Math.hypot(nx, ny, nz)
    if (length === 0) continue
    if (Math.abs(nz / length) < 0.02) continue // parallel to the member: a side face
    if (Math.abs(nz / length) > 0.999) continue // square to the member: a square end
    if (surface.origin[2] < zMin - 1 || surface.origin[2] > zMax + 1) continue
    cuts.push({
      origin: surface.origin,
      normal: [nx / length, ny / length, nz / length],
      angleDeg: (Math.acos(Math.min(1, Math.abs(nz / length))) * 180) / Math.PI,
    })
  }
  return cuts
}

/** The SAT's member frame: Z is the extrusion axis, and the square end is at `zMin`. */
export interface SatAnalysis {
  /** The part's length along Z (mm). */
  length: number
  zMin: number
  zMax: number
  /** Edges at the square end. */
  sectionEdgeCount: number
  /** Circular edges at the square end. */
  cornerArcs: number
  endCuts: SatEndCut[]
  /** The ordered cross-section loop read from the SAT (source geometry), for the preview. */
  section: SatLoopEdge[] | null
  measured: SatMeasurement | null
  /** Which catalogued section the measured cross-section matches. */
  guess: SectionGuess | null
  /** The clean catalogue outline seated in the SAT frame, when the match is safe to rebuild from. */
  plan: SatPlan | null
  /** Everything that prevented a full match/rebuild plan. Empty means the plan is ready. */
  problems: string[]
}

export interface SatPlan {
  code: string
  family: string
  label: string
  mass: number | null
  score: number
  /** The catalogue contour, seated in the SAT's own XY frame. */
  contour: Outline
  length: number
  zMin: number
  measured: SatMeasurement
  endCuts: SatEndCut[]
  /** Max distance from the measured section to the rebuilt outline, in mm. */
  deviation: number
}

/** Signed shoelace area of a closed polygon given as `[x, y]` points. */
export function polygonArea(points: Vec2[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!
    const [x2, y2] = points[(i + 1) % points.length]!
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

/** Shortest distance from `point` to the closed polyline `points`. */
export function distanceToLoop(point: Vec2, points: Vec2[]): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const length2 = dx * dx + dy * dy
    const t =
      length2 > 0
        ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2))
        : 0
    best = Math.min(best, Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy)))
  }
  return best
}

/** The largest tolerable gap between the source loop and the rebuilt catalogue outline (mm). */
export const SAT_DEVIATION_MAX_MM = 0.05
/** Looser gate for a chorded source: the chords are the defect being replaced, not a mismatch. */
export const SAT_CHORD_DEVIATION_MAX_MM = 1

/**
 * Read a SAT and work out what it is. Never throws for a plausible file: every failure is a reason
 * in `problems`, so the UI can still report the measured length/corners/end cuts.
 */
export function analyzeSat(text: string): SatAnalysis {
  const result: SatAnalysis = {
    length: 0,
    zMin: 0,
    zMax: 0,
    sectionEdgeCount: 0,
    cornerArcs: 0,
    endCuts: [],
    section: null,
    measured: null,
    guess: null,
    plan: null,
    problems: [],
  }
  if (!/ACIS/.test(text.slice(0, 500))) {
    result.problems.push('not an ACIS SAT file (no ACIS header)')
    return result
  }

  const sat = parseSat(text)
  const zs = [...sat.points.values()].map((point) => point[2])
  if (zs.length === 0) {
    result.problems.push('no points found in the SAT')
    return result
  }
  result.zMin = Math.min(...zs)
  result.zMax = Math.max(...zs)
  result.length = result.zMax - result.zMin
  result.endCuts = endCuts(sat, result.zMin, result.zMax)

  // The square end can be either end of the member. Try the end with the most edges first: a
  // raked end still contributes a loop, but usually a smaller/different one.
  const candidates = [result.zMin, result.zMax]
    .map((z) => ({ z, edges: sectionEdges(sat, z) }))
    .sort((a, b) => b.edges.length - a.edges.length)
  const square = candidates[0]
  if (!square || square.edges.length === 0) {
    result.problems.push('no cross-section edges at either end (is the member axis Z?)')
    return result
  }
  result.sectionEdgeCount = square.edges.length
  result.cornerArcs = square.edges.filter((edge) => edge.type === 'circle').length

  let loop: SatLoopEdge[]
  try {
    loop = orderLoop(square.edges)
    result.section = loop
  } catch (error) {
    result.problems.push(error instanceof Error ? error.message : String(error))
    return result
  }

  try {
    result.measured = measureSection(loop)
  } catch {
    // A chorded/faceted export has no circular edges to measure the fillets from. The catalogue
    // match can still supply the true section; only the seating bounds are needed from the SAT.
    result.measured = measureLoopBounds(loop)
  }
  const measured = result.measured

  const guess = inferSectionFromCross({ outer: sampleLoop(loop) })
  if (!guess) {
    result.problems.push('cross-section does not match any catalogued section')
    return result
  }
  result.guess = guess
  if (!/^(uc|ub|tfb|i)$/.test(guess.family)) {
    result.problems.push(
      `detected ${guess.code} (${guess.family}); only I-sections are rebuilt from a SAT`,
    )
    return result
  }

  const clean = stockOutlineForCode(guess.code, guess.dims)
  if (!clean?.outline) {
    result.problems.push(`no stock outline for ${guess.code}`)
    return result
  }

  // Seat the catalogue contour in the SAT's own frame: same depth axis, same bbox corner, so the
  // end cuts (defined in world coordinates) land where they were. A square UC's bbox cannot say
  // which axis is the web, so try both orientations and keep the one that actually fits the loop.
  const source = sampleLoop(loop, 64)
  const placements = [clean.outline, rotateOutline(clean.outline, Math.PI / 2)].map(
    (candidate, index) => {
      const box = outlinePoints(candidate)
      const cleanMinX = Math.min(...box.map((point) => point[0]))
      const cleanMinY = Math.min(...box.map((point) => point[1]))
      const contour = translateOutline(
        candidate,
        measured.minX - cleanMinX,
        measured.minY - cleanMinY,
      )
      const rebuilt = outlinePoints(contour, 64)
      const deviation = Math.max(...source.map((point) => distanceToLoop(point, rebuilt)))
      return { contour, deviation, webAlongY: index === 1 }
    },
  )
  placements.sort((a, b) => a.deviation - b.deviation)
  const best = placements[0]
  if (!best) {
    result.problems.push(`could not seat ${guess.code} in the SAT frame`)
    return result
  }
  // A chorded section's own outline is the thing being fixed, so it legitimately sits farther from
  // the catalogue arcs than a section that already carries them. The match/IoU still gates the
  // identity; this only gates the seating quality.
  const limit = result.cornerArcs >= 4 ? SAT_DEVIATION_MAX_MM : SAT_CHORD_DEVIATION_MAX_MM
  if (best.deviation > limit) {
    result.problems.push(
      `rebuilt ${guess.code} section deviates ${best.deviation.toFixed(3)} mm from the SAT outline`,
    )
    return result
  }
  measured.webAlongY = best.webAlongY

  result.plan = {
    code: guess.code,
    family: guess.family,
    label: guess.label,
    mass: guess.mass,
    score: guess.score,
    contour: best.contour,
    length: result.length,
    zMin: result.zMin,
    measured,
    endCuts: result.endCuts,
    deviation: best.deviation,
  }
  return result
}
