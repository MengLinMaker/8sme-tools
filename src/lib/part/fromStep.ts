import {
  faceHalf,
  faceNormal,
  facePlaneHalf,
  faceSpanAxis,
  frameForProfile,
  ncAuthoredAcrossSign,
  placeNcFace,
} from '@/lib/parsers/ncFaces'
import type { NcFace } from '@/lib/parsers/ncGeometry'
import { distanceToOutline } from '@/lib/step/cutEdges'
import { projectCutEdgesToFaces } from '@/lib/step/cutProjection'
import type { MeshedStep } from '@/lib/step/mesh'
import { profileTypeFor, type SeatedStepGeometry, seatedStepGeometry } from '@/lib/wisecam/fromStep'
import {
  centeredStationFor,
  stationFor,
  surfaceStationFor,
  unrolledLayout,
} from '@/lib/wisecam/layout'
import { centredStation, type PartChart, type PartFeature, type PartIr, type UvPoint } from './ir'

/**
 * STEP → PartIR (cut boundaries).
 *
 * The real part's cut edges are projected onto the stock faces and developed by the shared surface
 * core, then converted from WiseCAM's wrapped station to the IR's centred station. This is the STEP
 * half of the canonical model: no holes/marks yet (the cut-edge boundaries already include hole
 * rims as closed loops), but enough to render and compare against NC-derived IR.
 */

export interface FromStepIrOptions {
  mark: string
  /** Catalogue profile code, e.g. `RHS150*100*9.0`. */
  profile: string
  /** DSTV-header dimensions. */
  dimensions: number[]
  length: number
  section: [number, number][]
  innerSection?: [number, number][]
  quantity?: number
  /** Outer corner radius (mm). */
  radius?: number
}

interface StepCut {
  points: UvPoint[]
  closed: boolean
  /** Per-vertex DSTV bevel fields, only present when the STEP cut face is bevelled. */
  bevels?: number[][]
}

