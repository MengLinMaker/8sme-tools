import {
  faceHalf,
  faceSpanAxis,
  frameForProfile,
  ncAuthoredAcrossSign,
  resolveFaceSign,
} from '@/lib/parsers/ncFaces'
import type { NcFace } from '@/lib/parsers/ncGeometry'
import type { Vec3 } from '@/lib/step/cutEdges'
import type { MeshedStep } from '@/lib/step/mesh'
import { profileTypeFor, type SeatedStepGeometry, seatedStepGeometry } from '@/lib/wisecam/fromStep'
import { centeredStationFor, type UnrolledLayout, unrolledLayout } from '@/lib/wisecam/layout'
import { developStepCutEdges } from '@/lib/wisecam/surface'
import { centredStation, type PartChart, type PartFeature, type PartIr, type UvPoint } from './ir'

function distanceToSegment(point: UvPoint, a: UvPoint, b: UvPoint): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length2 = dx * dx + dy * dy
  let t = length2 > 0 ? ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))
}

/** Drops STEP rim segments that repeat an already-emitted segment (corner faces overlap flats). */
function dedupeRuns(runs: UvPoint[][], tolerance = 0.3): UvPoint[][] {
  const kept: [UvPoint, UvPoint][] = []
  const out: UvPoint[][] = []
  for (const run of runs) {
    let current: UvPoint[] = []
    for (let index = 0; index + 1 < run.length; index++) {
      const a = run[index] as UvPoint
      const b = run[index + 1] as UvPoint
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05) continue
      const repeated = kept.some(
        ([ka, kb]) =>
          distanceToSegment(a, ka, kb) < tolerance && distanceToSegment(b, ka, kb) < tolerance,
      )
      if (repeated) {
        if (current.length >= 2) out.push(current)
        current = []
        continue
      }
      kept.push([a, b])
      if (current.length === 0) current.push(a)
      current.push(b)
    }
    if (current.length >= 2) out.push(current)
  }
  return out
}

function pointSegmentDistance(point: UvPoint, a: UvPoint, b: UvPoint): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length2 = dx * dx + dy * dy
  let t = length2 > 0 ? ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))
}

