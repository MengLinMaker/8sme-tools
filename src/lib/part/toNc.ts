import type { NcFace } from '@/lib/parsers/ncGeometry'
import {
  acrossAtCenteredStation,
  centeredStationRange,
  faceAtCenteredStation,
} from '@/lib/wisecam/layout'
import {
  chartById,
  type PartChart,
  type PartFeature,
  type PartIr,
  type PartMark,
  type UvPoint,
} from './ir'

/**
 * PartIR → DSTV NC.
 *
 * The IR is canonical UV; this is the inverse projection. Each feature point is mapped back to a
 * DSTV face + authored across coordinate through the chart layout, then split where a contour
 * changes face. Holes/slots use the same inverse; marks are written to their original block when
 * known (`SI`/`PU`/`KO`), otherwise `PU`.
 *
 * Output is a clean canonical NC (not byte-identical to the source), but it carries the same
 * geometry: contours, radii, bevels, refs, holes/slots, notches, marks and quantity.
 */

const n2 = (value: number): string => (Math.abs(value) < 0.005 ? '0.00' : value.toFixed(2))

/** Header values are not face geometry; preserve their authored precision instead of rounding. */
const headerNumber = (value: number): string => Number(value.toFixed(6)).toString()

interface FacePoint {
  face: NcFace
  x: number
  y: number
}

function inverse(chart: PartChart, point: UvPoint): FacePoint | null {
  // Prefer a face whose interior contains the station; boundary stations are shared by two faces.
  for (const face of chart.faces) {
    const range = centeredStationRange(chart.layout, face)
    if (!range) continue
    if (point[0] <= range[0] + 0.005 || point[0] >= range[1] - 0.005) continue
    const y = acrossAtCenteredStation(chart.layout, face, point[0])
    if (y != null) return { face, x: point[1], y }
  }
  // Small overshoots at mitres/corners: clamp to the nearest face edge instead of dropping it.
  const tolerance = Math.max(2, chart.layout.seam * 0.02)
  let best: { face: NcFace; distance: number } | null = null
  for (const face of chart.faces) {
    const range = centeredStationRange(chart.layout, face)
    if (!range) continue
    const distance =
      point[0] < range[0] ? range[0] - point[0] : point[0] > range[1] ? point[0] - range[1] : 0
    if (!best || distance < best.distance) best = { face, distance }
  }
  if (best && best.distance <= tolerance) {
    const y = acrossAtCenteredStation(chart.layout, best.face, point[0])
    if (y != null) return { face: best.face, x: point[1], y }
  }
  const hit = faceAtCenteredStation(chart.layout, point[0])
  return hit ? { face: hit.face, x: point[1], y: hit.y } : null
}

/** The single face that best contains every station of a feature, if there is one. */
function commonFace(chart: PartChart, stations: number[]): NcFace | null {
  const tolerance = Math.max(2, chart.layout.seam * 0.02)
  let best: { face: NcFace; count: number } | null = null
  for (const face of chart.faces) {
    const range = centeredStationRange(chart.layout, face)
    if (!range) continue
    const count = stations.filter(
      (station) => station >= range[0] - tolerance && station <= range[1] + tolerance,
    ).length
    if (count === stations.length) return face
    if (!best || count > best.count) best = { face, count }
  }
  return best && best.count / stations.length >= 0.8 ? best.face : null
}

function bevelFields(bevel: number[] | undefined): string {
  const values = bevel && bevel.length > 0 ? bevel : [0, 0, 0, 0]
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0].map(n2).join(' ')
}

function contourLines(feature: PartFeature, points: FacePoint[], indices: number[]): string[] {
  const shape = feature.shape
  const radii = shape.form === 'polyline' ? shape.radii : undefined
  const lines: string[] = []
  for (const index of indices) {
    const point = points[index] as FacePoint
    const ref = feature.refs?.[index] ?? ''
    const radius = radii?.[index] ?? 0
    const bevel = bevelFields(feature.bevels?.[index])
    // DSTV: face, X, Y, radius, then the four welding-prep fields.
    lines.push(`  ${point.face} ${n2(point.x)}${ref} ${n2(point.y)} ${n2(radius)} ${bevel}`)
  }
  return lines
}

/** Consecutive same-face runs; a closed loop with mixed faces starts at a face change. */
function faceRuns(points: FacePoint[], closed: boolean): { indices: number[]; face: NcFace }[] {
  if (points.length === 0) return []
  if (!closed) {
    const runs: { indices: number[]; face: NcFace }[] = []
    for (const [index, point] of points.entries()) {
      const last = runs[runs.length - 1]
      if (last && last.face === point.face) last.indices.push(index)
      else runs.push({ indices: [index], face: point.face })
    }
    return runs
  }
  const same = points.every((point) => point.face === (points[0] as FacePoint).face)
  if (same)
    return [{ indices: points.map((_, index) => index), face: (points[0] as FacePoint).face }]
  let start = 0
  for (let index = 0; index < points.length; index++) {
    const previous = points[(index + points.length - 1) % points.length] as FacePoint
    if ((points[index] as FacePoint).face !== previous.face) {
      start = index
      break
    }
  }
  const runs: { indices: number[]; face: NcFace }[] = []
  for (let step = 0; step < points.length; step++) {
    const index = (start + step) % points.length
    const point = points[index] as FacePoint
    const last = runs[runs.length - 1]
    if (last && last.face === point.face) last.indices.push(index)
    else runs.push({ indices: [index], face: point.face })
  }
  return runs
}

