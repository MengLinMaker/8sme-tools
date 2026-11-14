import type { NcContour, NcFace, NcGeometry, NcMark, NcNotch } from '@/lib/parsers/ncGeometry'
import {
  acrossAtCenteredStation,
  centeredStationRange,
  faceAtCenteredStation,
} from '@/lib/wisecam/layout'
import type { PartChart, PartFeature, PartIr, UvPoint } from './ir'

/**
 * PartIR → face-space NC geometry, for the viewer's existing projection pipeline.
 *
 * This is a pure coordinate transform: chart stations become DSTV face + authored across, and the
 * canonical features become the same `NcGeometry` the 3D projector already understands. The IR is
 * therefore the source of truth for both unrolled and projected cut lines.
 */

interface FacePoint {
  face: NcFace
  x: number
  y: number
}

function inverse(chart: PartChart, point: UvPoint): FacePoint | null {
  for (const face of chart.faces) {
    const range = centeredStationRange(chart.layout, face)
    if (!range) continue
    if (point[0] <= range[0] + 0.005 || point[0] >= range[1] - 0.005) continue
    const y = acrossAtCenteredStation(chart.layout, face, point[0])
    if (y != null) return { face, x: point[1], y }
  }
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

function contoursFor(feature: PartFeature, chart: PartChart): NcContour[] {
  if (feature.shape.form !== 'polyline') return []
  const points = feature.shape.points
  const radii = feature.shape.radii
  const face = commonFace(
    chart,
    points.map(([station]) => station),
  )
  const make = (mapped: [number, number][], faceName: NcFace, indices: number[]): NcContour => ({
    face: faceName,
    kind: feature.contour === 'inner' ? 'inner' : 'outer',
    points: mapped,
    bevels: indices.map((index) => feature.bevels?.[index] ?? [0, 0, 0, 0]),
    radii: indices.map((index) => radii?.[index] ?? 0),
    refs: indices.map((index) => feature.refs?.[index] ?? null),
  })
  if (face) {
    const mapped: [number, number][] = []
    for (const [station, along] of points) {
      const y = acrossAtCenteredStation(chart.layout, face, station)
      if (y == null) return []
      mapped.push([along, y])
    }
    return [
      make(
        mapped,
        face,
        points.map((_, index) => index),
      ),
    ]
  }

  // A merged STEP run can span several DSTV faces; split it into per-face contours.
  const mapped: { face: NcFace; point: [number, number]; index: number }[] = []
  for (const [index, point] of points.entries()) {
    const hit = inverse(chart, point)
    if (!hit) continue
    mapped.push({ face: hit.face, point: [hit.x, hit.y], index })
  }
  const contours: NcContour[] = []
  let run: typeof mapped = []
  const flush = (): void => {
    if (run.length >= 2) {
      const faceName = (run[0] as (typeof mapped)[number]).face
      contours.push(
        make(
          run.map((entry) => entry.point),
          faceName,
          run.map((entry) => entry.index),
        ),
      )
    }
    run = []
  }
  for (const entry of mapped) {
    if (run.length > 0 && entry.face !== (run[0] as (typeof mapped)[number]).face) flush()
    run.push(entry)
  }
  flush()
  return contours
}

export function partIrToNcGeometry(part: PartIr): NcGeometry {
  const contours: NcContour[] = []
  const holes: NcGeometry['holes'] = []
  const notches: NcNotch[] = []
  const marks: NcMark[] = []

  for (const chart of part.charts) {
    for (const feature of part.features) {
      if (feature.chart !== chart.id) continue
      if (feature.kind === 'notch') {
        if (feature.shape.form !== 'polyline') continue
        const hit = inverse(chart, feature.shape.points[0] ?? [0, 0])
        if (hit) notches.push({ face: hit.face, x: hit.x, y: hit.y, type: feature.notch ?? 't' })
        continue
      }
      if (feature.kind === 'hole' || feature.kind === 'slot') {
        if (feature.shape.form === 'circle') {
          const hit = inverse(chart, feature.shape.center)
          if (hit)
            holes.push({ face: hit.face, x: hit.x, y: hit.y, diameter: feature.shape.radius * 2 })
        } else if (feature.shape.form === 'slot') {
          const center = inverse(chart, feature.shape.center)
          const far = inverse(chart, feature.shape.far)
          if (!center || !far || center.face !== far.face) continue
          const dx = far.x - center.x
          const dy = far.y - center.y
          holes.push({
            face: center.face,
            x: center.x,
            y: center.y,
            diameter: feature.shape.radius * 2,
            slot: { dx, dy, angle: 0 },
          })
        }
        continue
      }
      contours.push(...contoursFor(feature, chart))
    }

    for (const mark of part.marks) {
      if (mark.chart !== chart.id || mark.shape.form !== 'polyline') continue
      const points: [number, number][] = []
      let face: NcFace | null = null
      for (const point of mark.shape.points) {
        const hit = inverse(chart, point)
        if (!hit) continue
        face = hit.face
        points.push([hit.x, hit.y])
      }
      if (!face || points.length === 0) continue
      marks.push({
        face,
        kind: mark.kind,
        block: mark.block,
        points,
        text: mark.text ? { ...mark.text } : undefined,
      })
    }
  }

  return { contours, holes, notches, marks }
}