/** True when a cut-run point is inside or on a classified hole/slot. */
function insideFeature(point: UvPoint, feature: PartFeature, tolerance = 0.5): boolean {
  if (feature.kind === 'hole' && feature.shape.form === 'circle') {
    const { center, radius } = feature.shape
    return Math.hypot(point[0] - center[0], point[1] - center[1]) <= radius + tolerance
  }
  if (feature.kind === 'slot' && feature.shape.form === 'slot') {
    const { center, far, radius } = feature.shape
    return pointSegmentDistance(point, center, far) <= radius + tolerance
  }
  return false
}

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Holes/slots from the BREP cylinder faces themselves, not from chained rim loops. */
function cylinderFeatures(
  seated: SeatedStepGeometry,
  layout: UnrolledLayout,
  frame: ReturnType<typeof frameForProfile>,
  section: [number, number][],
  alongOffset: number,
): PartFeature[] {
  const cylinders = seated.faces
    .filter((face) => face.cylinder)
    .map((face) => {
      const closed = face.wires.some((wire) =>
        wire.edges.some((edge) => {
          const count = edge.points.length / 3
          if (count < 3) return false
          return (
            Math.hypot(
              (edge.points[0] as number) - (edge.points[(count - 1) * 3] as number),
              (edge.points[1] as number) - (edge.points[(count - 1) * 3 + 1] as number),
              (edge.points[2] as number) - (edge.points[(count - 1) * 3 + 2] as number),
            ) < 0.2
          )
        }),
      )
      return {
        center: face.cylinder?.center as Vec3,
        axis: face.cylinder?.axis as Vec3,
        radius: face.cylinder?.radius as number,
        closed,
      }
    })
    .filter(
      (cylinder) =>
        cylinder.radius > 0.5 &&
        cylinder.radius < 40 &&
        Math.abs(dot3(cylinder.axis, seated.memberAxis)) / (Math.hypot(...cylinder.axis) || 1) <
          0.5,
    )
  if (cylinders.length === 0) return []

  let cx = 0
  let cy = 0
  for (const point of section) {
    cx += point[0]
    cy += point[1]
  }
  cx /= section.length || 1
  cy /= section.length || 1
  const centroid: Vec3 = [
    cx * seated.xAxis[0] + cy * seated.yAxis[0],
    cx * seated.xAxis[1] + cy * seated.yAxis[1],
    cx * seated.xAxis[2] + cy * seated.yAxis[2],
  ]
  const planes = (['v', 'o', 'u', 'h'] as NcFace[]).map((face) => {
    const spanAxis = faceSpanAxis(frame, face)
    const axis = (1 - spanAxis) as 0 | 1
    const sign = resolveFaceSign(frame, section, face)
    const base = axis === 0 ? seated.xAxis : seated.yAxis
    const spanVec = spanAxis === 0 ? seated.xAxis : seated.yAxis
    return {
      face,
      normal: [base[0] * sign, base[1] * sign, base[2] * sign] as Vec3,
      spanVec: spanVec as Vec3,
      q: faceHalf(frame, axis),
      halfSpan: faceHalf(frame, spanAxis),
      acrossSign: ncAuthoredAcrossSign(frame, face),
    }
  })
  const planeFor = (center: Vec3): (typeof planes)[number] | null => {
    let best: (typeof planes)[number] | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const plane of planes) {
      const score = dot3(plane.normal, [
        center[0] - centroid[0],
        center[1] - centroid[1],
        center[2] - centroid[2],
      ])
      if (score > bestScore) {
        bestScore = score
        best = plane
      }
    }
    return best
  }
  const uvOnPlane = (center: Vec3, axis: Vec3, plane: (typeof planes)[number]): UvPoint | null => {
    const denom = dot3(axis, plane.normal)
    const t = Math.abs(denom) > 0.2 ? (plane.q - dot3(center, plane.normal)) / denom : 0
    const point: Vec3 = [center[0] + t * axis[0], center[1] + t * axis[1], center[2] + t * axis[2]]
    const station = centeredStationFor(
      layout,
      plane.face,
      plane.halfSpan + plane.acrossSign * dot3(point, plane.spanVec),
    )
    return station == null ? null : [station, dot3(point, seated.memberAxis) + alongOffset]
  }

  const features: PartFeature[] = []
  const used = new Set<number>()
  // Pair only open half-cylinders at exactly one diameter apart: those are slot ends.
  for (let index = 0; index < cylinders.length; index++) {
    if (used.has(index)) continue
    const a = cylinders[index] as (typeof cylinders)[number]
    let mate = -1
    for (let other = index + 1; other < cylinders.length; other++) {
      if (used.has(other)) continue
      const b = cylinders[other] as (typeof cylinders)[number]
      if (a.closed || b.closed) continue
      if (Math.abs(a.radius - b.radius) > 0.2) continue
      if (
        Math.abs(dot3(a.axis, b.axis)) /
          ((Math.hypot(...a.axis) || 1) * (Math.hypot(...b.axis) || 1)) <
        0.99
      )
        continue
      const separation = Math.hypot(
        a.center[0] - b.center[0],
        a.center[1] - b.center[1],
        a.center[2] - b.center[2],
      )
      if (Math.abs(separation - 2 * a.radius) > 1.5) continue
      mate = other
      break
    }
    used.add(index)
    if (mate >= 0) {
      const b = cylinders[mate] as (typeof cylinders)[number]
      const midpoint: Vec3 = [
        (a.center[0] + b.center[0]) / 2,
        (a.center[1] + b.center[1]) / 2,
        (a.center[2] + b.center[2]) / 2,
      ]
      const plane = planeFor(midpoint)
      if (!plane) continue
      const pa = uvOnPlane(a.center, a.axis, plane)
      const pb = uvOnPlane(b.center, b.axis, plane)
      used.add(mate)
      if (!pa || !pb) continue
      // Keep the pair in canonical order so the slot centre matches the NC representation.
      const [center, far] =
        pa[0] < pb[0] || (pa[0] === pb[0] && pa[1] <= pb[1]) ? [pa, pb] : [pb, pa]
      features.push({
        kind: 'slot',
        chart: 'front',
        shape: { form: 'slot', center, far, radius: a.radius },
      })
      continue
    }
    // A closed cylinder rim is a hole. Unpaired open cylinders are rounded cuts, not holes.
    if (!a.closed) continue
    const plane = planeFor(a.center)
    if (!plane) continue
    const center = uvOnPlane(a.center, a.axis, plane)
    if (!center) continue
    features.push({
      kind: 'hole',
      chart: 'front',
      shape: { form: 'circle', center, radius: a.radius },
    })
  }
  return features
}

/** Joins runs whose endpoints meet at a face boundary, so an end cut is one continuous polyline. */
function mergeRuns(runs: UvPoint[][], tolerance = 5): UvPoint[][] {
  const list = runs.map((run) => [...run])
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as UvPoint[]
        const b = list[j] as UvPoint[]
        const a0 = a[0] as UvPoint
        const a1 = a[a.length - 1] as UvPoint
        const b0 = b[0] as UvPoint
        const b1 = b[b.length - 1] as UvPoint
        const distance = (p: UvPoint, q: UvPoint): number => Math.hypot(p[0] - q[0], p[1] - q[1])
        const options: [number, boolean, boolean][] = [
          [distance(a1, b0), false, false],
          [distance(a1, b1), false, true],
          [distance(a0, b0), true, false],
          [distance(a0, b1), true, true],
        ]
        options.sort((left, right) => left[0] - right[0])
        const best = options[0]
        if (!best || best[0] > tolerance) continue
        const first = best[1] ? [...a].reverse() : a
        const second = best[2] ? [...b].reverse() : b
        list.splice(j, 1)
        list[i] = [...first, ...second]
        merged = true
        break outer
      }
    }
  }
  return list
}