function featureBlocks(feature: PartFeature, chart: PartChart): string[] {
  const blocks: string[] = []
  if (feature.kind === 'hole') {
    if (feature.shape.form !== 'circle') return blocks
    const center = inverse(chart, feature.shape.center)
    if (!center) return blocks
    const diameter = feature.shape.radius * 2
    const type = feature.holeType ?? ''
    const extra = type === 'l' && feature.extra?.length ? ` ${feature.extra.map(n2).join(' ')}` : ''
    blocks.push(
      `BO\r\n  ${center.face} ${n2(center.x)} ${n2(center.y)} ${n2(diameter)} 0.00${type}${extra}`,
    )
    return blocks
  }
  if (feature.kind === 'slot') {
    if (feature.shape.form !== 'slot') return blocks
    const center = inverse(chart, feature.shape.center)
    const far = inverse(chart, feature.shape.far)
    if (!center || !far || center.face !== far.face) return blocks
    const dx = far.x - center.x
    const dy = far.y - center.y
    const diameter = feature.shape.radius * 2
    blocks.push(
      `BO\r\n  ${center.face} ${n2(center.x)} ${n2(center.y)} ${n2(diameter)} 0.00l ${n2(dx)} ${n2(dy)} 0.00`,
    )
    return blocks
  }
  if (feature.kind === 'notch') {
    if (feature.shape.form !== 'polyline') return blocks
    const point = inverse(chart, feature.shape.points[0] ?? [0, 0])
    if (!point) return blocks
    const suffix = feature.notch ?? 't'
    blocks.push(`AK\r\n  ${point.face} ${n2(point.x)}${suffix} ${n2(point.y)}`)
    return blocks
  }
  if (feature.shape.form !== 'polyline') return blocks
  const kind = feature.contour === 'inner' ? 'IK' : 'AK'
  const common = commonFace(
    chart,
    feature.shape.points.map((point) => point[0]),
  )
  if (common) {
    const points: FacePoint[] = []
    for (const point of feature.shape.points) {
      const y = acrossAtCenteredStation(chart.layout, common, point[0])
      if (y == null) return blocks
      points.push({ face: common, x: point[1], y })
    }
    const lines = contourLines(
      feature,
      points,
      feature.shape.points.map((_, index) => index),
    )
    blocks.push([kind, ...lines].join('\r\n'))
    return blocks
  }
  const mapped: FacePoint[] = []
  for (const point of feature.shape.points) {
    const hit = inverse(chart, point)
    if (!hit) return blocks
    mapped.push(hit)
  }
  for (const run of faceRuns(mapped, feature.shape.closed)) {
    if (run.indices.length < 2) continue
    const lines = contourLines(feature, mapped, run.indices)
    blocks.push([kind, ...lines].join('\r\n'))
  }
  return blocks
}

function markBlocks(mark: PartMark, chart: PartChart): string[] {
  if (mark.shape.form !== 'polyline') return []
  if (mark.text) {
    const point = inverse(chart, mark.shape.points[0] ?? [0, 0])
    if (!point) return []
    return [
      `SI\r\n  ${point.face} ${n2(point.x)} ${n2(point.y)} ${n2(mark.text.angle)} ${n2(mark.text.height)} ${mark.text.value}`,
    ]
  }
  const code = mark.block ?? 'PU'
  const common = commonFace(
    chart,
    mark.shape.points.map((point) => point[0]),
  )
  if (common) {
    const points: FacePoint[] = []
    for (const point of mark.shape.points) {
      const y = acrossAtCenteredStation(chart.layout, common, point[0])
      if (y == null) return []
      points.push({ face: common, x: point[1], y })
    }
    const lines = points.map((point) => `  ${point.face} ${n2(point.x)} ${n2(point.y)} 0.00`)
    return [[code, ...lines].join('\r\n')]
  }
  const points: FacePoint[] = []
  for (const point of mark.shape.points) {
    const hit = inverse(chart, point)
    if (!hit) return []
    points.push(hit)
  }
  if (points.length < 2) return []
  const lines = points.map((point) => `  ${point.face} ${n2(point.x)} ${n2(point.y)} 0.00`)
  return [[code, ...lines].join('\r\n')]
}

/** Serialise a canonical PartIR as a DSTV `.nc1` string. */
export function partIrToNc(part: PartIr): string {
  const header: string[] = [
    'ST',
    `** ${part.mark}.nc1`,
    `  ${part.orderId ?? '0'}`,
    `  ${part.mark}`,
    `  ${part.mark}`,
    '  1',
    `  ${part.grade ?? ''}`,
    `  ${part.quantity}`,
    `  ${part.profile}`,
    `  ${part.profileType}`,
    `    ${headerNumber(part.length)}`,
    ...part.dimensions.map((value) => `    ${headerNumber(value)}`),
  ]

  const blocks: string[] = []
  for (const feature of part.features) {
    const chart = chartById(part, feature.chart)
    if (!chart) continue
    blocks.push(...featureBlocks(feature, chart))
  }
  for (const mark of part.marks) {
    const chart = chartById(part, mark.chart)
    if (!chart) continue
    blocks.push(...markBlocks(mark, chart))
  }

  return [...header, ...blocks, 'EN'].join('\r\n')
}