const same = (a: UvPoint, b: UvPoint): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 0.05

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function unit(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** A chain of projected segments with one signed bevel angle per vertex. */
interface Chain {
  points: UvPoint[]
  bevels: number[]
}

function chainSegments(segments: { a: UvPoint; b: UvPoint; bevel: number }[]): Chain[] {
  const remaining = [...segments]
  const chains: Chain[] = []
  const join = (current: number, next: number): number => Math.max(current, next)
  while (remaining.length > 0) {
    const first = remaining.shift()
    if (!first) break
    const chain: Chain = { points: [first.a, first.b], bevels: [first.bevel, first.bevel] }
    let matched = true
    while (matched && remaining.length > 0) {
      matched = false
      const head = chain.points[0] as UvPoint
      const tail = chain.points[chain.points.length - 1] as UvPoint
      for (let index = 0; index < remaining.length; index++) {
        const segment = remaining[index]
        if (!segment) continue
        if (same(tail, segment.a)) {
          chain.bevels[chain.bevels.length - 1] = join(
            chain.bevels[chain.bevels.length - 1] ?? 0,
            segment.bevel,
          )
          chain.points.push(segment.b)
          chain.bevels.push(segment.bevel)
        } else if (same(tail, segment.b)) {
          chain.bevels[chain.bevels.length - 1] = join(
            chain.bevels[chain.bevels.length - 1] ?? 0,
            segment.bevel,
          )
          chain.points.push(segment.a)
          chain.bevels.push(segment.bevel)
        } else if (same(head, segment.b)) {
          chain.bevels[0] = join(chain.bevels[0] ?? 0, segment.bevel)
          chain.points.unshift(segment.a)
          chain.bevels.unshift(segment.bevel)
        } else if (same(head, segment.a)) {
          chain.bevels[0] = join(chain.bevels[0] ?? 0, segment.bevel)
          chain.points.unshift(segment.b)
          chain.bevels.unshift(segment.bevel)
        } else {
          continue
        }
        remaining.splice(index, 1)
        matched = true
        break
      }
    }
    chains.push(chain)
  }
  return chains
}

/** Split a chain where it crosses a zero-origin seam. */
function splitChain(chain: Chain, seam: number): Chain[] {
  const runs: Chain[] = []
  let points: UvPoint[] = []
  let bevels: number[] = []
  for (let index = 0; index < chain.points.length; index++) {
    const point = chain.points[index] as UvPoint
    const previous = chain.points[index - 1]
    if (previous && Math.abs(point[0] - previous[0]) > seam / 2) {
      if (points.length >= 2) runs.push({ points, bevels })
      points = []
      bevels = []
    }
    points.push(point)
    bevels.push(chain.bevels[index] ?? 0)
  }
  if (points.length >= 2) runs.push({ points, bevels })
  return runs
}

interface TubeArcMapper {
  station: (point: [number, number]) => number
  crossAt: (station: number) => [number, number]
}

/** Map tube surface points by perimeter arc length, calibrated against the face boundaries. */
interface FittedCircle {
  cx: number
  cy: number
  r: number
}

function fitCircle(points: [number, number][]): FittedCircle | null {
  if (points.length < 6) return null
  let sxx = 0
  let sxy = 0
  let syy = 0
  let sx = 0
  let sy = 0
  let sz = 0
  let sxz = 0
  let syz = 0
  for (const [x, y] of points) {
    const z = x * x + y * y
    sxx += x * x
    sxy += x * y
    syy += y * y
    sx += x
    sy += y
    sz += z
    sxz += x * z
    syz += y * z
  }
  const n = points.length
  const matrix = [
    [sxx, sxy, sx, sxz],
    [sxy, syy, sy, syz],
    [sx, sy, n, sz],
  ]
  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let row = col + 1; row < 3; row++)
      if (Math.abs(matrix[row]?.[col] ?? 0) > Math.abs(matrix[pivot]?.[col] ?? 0)) pivot = row
    if (Math.abs(matrix[pivot]?.[col] ?? 0) < 1e-9) return null
    ;[matrix[col], matrix[pivot]] = [matrix[pivot] as number[], matrix[col] as number[]]
    const pv = matrix[col]?.[col] ?? 1
    for (let k = col; k < 4; k++) {
      const row = matrix[col] as number[]
      row[k] = (row[k] ?? 0) / pv
    }
    for (let row = 0; row < 3; row++) {
      if (row === col) continue
      const factor = matrix[row]?.[col] ?? 0
      if (factor === 0) continue
      for (let k = col; k < 4; k++) {
        const target = matrix[row] as number[]
        target[k] = (target[k] ?? 0) - factor * (matrix[col]?.[k] ?? 0)
      }
    }
  }
  const a = matrix[0]?.[3] ?? 0
  const b = matrix[1]?.[3] ?? 0
  const c = matrix[2]?.[3] ?? 0
  const cx = a / 2
  const cy = b / 2
  const r = Math.sqrt(Math.max(0, c + cx * cx + cy * cy))
  return r > 0 ? { cx, cy, r } : null
}