/** A closed, small rim loop is a hole or slot; end cuts are left as cut polylines. */
function classifiedLoop(points: UvPoint[], length: number): PartFeature | null {
  if (points.length < 6) return null
  const first = points[0] as UvPoint
  const last = points[points.length - 1] as UvPoint
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1) return null
  const stations = points.map((point) => point[0])
  const alongs = points.map((point) => point[1])
  const minS = Math.min(...stations)
  const maxS = Math.max(...stations)
  const minA = Math.min(...alongs)
  const maxA = Math.max(...alongs)
  const width = maxS - minS
  const height = maxA - minA
  if (width < 1 || height < 1 || width > 80 || height > 80) return null
  if (minA < 20 || maxA > length - 20) return null
  const cx = (minS + maxS) / 2
  const cy = (minA + maxA) / 2
  let rMin = Number.POSITIVE_INFINITY
  let rMax = 0
  let rSum = 0
  for (const point of points) {
    const radius = Math.hypot(point[0] - cx, point[1] - cy)
    rMin = Math.min(rMin, radius)
    rMax = Math.max(rMax, radius)
    rSum += radius
  }
  const radius = rSum / points.length
  if (rMax - rMin < 0.6 && width / height > 0.9 && width / height < 1.1) {
    return {
      kind: 'hole',
      chart: 'front',
      shape: { form: 'circle', center: [cx, cy], radius },
    }
  }
  if (Math.max(width, height) < Math.min(width, height) * 1.15) return null
  const slotRadius = Math.min(width, height) / 2
  if (slotRadius < 0.5) return null
  const half = (Math.max(width, height) - 2 * slotRadius) / 2
  const center: UvPoint = width >= height ? [cx - half, cy] : [cx, cy - half]
  const far: UvPoint = width >= height ? [cx + half, cy] : [cx, cy + half]
  return {
    kind: 'slot',
    chart: 'front',
    shape: { form: 'slot', center, far, radius: slotRadius },
  }
}

/**
 * STEP → PartIR (cut boundaries).
 *
 * The real part's cut edges are projected onto the stock faces (the same
 * `projectCutEdgesToFaces` pass the 3D viewer uses), then developed by the shared surface core
 * and converted from WiseCAM's wrapped station to the IR's centred station.
 *
 * Do **not** add a second IR-only projection variant. The 3-D viewer and IR diverged once when
 * this file used a rim-preserving projection; see `docs/architecture.md` §16. The projection
 * keeps the cut-plane trace (sharp-corner convention) on purpose.
 *
 * Through holes/slots are collapsed to the nearest outer-face rim inside `projectCutEdgesToFaces`.
 * Here, closed rims become `hole`/`slot`; cut runs wholly inside one are duplicate interior edges
 * and are dropped.
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

export function partIrFromStepGeometry(
  seated: SeatedStepGeometry,
  options: FromStepIrOptions,
): PartIr | null {
  const profileType = profileTypeFor(options.profile)
  const layout = unrolledLayout(profileType, options.dimensions)
  if (!layout) return null
  const section = options.section
  const frame = frameForProfile(options.profile, section)
  const cuts = developStepCutEdges(
    { ...seated, section, frame, layout },
    {
      radius: options.radius,
      alongOffset: seated.alongOffset,
      includeInner: profileType === 'U',
    },
  )
  const runs: UvPoint[][] = []
  for (const cut of cuts) {
    const points: UvPoint[] = cut.points.map(([station, along]) => [
      centredStation(layout, station),
      along,
    ])
    if (points.length >= 2) runs.push(points)
  }
  const features: PartFeature[] = cylinderFeatures(
    seated,
    layout,
    frame,
    section,
    seated.alongOffset,
  )
  const cutRuns: UvPoint[][] = []
  for (const points of dedupeRuns(runs)) {
    // A rim loop for a hole/slot is already represented by the exact cylinder feature.
    if (points.every((point) => features.some((feature) => insideFeature(point, feature)))) {
      continue
    }
    const loop = classifiedLoop(points, options.length)
    if (loop) features.push(loop)
    else cutRuns.push(points)
  }
  // Drop short cut fragments that lie on/inside a hole or slot: they are duplicate rim/wall
  // edges already represented by the classified feature. Merge the remaining runs across face
  // boundaries so the IR draws a continuous end cut instead of separate per-face chains.
  for (const points of mergeRuns(cutRuns)) {
    if (points.every((point) => features.some((feature) => insideFeature(point, feature)))) continue
    features.push({
      kind: 'cut',
      chart: 'front',
      shape: { form: 'polyline', points, closed: false },
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
