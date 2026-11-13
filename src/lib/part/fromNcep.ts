import type { NcFace } from '@/lib/parsers/ncGeometry'
import { profileTypeFor } from '@/lib/wisecam/fromStep'
import { unrolledLayout } from '@/lib/wisecam/layout'
import { parseNcepPackage } from '@/lib/wisecam/ncepParse'
import {
  centredStation,
  type PartChart,
  type PartFeature,
  type PartIr,
  type PartMark,
  type UvPoint,
} from './ir'

/**
 * WiseCAM NCEP → PartIR.
 *
 * An NCEP part SVG is already an unrolled net, so the import is mostly coordinate normalisation:
 * WiseCAM's station is converted to the IR's centred station, and its truncates/holes/marks become
 * canonical features. NCEP does not carry the full stock dimensions, so the caller supplies the
 * profile code/dims/section (the same ones a job/NC already has).
 */

export interface FromNcepIrOptions {
  /** Catalogue profile code, e.g. `PFC380*100`. */
  profile: string
  /** DSTV-header dimensions. */
  dimensions: number[]
  section: [number, number][]
  innerSection?: [number, number][]
  mark?: string
  quantity?: number
  /** Fallback member length when the part SVG has no along extent. */
  length?: number
}

function polyline(
  points: [number, number][],
  closed: boolean,
  chart: string,
  layout: ReturnType<typeof unrolledLayout>,
): PartFeature | null {
  if (!layout || points.length < 2) return null
  const uv: UvPoint[] = points.map(([station, along]) => [centredStation(layout, station), along])
  return {
    kind: 'cut',
    chart,
    shape: { form: 'polyline', points: uv, closed },
  }
}

export function partIrFromNcep(bytes: Uint8Array, options: FromNcepIrOptions): PartIr | null {
  const pkg = parseNcepPackage(bytes)
  const part = pkg.partSvg?.part
  if (!part) return null
  const profileType = profileTypeFor(options.profile)
  const layout = unrolledLayout(profileType, options.dimensions)
  if (!layout) return null
  const chartId = 'front'
  const chart: PartChart = {
    id: chartId,
    role: 'front',
    faces: (['v', 'o', 'u', 'h'] as NcFace[]).filter((face) => layout.faces[face]),
    layout,
  }

  const features: PartFeature[] = []
  let startCut: UvPoint[] | undefined
  let endCut: UvPoint[] | undefined
  for (const truncate of part.truncates) {
    const boundary = truncate.paths[0]?.points.map(([station, along]) => [
      centredStation(layout, station),
      along,
    ]) as UvPoint[] | undefined
    if (boundary && boundary.length >= 2) {
      if (truncate.truncateType === 0) startCut = boundary
      else endCut = boundary
    }
    for (const path of truncate.paths) {
      const feature = polyline(path.points, path.closed, chartId, layout)
      if (feature) features.push(feature)
    }
    for (const bevel of truncate.bevels ?? []) {
      for (const path of bevel.paths) {
        const feature = polyline(path.points, path.closed, chartId, layout)
        if (feature) features.push(feature)
      }
    }
  }
  for (const wire of part.wires) {
    for (const path of wire.paths) {
      const feature = polyline(path.points, path.closed, chartId, layout)
      if (feature) features.push(feature)
    }
  }
  for (const hole of part.holes) {
    features.push({
      kind: 'hole',
      chart: chartId,
      shape: {
        form: 'circle',
        center: [centredStation(layout, hole.cx), hole.cy],
        radius: hole.r,
      },
    })
  }

  const marks: PartMark[] = []
  for (const mark of part.marks) {
    if (mark.tag === 'text') {
      const value = (mark.text ?? mark.label ?? '').trim()
      if (!value) continue
      marks.push({
        kind: 'etch',
        block: 'SI',
        chart: chartId,
        shape: {
          form: 'polyline',
          points: [[centredStation(layout, mark.x ?? 0), mark.y ?? 0]],
          closed: false,
        },
        text: { value, height: mark.height ?? 0, angle: mark.rotate ?? 0 },
      })
      continue
    }
    for (const path of mark.paths) {
      const uv: UvPoint[] = path.points.map(([station, along]) => [
        centredStation(layout, station),
        along,
      ])
      if (uv.length < 2) continue
      marks.push({
        kind: 'marking',
        block: mark.corrected ? 'KO' : 'PU',
        chart: chartId,
        shape: { form: 'polyline', points: uv, closed: path.closed },
      })
    }
  }

  const along = pkg.partSvg?.extents.along
  const length = options.length ?? (along ? Math.max(...along) : 0)
  return {
    mark: options.mark ?? pkg.mark ?? 'part',
    profile: options.profile,
    profileType,
    dimensions: options.dimensions,
    section: options.section,
    innerSection: options.innerSection,
    length,
    quantity: options.quantity ?? pkg.quantity ?? 1,
    charts: [chart],
    features,
    marks,
    startCut,
    endCut,
  }
}