/** Fit the four corner circles from the STEP stock faces and build the measured outline. */
function measuredTubeOutline(
  seated: SeatedStepGeometry,
  section: [number, number][],
): { points: [number, number][]; circles: FittedCircle[] } | null {
  const circles: FittedCircle[] = []
  const outerPoints: [number, number][] = []
  for (const face of seated.faces) {
    const edgePoints: [number, number][] = []
    const surfacePoints: [number, number][] = []
    for (const edge of face.wires.flatMap((wire) => wire.edges)) {
      if (edge.curveType !== 'CIRCLE') continue
      for (let index = 0; index + 2 < edge.points.length; index += 3) {
        const point: [number, number] = [
          dot(
            [
              edge.points[index] as number,
              edge.points[index + 1] as number,
              edge.points[index + 2] as number,
            ],
            seated.xAxis,
          ),
          dot(
            [
              edge.points[index] as number,
              edge.points[index + 1] as number,
              edge.points[index + 2] as number,
            ],
            seated.yAxis,
          ),
        ]
        if (distanceToOutline(section, point) <= 2) edgePoints.push(point)
      }
    }
    for (let index = 0; index + 2 < face.samples.length; index += 3) {
      const point: [number, number] = [
        dot(
          [
            face.samples[index] as number,
            face.samples[index + 1] as number,
            face.samples[index + 2] as number,
          ],
          seated.xAxis,
        ),
        dot(
          [
            face.samples[index] as number,
            face.samples[index + 1] as number,
            face.samples[index + 2] as number,
          ],
          seated.yAxis,
        ),
      ]
      if (distanceToOutline(section, point) <= 2) {
        surfacePoints.push(point)
        outerPoints.push(point)
      }
    }
    if (face.planar) continue
    if (face.cylinder) {
      circles.push({
        cx: dot(face.cylinder.center, seated.xAxis),
        cy: dot(face.cylinder.center, seated.yAxis),
        r: face.cylinder.radius,
      })
      continue
    }
    const points = edgePoints.length >= 6 ? edgePoints : surfacePoints
    if (points.length < 6) continue
    const fit = fitCircle(points)
    if (fit) circles.push(fit)
  }
  if (circles.length !== 4) return null
  const meanX = circles.reduce((sum, circle) => sum + circle.cx, 0) / circles.length
  const meanY = circles.reduce((sum, circle) => sum + circle.cy, 0) / circles.length
  const find = (left: boolean, bottom: boolean): FittedCircle | null =>
    circles.find((circle) => circle.cx < meanX === left && circle.cy < meanY === bottom) ?? null
  const bl = find(true, true)
  const br = find(false, true)
  const tr = find(false, false)
  const tl = find(true, false)
  if (!bl || !br || !tr || !tl) return null
  const points: [number, number][] = []
  const arc = (circle: FittedCircle, from: number, to: number): void => {
    const steps = Math.max(12, Math.ceil((Math.abs(to - from) * circle.r) / 0.5))
    for (let index = 0; index <= steps; index++) {
      const angle = from + ((to - from) * index) / steps
      points.push([circle.cx + Math.cos(angle) * circle.r, circle.cy + Math.sin(angle) * circle.r])
    }
  }
  arc(bl, Math.PI, (3 * Math.PI) / 2)
  arc(br, -Math.PI / 2, 0)
  arc(tr, 0, Math.PI / 2)
  arc(tl, Math.PI / 2, Math.PI)
  return { points, circles }
}

/** Exact dense outline of a rounded-rectangle tube section (catalogue samples are too coarse). */
function denseTubeOutline(section: [number, number][], radius: number): [number, number][] {
  if (!(radius > 0) || section.length < 3) return section
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of section) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const r = radius
  const points: [number, number][] = [[minX + r, minY]]
  const arc = (cx: number, cy: number, from: number, to: number): void => {
    const steps = Math.max(8, Math.ceil((Math.abs(to - from) * r) / 1))
    for (let index = 0; index <= steps; index++) {
      const angle = from + ((to - from) * index) / steps
      points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r])
    }
  }
  const flat = (from: [number, number], to: [number, number]): void => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1])
    const steps = Math.max(1, Math.ceil(length))
    for (let index = 1; index <= steps; index++) {
      const t = index / steps
      points.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t])
    }
  }
  flat([minX + r, minY], [maxX - r, minY])
  arc(maxX - r, minY + r, -Math.PI / 2, 0)
  flat([maxX, minY + r], [maxX, maxY - r])
  arc(maxX - r, maxY - r, 0, Math.PI / 2)
  flat([maxX - r, maxY], [minX + r, maxY])
  arc(minX + r, maxY - r, Math.PI / 2, Math.PI)
  flat([minX, maxY - r], [minX, minY + r])
  arc(minX + r, minY + r, Math.PI, (3 * Math.PI) / 2)
  return points
}

