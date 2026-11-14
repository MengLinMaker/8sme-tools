import { frameForProfile } from '@/lib/parsers/ncFaces'
import type { NcFace } from '@/lib/parsers/ncGeometry'
import type { MeshedStep } from '@/lib/step/mesh'
import { profileTypeFor, type SeatedStepGeometry, seatedStepGeometry } from '@/lib/wisecam/fromStep'
import { unrolledLayout } from '@/lib/wisecam/layout'
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
 * and converted from WiseCAM's wrapped station to the IR's centred station. This is the STEP
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
    { radius: options.radius, alongOffset: seated.alongOffset },
  )
  const runs: UvPoint[][] = []
  for (const cut of cuts) {
    const points: UvPoint[] = cut.points.map(([station, along]) => [
      centredStation(layout, station),
      along,
    ])
    if (points.length >= 2) runs.push(points)
  }
  const features: PartFeature[] = []
  const cutRuns: UvPoint[][] = []
  for (const points of dedupeRuns(runs)) {
    const loop = classifiedLoop(points, options.length)
    if (loop) features.push(loop)
    else cutRuns.push(points)
  }
  // Drop short cut fragments that lie on/inside a hole or slot: they are duplicate rim/wall
  // edges already represented by the classified feature.
  for (const points of cutRuns) {
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
