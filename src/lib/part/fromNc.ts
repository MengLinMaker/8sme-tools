import { parseDstv } from '@/lib/parsers/dstv'
import { faceSpanAxis, ncAuthoredAcrossSign, resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { type NcFace, parseNcGeometry, slotOffset } from '@/lib/parsers/ncGeometry'
import { partSectionForCode } from '@/lib/sections/stock'
import { centeredStationFor, type UnrolledLayout, unrolledLayout } from '@/lib/wisecam/layout'
import type { PartChart, PartFeature, PartIr, PartMark, UvPoint } from './ir'

/**
 * DSTV NC → canonical PartIR.
 *
 * The NC is already authored in face coordinates, so the import is a canonicalisation: map each
 * face's `(x along, y across)` to a centred chart station with `centeredStationFor`, drop the face tag,
 * and keep the cut/mark geometry. NC layers are not carried in the IR — they belong to the NCEP
 * exporter.
 *
 * The **front** chart uses WiseCAM's unrolled layout (the NCEP-manufacturable surface). If the NC
 * carries a face the front layout does not develop (notably `h` on open sections), that face gets
 * its own chart. This keeps the IR coordinate-only while still preserving strict NC round-trip data.
 */
export function partIrFromNc(ncText: string): PartIr | null {
  const file = parseDstv(ncText)
  const header = file.header
  const geometry = parseNcGeometry(ncText)
  const section = partSectionForCode(header.profile, header.dimensions)
  if (!section || section.points.length < 3) return null
  const frame = resolveNcFaceFrame(section.points, geometry, header.profile)

  const charts: PartChart[] = []
  const chartByFace = new Map<NcFace, PartChart>()
  const frontLayout = unrolledLayout(header.profileType, header.dimensions)
  if (frontLayout) {
    const faces = (['v', 'o', 'u', 'h'] as NcFace[]).filter((face) => frontLayout.faces[face])
    const chart: PartChart = { id: 'front', role: 'front', faces, layout: frontLayout }
    charts.push(chart)
    for (const face of faces) chartByFace.set(face, chart)
  }

  const usedFaces = new Set<NcFace>()
  for (const contour of geometry.contours) usedFaces.add(contour.face)
  for (const hole of geometry.holes) usedFaces.add(hole.face)
  for (const mark of geometry.marks) usedFaces.add(mark.face)
  for (const notch of geometry.notches) usedFaces.add(notch.face)

  const chartFor = (face: NcFace): PartChart => {
    const existing = chartByFace.get(face)
    if (existing) return existing
    const span = faceSpanAxis(frame, face)
    const width = frame.extent[span]
    const reversed = ncAuthoredAcrossSign(frame, face) < 0
    const layout: UnrolledLayout = {
      seam: width,
      origin: 'centered',
      faces: {
        [face]: { start: -width / 2, length: width, width, radius: 0, reversed },
      },
    }
    const chart: PartChart = {
      id: face === 'h' ? 'rear' : `face:${face}`,
      role: face === 'h' ? 'rear' : 'front',
      faces: [face],
      layout,
    }
    charts.push(chart)
    chartByFace.set(face, chart)
    return chart
  }
  for (const face of usedFaces) chartFor(face)

  const uv = (face: NcFace, x: number, y: number): UvPoint | null => {
    const chart = chartFor(face)
    const station = centeredStationFor(chart.layout, face, y)
    return station == null ? null : [station, x]
  }

  const features: PartFeature[] = []
  for (const contour of geometry.contours) {
    const chart = chartFor(contour.face)
    const points: UvPoint[] = []
    let developed = true
    for (const [x, y] of contour.points) {
      const point = uv(contour.face, x, y)
      if (!point) {
        developed = false
        break
      }
      points.push(point)
    }
    if (!developed || points.length < 2) continue
    features.push({
      kind: 'cut',
      chart: chart.id,
      shape: {
        form: 'polyline',
        points,
        closed: true,
        radii: contour.radii,
      },
      bevels: contour.bevels,
      contour: contour.kind,
      refs: contour.refs,
    })
  }

  for (const [holeIndex, hole] of geometry.holes.entries()) {
    const chart = chartFor(hole.face)
    const center = uv(hole.face, hole.x, hole.y)
    if (!center) continue
    const radius = hole.diameter / 2
    const meta = file.holes[holeIndex]
    if (hole.slot && (hole.slot.dx !== 0 || hole.slot.dy !== 0)) {
      const [dx, dy] = slotOffset(hole.slot)
      const far = uv(hole.face, hole.x + dx, hole.y + dy)
      if (!far) continue
      features.push({
        kind: 'slot',
        chart: chart.id,
        shape: { form: 'slot', center, far, radius },
        holeType: meta?.type ?? 'l',
        extra: meta?.extra,
      })
    } else {
      features.push({
        kind: 'hole',
        chart: chart.id,
        shape: { form: 'circle', center, radius },
        holeType: meta?.type ?? null,
        extra: meta?.extra,
      })
    }
  }

  for (const notch of geometry.notches) {
    const chart = chartFor(notch.face)
    const point = uv(notch.face, notch.x, notch.y)
    if (!point) continue
    features.push({
      kind: 'notch',
      chart: chart.id,
      shape: { form: 'polyline', points: [point], closed: false },
      notch: notch.type,
    })
  }

  const marks: PartMark[] = []
  for (const mark of geometry.marks) {
    const chart = chartFor(mark.face)
    const points: UvPoint[] = []
    let developed = true
    for (const [x, y] of mark.points) {
      const point = uv(mark.face, x, y)
      if (!point) {
        developed = false
        break
      }
      points.push(point)
    }
    if (!developed || points.length === 0) continue
    marks.push({
      kind: mark.kind,
      block: mark.block,
      chart: chart.id,
      shape: { form: 'polyline', points, closed: false },
      text: mark.text
        ? { value: mark.text.value, height: mark.text.height, angle: mark.text.angle }
        : undefined,
    })
  }

  return {
    mark: header.mark,
    profile: header.profile,
    profileType: header.profileType,
    dimensions: header.dimensions,
    section: section.points,
    innerSection: section.innerSection ?? section.holes?.[0],
    length: header.length,
    quantity: header.quantity ?? 1,
    grade: header.grade,
    orderId: header.orderId,
    charts,
    features,
    marks,
  }
}