export function tubeArcMapper(
  layout: ReturnType<typeof unrolledLayout> & object,
  section: [number, number][],
  frame: ReturnType<typeof frameForProfile>,
  seated?: SeatedStepGeometry,
): TubeArcMapper | null {
  if (section.length < 3) return null
  const radius = Math.max(...Object.values(layout.faces).map((region) => region?.radius ?? 0))
  const measured = seated ? measuredTubeOutline(seated, section) : null
  const dense = measured?.points ?? denseTubeOutline(section, radius)
  const points = [...dense, dense[0] as [number, number]]
  const arcs = [0]
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1] as [number, number]
    const b = points[index] as [number, number]
    arcs.push((arcs[index - 1] ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  const total = arcs[arcs.length - 1] ?? 0
  if (!(total > 0)) return null
  const arcAt = (point: [number, number]): number => {
    let best = Number.POSITIVE_INFINITY
    let arc = 0
    for (let index = 0; index + 1 < points.length; index++) {
      const a = points[index] as [number, number]
      const b = points[index + 1] as [number, number]
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const length2 = dx * dx + dy * dy
      let t = length2 > 0 ? ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2 : 0
      t = Math.max(0, Math.min(1, t))
      const distance = Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))
      if (distance < best) {
        best = distance
        arc = (arcs[index] ?? 0) + t * Math.sqrt(length2)
      }
    }
    return arc
  }
  const crossAt = (arc: number): [number, number] => {
    const value = ((arc % total) + total) % total
    for (let index = 0; index + 1 < points.length; index++) {
      const start = arcs[index] ?? 0
      const end = arcs[index + 1] ?? 0
      if (value > end && index + 2 < points.length) continue
      const a = points[index] as [number, number]
      const b = points[index + 1] as [number, number]
      const t = end > start ? (value - start) / (end - start) : 0
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    return points[0] as [number, number]
  }

  // Calibrate against measured corner tangent points when available; otherwise face boundaries.
  const pairs: { arc: number; station: number }[] = []
  if (measured) {
    for (const name of ['v', 'o', 'u', 'h'] as NcFace[]) {
      const region = layout.faces[name]
      if (!region) continue
      const width = region.width ?? region.length
      const normal = faceNormal(frame, name, section)
      const base = normal.axis === 0 ? [1, 0] : [0, 1]
      const normalVec: [number, number] = [base[0] * normal.sign, base[1] * normal.sign]
      const span = faceSpanAxis(frame, name)
      const spanVec: [number, number] = span === 0 ? [1, 0] : [0, 1]
      const halfSpan = faceHalf(frame, span)
      const acrossSign = ncAuthoredAcrossSign(frame, name)
      const half = facePlaneHalf(frame, name)
      for (const circle of measured.circles) {
        const planeDistance = Math.abs(circle.cx * normalVec[0] + circle.cy * normalVec[1] - half)
        if (Math.abs(planeDistance - circle.r) > 0.6) continue
        const tangent: [number, number] = [
          circle.cx + normalVec[0] * circle.r,
          circle.cy + normalVec[1] * circle.r,
        ]
        const y = halfSpan + acrossSign * (tangent[0] * spanVec[0] + tangent[1] * spanVec[1])
        const high = y > width / 2
        const station = centeredStationFor(layout, name, high ? width - circle.r : circle.r)
        if (station == null) continue
        pairs.push({ arc: arcAt(tangent), station })
      }
    }
  }
  if (pairs.length < 2) {
    for (const name of ['v', 'o', 'u', 'h'] as NcFace[]) {
      const region = layout.faces[name]
      if (!region) continue
      const width = region.width ?? region.length
      for (const y of [0, width]) {
        const placed = placeNcFace(frame, name, 0, y, section)
        const station = centeredStationFor(layout, name, y)
        if (station == null) continue
        pairs.push({ arc: arcAt([placed.cross[0], placed.cross[1]]), station })
      }
    }
  }
  if (pairs.length < 2) return null
  // Station is periodic (seam = perimeter); fit a branch-consistent line arc → station.
  let fit: { slope: number; offset: number; error: number } | null = null
  for (const slope of [1, -1]) {
    const first = pairs[0] as (typeof pairs)[number]
    const offset = first.station - slope * first.arc
    let error = 0
    for (const pair of pairs) {
      let delta = pair.station - slope * pair.arc - offset
      delta -= Math.round(delta / total) * total
      error = Math.max(error, Math.abs(delta))
    }
    if (!fit || error < fit.error) fit = { slope, offset, error }
  }
  if (!fit) return null
  return {
    station: (point) => {
      const station = fit.offset + fit.slope * arcAt(point)
      const wrapped = ((station % total) + total) % total
      return wrapped > total / 2 ? wrapped - total : wrapped
    },
    crossAt: (station) => {
      if (Math.abs(fit.slope) < 1e-6) return points[0] as [number, number]
      return crossAt(((((station - fit.offset) / fit.slope) % total) + total) % total)
    },
  }
}

