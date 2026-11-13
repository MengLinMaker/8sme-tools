import type { NcContour, NcFace } from '@/lib/parsers/ncGeometry'
import {
  acrossAtCenteredStation,
  centeredStationRange,
  faceAtCenteredStation,
} from '@/lib/wisecam/layout'
import {
  buildNcex,
  type NcexCut,
  type NcexHole,
  type NcexMark,
  type NcexPart,
} from '@/lib/wisecam/ncex'
import { developEndCut } from '@/lib/wisecam/surface'
import { chartById, ncepStation, type PartChart, type PartIr, type UvPoint } from './ir'

/**
 * PartIR → WiseCAM NCEP part.
 *
 * The IR is already unrolled, so this is mostly the inverse station convention plus the NCEP
 * writer's expected feature split. Shaped start/end trims are derived from the IR's outer cut
 * contours with the same NC-end development used by the legacy NC path; NCEP-sourced IR carries
 * them directly.
 */

const TYPE_CODE: Record<string, number> = { I: 8200, U: 8199, M: 8195 }

export interface ToNcepOptions {
  mark?: string
  stockLength?: number
  rotateAngle?: number
  invert?: boolean
}

function frontChart(part: PartIr): PartChart | undefined {
  return chartById(part, 'front') ?? part.charts[0]
}

/** A set of IR stations mapped into WiseCAM's NCEP station convention. */
function toNcepPoints(layout: PartChart['layout'], points: UvPoint[]): UvPoint[] {
  return points.map(([station, along]) => [ncepStation(layout, station), along])
}

/** The single face that contains every station of a cut contour, if there is one. */
function faceForPoints(chart: PartChart, points: UvPoint[]): NcFace | null {
  const tolerance = Math.max(2, chart.layout.seam * 0.02)
  for (const face of chart.faces) {
    const range = centeredStationRange(chart.layout, face)
    if (!range) continue
    if (
      points.every(
        ([station]) => station >= range[0] - tolerance && station <= range[1] + tolerance,
      )
    )
      return face
  }
  return null
}

/** Rebuild the face-space outer contours the NC end development expects. */
function endContours(part: PartIr, chart: PartChart): NcContour[] {
  const contours: NcContour[] = []
  for (const feature of part.features) {
    if (feature.chart !== chart.id || feature.kind !== 'cut' || feature.contour === 'inner')
      continue
    if (feature.shape.form !== 'polyline' || !feature.shape.closed) continue
    const face = faceForPoints(chart, feature.shape.points)
    if (!face) continue
    const points: [number, number][] = []
    for (const [station, along] of feature.shape.points) {
      const y = acrossAtCenteredStation(chart.layout, face, station)
      if (y == null) break
      points.push([along, y])
    }
    if (points.length < 2) continue
    contours.push({
      face,
      kind: 'outer',
      points,
      bevels: feature.bevels ?? points.map(() => [0, 0, 0, 0]),
      radii: feature.shape.radii,
    })
  }
  return contours
}

function derivedEnds(part: PartIr, chart: PartChart): { start?: UvPoint[]; end?: UvPoint[] } {
  const contours = endContours(part, chart)
  if (contours.length === 0) return {}
  const wall = part.dimensions[2] ?? 0
  return {
    start: developEndCut(chart.layout, contours, part.length, 'start', wall) ?? undefined,
    end: developEndCut(chart.layout, contours, part.length, 'end', wall) ?? undefined,
  }
}

/** Convert a canonical PartIR into the writer's NCEP part shape. */
export function partIrToNcepPart(part: PartIr, options: ToNcepOptions = {}): NcexPart | null {
  const chart = frontChart(part)
  if (!chart) return null
  const layout = chart.layout

  const holes: NcexHole[] = []
  const cuts: NcexCut[] = []
  for (const feature of part.features) {
    if (feature.chart !== chart.id) continue
    if (feature.kind === 'hole' || feature.kind === 'slot') {
      if (feature.shape.form === 'circle') {
        if (!(feature.shape.radius > 0)) continue
        holes.push({
          station: ncepStation(layout, feature.shape.center[0]),
          along: feature.shape.center[1],
          radius: feature.shape.radius,
        })
      } else if (feature.shape.form === 'slot' && feature.shape.radius > 0) {
        // NCEP's writer currently carries circular holes; keep the slot centre/radius visible.
        holes.push({
          station: ncepStation(layout, feature.shape.center[0]),
          along: feature.shape.center[1],
          radius: feature.shape.radius,
        })
      }
      continue
    }
    if (feature.shape.form !== 'polyline') continue
    cuts.push({
      kind: feature.contour === 'inner' ? 'inner' : 'outer',
      points: toNcepPoints(layout, feature.shape.points),
    })
  }

  const marks: NcexMark[] = []
  for (const mark of part.marks) {
    if (mark.chart !== chart.id || mark.shape.form !== 'polyline') continue
    const points = toNcepPoints(layout, mark.shape.points)
    if (mark.text) {
      const hit = faceAtCenteredStation(layout, mark.shape.points[0]?.[0] ?? 0)
      marks.push({
        kind: mark.kind,
        points,
        text: {
          ...mark.text,
          reversed: hit ? (layout.faces[hit.face]?.reversed ?? false) : false,
        },
      })
    } else {
      marks.push({ kind: mark.kind, points })
    }
  }

  const derived = derivedEnds(part, chart)
  const startCut = part.startCut ? toNcepPoints(layout, part.startCut) : derived.start
  const endCut = part.endCut ? toNcepPoints(layout, part.endCut) : derived.end
  const profileType = part.profileType.trim().toUpperCase()
  const [, , legThickness, thickness] = part.dimensions
  return {
    mark: options.mark ?? part.mark,
    profile: part.profile,
    profileType,
    typeCode: TYPE_CODE[profileType] ?? 8195,
    length: part.length,
    quantity: part.quantity,
    thickness: thickness ?? 0,
    legThickness: profileType === 'M' ? 2 : (legThickness ?? 0),
    grade: part.grade,
    section: part.section,
    innerSection: part.innerSection,
    holes,
    marks,
    cuts,
    startCut,
    endCut,
    unrolledPerimeter: layout.seam,
    unrolled: layout,
    rotateAngle: options.rotateAngle,
    invert: options.invert,
    stockLength: options.stockLength,
    rCornerMaxRadius: profileType === 'M' ? (part.dimensions[4] ?? 0) : 5,
    rootRadius: part.dimensions[4] ?? 0,
  }
}

/** Write a canonical PartIR as an NCEP (`.ncep`) package. */
export function buildNcepFromIr(part: PartIr, options: ToNcepOptions = {}): Uint8Array | null {
  const ncep = partIrToNcepPart(part, options)
  return ncep ? buildNcex([ncep], { flavour: 'ncep' }) : null
}