function wireCuts(
  seated: SeatedStepGeometry,
  section: [number, number][],
  frame: ReturnType<typeof frameForProfile>,
  layout: ReturnType<typeof unrolledLayout> & object,
): StepCut[] | null {
  const member = seated.memberAxis
  const stock = seated.faces.map((face) => {
    if (Math.abs(dot(face.normal, member)) > 0.05) return false
    if (face.samples.length === 0) return false
    let on = 0
    let total = 0
    for (let index = 0; index + 2 < face.samples.length; index += 3) {
      const sample: [number, number, number] = [
        face.samples[index] as number,
        face.samples[index + 1] as number,
        face.samples[index + 2] as number,
      ]
      const crossPoint: [number, number] = [dot(sample, seated.xAxis), dot(sample, seated.yAxis)]
      total++
      if (distanceToOutline(section, crossPoint) <= 2) on++
    }
    return total > 0 && on / total >= 0.7
  })
  if (!stock.some(Boolean)) return null

  const faceInfos = (['v', 'o', 'u', 'h'] as NcFace[])
    .filter((name) => layout.faces[name])
    .map((name) => {
      const normal = faceNormal(frame, name, section)
      const base = normal.axis === 0 ? seated.xAxis : seated.yAxis
      const span = faceSpanAxis(frame, name)
      return {
        name,
        normalVec: [base[0] * normal.sign, base[1] * normal.sign, base[2] * normal.sign] as [
          number,
          number,
          number,
        ],
        half: facePlaneHalf(frame, name),
        spanVec: (span === 0 ? seated.xAxis : seated.yAxis) as [number, number, number],
        halfSpan: faceHalf(frame, span),
        acrossSign: ncAuthoredAcrossSign(frame, name),
      }
    })

  /** Map a real surface point to the unrolled station (keeps rounded-corner curves smooth). */
  const projectPoint = (point: [number, number, number]): UvPoint | null => {
    let best: { info: (typeof faceInfos)[number]; distance: number } | null = null
    for (const info of faceInfos) {
      const distance = Math.abs(dot(point, info.normalVec) - info.half)
      if (!best || distance < best.distance) best = { info, distance }
    }
    if (!best) return null
    const station = surfaceStationFor(
      layout,
      best.info.name,
      best.info.halfSpan + best.info.acrossSign * dot(point, best.info.spanVec),
    )
    if (station == null) return null
    return [station, dot(point, member) + seated.alongOffset]
  }

  const result: StepCut[] = []
  seated.faces.forEach((brepFace, faceIndex) => {
    if (!stock[faceIndex]) return
    // Planar inner-cavity faces sit a wall thickness inside the nominal face; exclude them so
    // flange cuts are not duplicated. Curved stock faces (tube corners) are kept.
    if (
      brepFace.planar &&
      !faceInfos.some((info) => Math.abs(dot(brepFace.center, info.normalVec) - info.half) <= 1.5)
    )
      return

    const edgeBevel = (edge: { neighbours: number[]; points: number[] }): number => {
      const cutIndex = edge.neighbours.find((index) => index !== faceIndex && !stock[index])
      if (cutIndex == null) return 0
      const cut = seated.faces[cutIndex]
      if (!cut) return 0
      const count = Math.floor(edge.points.length / 3)
      const first: [number, number, number] = [
        edge.points[0] as number,
        edge.points[1] as number,
        edge.points[2] as number,
      ]
      const last: [number, number, number] = [
        edge.points[(count - 1) * 3] as number,
        edge.points[(count - 1) * 3 + 1] as number,
        edge.points[(count - 1) * 3 + 2] as number,
      ]
      const mid: [number, number, number] = [
        (first[0] + last[0]) / 2,
        (first[1] + last[1]) / 2,
        (first[2] + last[2]) / 2,
      ]
      // A cylindrical stock face's local outward normal is radial, not its representative normal.
      let nf = brepFace.normal
      if (brepFace.cylinder) {
        const q: [number, number] = [dot(mid, seated.xAxis), dot(mid, seated.yAxis)]
        const centre: [number, number] = [
          dot(brepFace.cylinder.center, seated.xAxis),
          dot(brepFace.cylinder.center, seated.yAxis),
        ]
        const radial: [number, number] = [q[0] - centre[0], q[1] - centre[1]]
        const length = Math.hypot(radial[0], radial[1]) || 1
        nf = [
          (radial[0] / length) * seated.xAxis[0] + (radial[1] / length) * seated.yAxis[0],
          (radial[0] / length) * seated.xAxis[1] + (radial[1] / length) * seated.yAxis[1],
          (radial[0] / length) * seated.xAxis[2] + (radial[1] / length) * seated.yAxis[2],
        ]
      }
      const into = dot(nf, cut.normal)
      const angle = (Math.asin(Math.min(1, Math.abs(into))) * 180) / Math.PI
      if (angle < 8 || angle > 80) return 0
      const direction = unit([
        nf[0] - into * cut.normal[0],
        nf[1] - into * cut.normal[1],
        nf[2] - into * cut.normal[2],
      ])
      const along = unit([last[0] - first[0], last[1] - first[1], last[2] - first[2]])
      const side = dot(direction, cross(nf, along)) >= 0 ? 1 : -1
      return angle * side
    }
    const appendEdge = (
      points: UvPoint[],
      bevels: number[],
      edgePoints: number[],
      bevel: number,
    ): void => {
      const count = Math.floor(edgePoints.length / 3)
      const projected: UvPoint[] = []
      for (let index = 0; index < count; index++) {
        const point = projectPoint([
          edgePoints[index * 3] as number,
          edgePoints[index * 3 + 1] as number,
          edgePoints[index * 3 + 2] as number,
        ])
        if (point) projected.push(point)
      }
      if (projected.length === 0) return
      const last = points[points.length - 1]
      if (last && !same(last, projected[0] as UvPoint)) {
        projected.reverse()
        bevel = -bevel
      }
      for (const point of projected) {
        const previous = points[points.length - 1]
        if (previous && same(previous, point)) {
          if (bevels.length > 0)
            bevels[bevels.length - 1] = Math.max(bevels[bevels.length - 1] ?? 0, bevel)
          continue
        }
        points.push(point)
        bevels.push(bevel)
      }
    }

    for (const wire of brepFace.wires) {
      const runs: number[][] = []
      if (wire.enclosed) {
        runs.push(wire.edges.map((_, index) => index))
      } else {
        let run: number[] = []
        wire.edges.forEach((edge, index) => {
          const cut = edge.neighbours.some(
            (neighbour) => neighbour !== faceIndex && !stock[neighbour],
          )
          if (cut) run.push(index)
          else {
            if (run.length > 0) runs.push(run)
            run = []
          }
        })
        if (run.length > 0) runs.push(run)
      }
      for (const run of runs) {
        const points: UvPoint[] = []
        const bevels: number[] = []
        for (const index of run) {
          const edge = wire.edges[index]
          if (!edge) continue
          appendEdge(points, bevels, edge.points, edgeBevel(edge))
        }
        if (points.length < 2) continue
        const closed =
          wire.enclosed || same(points[0] as UvPoint, points[points.length - 1] as UvPoint)
        result.push({
          points,
          closed,
          bevels: bevels.some((value) => Math.abs(value) > 1e-6)
            ? bevels.map((value) => [value, 0, 0, 0])
            : undefined,
        })
      }
    }
  })
  return result
}

function projectedCuts(
  seated: SeatedStepGeometry,
  section: [number, number][],
  frame: ReturnType<typeof frameForProfile>,
  layout: ReturnType<typeof unrolledLayout> & object,
  radius = 0,
): StepCut[] {
  const projected = projectCutEdgesToFaces(
    seated.faces,
    section,
    frame,
    seated.xAxis,
    seated.yAxis,
    seated.memberAxis,
    { radius },
  )
  const result: StepCut[] = []
  for (const face of ['v', 'o', 'u', 'h'] as NcFace[]) {
    if (!layout.faces[face]) continue
    const normal = faceNormal(frame, face, section)
    const base = normal.axis === 0 ? seated.xAxis : seated.yAxis
    const normal3 = unit([base[0] * normal.sign, base[1] * normal.sign, base[2] * normal.sign])
    const toScene = (x: number, y: number): [number, number, number] => {
      const placed = placeNcFace(frame, face, x, y, section)
      return [
        placed.along + placed.cross[0] * seated.xAxis[0] + placed.cross[1] * seated.yAxis[0],
        placed.cross[0] * seated.xAxis[1] + placed.cross[1] * seated.yAxis[1],
        placed.cross[0] * seated.xAxis[2] + placed.cross[1] * seated.yAxis[2],
      ]
    }
    const projectedSegments: { a: UvPoint; b: UvPoint; bevel: number }[] = []
    for (const segment of projected[face]) {
      const start = stationFor(layout, face, segment.a.Y)
      const end = stationFor(layout, face, segment.b.Y)
      if (start == null || end == null) continue
      const a: UvPoint = [centredStation(layout, start), segment.a.X + seated.alongOffset]
      const b: UvPoint = [centredStation(layout, end), segment.b.X + seated.alongOffset]
      if (same(a, b)) continue
      const a3 = toScene(segment.a.X, segment.a.Y)
      const b3 = toScene(segment.b.X, segment.b.Y)
      const direction = unit([b3[0] - a3[0], b3[1] - a3[1], b3[2] - a3[2]])
      const sideVector = cross(normal3, direction)
      const side = segment.dir && dot(segment.dir, sideVector) >= 0 ? 1 : segment.dir ? -1 : 1
      projectedSegments.push({ a, b, bevel: segment.bevel * side })
    }
    for (const chain of chainSegments(projectedSegments)) {
      for (const run of splitChain(chain, layout.seam)) {
        const closed = same(run.points[0] as UvPoint, run.points[run.points.length - 1] as UvPoint)
        const bevels = run.bevels.some((value) => Math.abs(value) > 1e-6)
          ? run.bevels.map((value) => [value, 0, 0, 0])
          : undefined
        result.push({ points: run.points, closed, bevels })
      }
    }
  }
  return result
}

function mergeCutRuns(cuts: StepCut[], seam: number): StepCut[] {
  const remaining = cuts.map((cut) => ({
    points: cut.points.map((point) => [...point] as UvPoint),
    closed: cut.closed,
    bevels: cut.bevels ? cut.bevels.map((value) => [...value]) : undefined,
  }))
  const merged: StepCut[] = []
  while (remaining.length > 0) {
    const current = remaining.shift()
    if (!current) break
    let changed = true
    while (changed) {
      changed = false
      const head = current.points[0] as UvPoint
      const tail = current.points[current.points.length - 1] as UvPoint
      for (let index = 0; index < remaining.length; index++) {
        const other = remaining[index]
        if (!other) continue
        const first = other.points[0] as UvPoint
        const last = other.points[other.points.length - 1] as UvPoint
        let points: UvPoint[] | null = null
        let bevels: number[][] | null = null
        const otherBevels = other.bevels ?? other.points.map(() => [0, 0, 0, 0])
        const currentBevels = current.bevels ?? current.points.map(() => [0, 0, 0, 0])
        const negate = (value: number[]): number[] =>
          value.length === 0 ? value : [-value[0], ...value.slice(1)]
        if (same(tail, first)) {
          points = [...current.points, ...other.points.slice(1)]
          bevels = [...currentBevels, ...otherBevels.slice(1)]
        } else if (same(tail, last)) {
          points = [...current.points, ...other.points.slice(0, -1).reverse()]
          bevels = [...currentBevels, ...otherBevels.slice(0, -1).reverse().map(negate)]
        } else if (same(head, last)) {
          points = [...other.points.slice(0, -1), ...current.points]
          bevels = [...otherBevels.slice(0, -1), ...currentBevels]
        } else if (same(head, first)) {
          points = [...other.points.slice(1).reverse(), ...current.points]
          bevels = [...otherBevels.slice(1).reverse().map(negate), ...currentBevels]
        }
        if (!points || !bevels) continue
        current.points = points
        current.bevels = bevels
        current.closed = same(points[0] as UvPoint, points[points.length - 1] as UvPoint)
        remaining.splice(index, 1)
        changed = true
        break
      }
    }
    // Split a run that crosses the seam so it never draws a line across the net.
    let runPoints: UvPoint[] = []
    let runBevels: number[][] = []
    const bevels = current.bevels ?? current.points.map(() => [0, 0, 0, 0])
    for (let index = 0; index < current.points.length; index++) {
      const point = current.points[index] as UvPoint
      const previous = current.points[index - 1]
      if (previous && Math.abs(point[0] - previous[0]) > seam / 2) {
        if (runPoints.length >= 2)
          merged.push({ points: runPoints, closed: false, bevels: runBevels })
        runPoints = []
        runBevels = []
      }
      runPoints.push(point)
      runBevels.push(bevels[index] ?? [0, 0, 0, 0])
    }
    if (runPoints.length >= 2)
      merged.push({
        points: runPoints,
        closed:
          current.closed &&
          same(runPoints[0] as UvPoint, runPoints[runPoints.length - 1] as UvPoint),
        bevels: runBevels,
      })
  }
  return merged
}

/** Translate the seated STEP model so its stock cross-section is centred on the section origin. */
export function centreSeatedCross(
  seated: SeatedStepGeometry,
  section: [number, number][],
): SeatedStepGeometry {
  const centres: [number, number][] = []
  for (const face of seated.faces) {
    if (face.planar || !face.cylinder) continue
    let on = 0
    let total = 0
    for (let index = 0; index + 2 < face.samples.length; index += 3) {
      const point: [number, number] = [
        dot(
          [
            face.samples[index] as number,
            face.samples[index + 1] as number,
            face.samples[index + 2] as number,
          ],
          seated.xAxis,
        ),
        dot(
          [
            face.samples[index] as number,
            face.samples[index + 1] as number,
            face.samples[index + 2] as number,
          ],
          seated.yAxis,
        ),
      ]
      total++
      if (distanceToOutline(section, point) <= 2) on++
    }
    if (total === 0 || on / total < 0.7) continue
    centres.push([dot(face.cylinder.center, seated.xAxis), dot(face.cylinder.center, seated.yAxis)])
  }
  if (centres.length === 0) return seated
  const cx = centres.reduce((sum, point) => sum + point[0], 0) / centres.length
  const cy = centres.reduce((sum, point) => sum + point[1], 0) / centres.length
  if (Math.abs(cx) < 0.02 && Math.abs(cy) < 0.02) return seated
  const shift = (point: [number, number, number]): [number, number, number] => [
    point[0] - cx * seated.xAxis[0] - cy * seated.yAxis[0],
    point[1] - cx * seated.xAxis[1] - cy * seated.yAxis[1],
    point[2] - cx * seated.xAxis[2] - cy * seated.yAxis[2],
  ]
  const shiftList = (points: number[]): number[] => {
    const out: number[] = []
    for (let index = 0; index + 2 < points.length; index += 3) {
      const shifted = shift([
        points[index] as number,
        points[index + 1] as number,
        points[index + 2] as number,
      ])
      out.push(shifted[0], shifted[1], shifted[2])
    }
    return out
  }
  return {
    ...seated,
    faces: seated.faces.map((face) => ({
      ...face,
      center: shift(face.center),
      samples: shiftList(face.samples),
      cylinder: face.cylinder
        ? { ...face.cylinder, center: shift(face.cylinder.center) }
        : undefined,
      wires: face.wires.map((wire) => ({
        ...wire,
        edges: wire.edges.map((edge) => ({ ...edge, points: shiftList(edge.points) })),
      })),
    })),
  }
}

export function partIrFromStepGeometry(
  seated: SeatedStepGeometry,
  options: FromStepIrOptions,
): PartIr | null {
  const profileType = profileTypeFor(options.profile)
  const section = options.section
  const layout = unrolledLayout(profileType, options.dimensions)
  if (!layout) return null
  const frame = frameForProfile(options.profile, section)
  const cuts =
    projectedCuts(seated, section, frame, layout, options.radius) ??
    wireCuts(seated, section, frame, layout)
  const features: PartFeature[] = []
  for (const cut of mergeCutRuns(cuts, layout.seam)) {
    if (cut.points.length < 2) continue
    features.push({
      kind: 'cut',
      chart: 'front',
      shape: { form: 'polyline', points: cut.points, closed: cut.closed },
      bevels: cut.bevels,
    })
  }
  const chart: PartChart = {
    id: 'front',
    role: 'front',
    faces: (['v', 'o', 'u', 'h'] as NcFace[]).filter((face) => layout.faces[face]),
    layout,
  }
  return {
    mark: options.mark,
    profile: options.profile,
    profileType,
    dimensions: options.dimensions,
    section,
    innerSection: options.innerSection,
    length: options.length,
    quantity: options.quantity ?? 1,
    charts: [chart],
    features,
    marks: [],
  }
}

/** Convenience: seat a meshed STEP and convert it to PartIR. */
export function partIrFromStepMesh(meshed: MeshedStep, options: FromStepIrOptions): PartIr | null {
  const seated = seatedStepGeometry(meshed, options.section)
  return partIrFromStepGeometry({ ...seated, length: options.length || seated.length }, options)
}
