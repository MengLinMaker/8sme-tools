import { parseDstv } from '@/lib/parsers/dstv'
import { resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { type NcContour, type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { faceThickness } from '@/lib/parsers/ncProject'
import { partSectionForCode } from '@/lib/sections/stock'
import { rawStationFor, stationFor, type UnrolledLayout, unrolledLayout } from './layout'
import {
  buildNcex,
  type NcexCut,
  type NcexHole,
  type NcexMark,
  type NcexPalette,
  type NcexPart,
  ncexPartSvg,
} from './ncex'

/**
 * Turns a DSTV `.nc1` into the geometry WiseCAM expects in an NCEP part.
 *
 * Supported families are the ones validated against real `.ncep` exports: `I` (UB/WB/UC/WC),
 * `U` (PFC) and `M` (RHS/SHS). `T`, `L` and round sections return `null` until a sample exists.
 *
 * Limitations (see `docs/wisecam-formats.md`):
 * - straight end cuts only (a mitred/bevelled end is not yet developed);
 * - `h`/inner-side cuts are not developed (WiseCAM's NCEP only carries the front surface);
 * - mirrored (`o`/`u`) parts may need `flipFlanges` (handedness is not in the NC header).
 */
export interface FromNcOptions {
  /** Part mark. Pass it explicitly — DSTV marks like `M-1` are not parsed reliably. */
  mark?: string
  /** Draw this stock length on the adobe (defaults to 3000). */
  stockLength?: number
  rotateAngle?: number
  invert?: boolean
  /** Swap the `o`/`u` flange regions (mirrored parts; see the doc). */
  flipFlanges?: boolean
}

const TYPE_CODE: Record<string, number> = { I: 8200, U: 8199, M: 8195 }

/** True when `partFromNc` can develop this profile family. */
export function canDevelop(profileType: string | undefined): boolean {
  return unrolledLayout(profileType, [1, 1, 1, 1, 0]) != null
}

interface ContourEnds {
  start: [number, number][]
  end: [number, number][]
}

/**
 * Splits a face's closed `AK` contour into the start-cut and end-cut arcs. The stock edges are
 * the long segments at constant face coordinate; everything between them is an end cut.
 */
function splitContourEnds(points: [number, number][], length: number): ContourEnds | null {
  const contour = points.slice()
  if (contour.length > 2) {
    const first = contour[0] as [number, number]
    const last = contour[contour.length - 1] as [number, number]
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) contour.pop()
  }
  const count = contour.length
  if (count < 3) return null

  const minLong = Math.max(5, length * 0.25)
  const longEdge = (index: number): boolean => {
    const from = contour[index] as [number, number]
    const to = contour[(index + 1) % count] as [number, number]
    return Math.abs(to[0] - from[0]) >= minLong && Math.abs(to[1] - from[1]) <= 0.5
  }
  let firstLong = -1
  for (let index = 0; index < count; index++) {
    if (longEdge(index)) {
      firstLong = index
      break
    }
  }
  if (firstLong < 0) return null

  const arcs: [number, number][][] = []
  let current: [number, number][] | null = null
  for (let step = 1; step <= count; step++) {
    const index = (firstLong + step) % count
    const from = contour[index] as [number, number]
    const to = contour[(index + 1) % count] as [number, number]
    if (longEdge(index)) {
      if (current) arcs.push(current)
      current = null
      continue
    }
    if (!current) current = [from]
    current.push(to)
  }
  if (current) arcs.push(current)
  if (arcs.length !== 2) return null

  const meanX = (arc: [number, number][]): number =>
    arc.reduce((sum, point) => sum + point[0], 0) / arc.length
  arcs.sort((a, b) => meanX(a) - meanX(b))
  return { start: arcs[0] as [number, number][], end: arcs[1] as [number, number][] }
}

function dedupePoints(points: [number, number][]): [number, number][] {
  const merged: [number, number][] = []
  for (const point of points) {
    const last = merged[merged.length - 1]
    if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) > 0.01) merged.push(point)
  }
  return merged
}

/** Drops vertices that lie on the straight line between their neighbours. */
function simplifyCollinear(points: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const point of points) {
    while (out.length >= 2) {
      const a = out[out.length - 2] as [number, number]
      const b = out[out.length - 1] as [number, number]
      const cross = (b[0] - a[0]) * (point[1] - b[1]) - (b[1] - a[1]) * (point[0] - b[0])
      if (Math.abs(cross) > 1e-6) break
      out.pop()
    }
    out.push(point)
  }
  return out
}

function inRange(points: [number, number][], min: number, max: number): [number, number][] | null {
  if (points.length < 2) return null
  const stations = points.map(([x]) => x)
  if (Math.min(...stations) < min - 0.5 || Math.max(...stations) > max + 0.5) return null
  return points
}

/**
 * Develops one end cut onto the unrolled surface. Returns null when the NC does not give a
 * complete shaped boundary; the writer then falls back to a straight cut.
 */
function developEndCut(
  layout: UnrolledLayout,
  contours: NcContour[],
  length: number,
  end: 'start' | 'end',
): [number, number][] | null {
  // Raw stations are unwrapped so a zero-origin tube's `v` face can straddle the seam.
  const arcs: [number, number][][] = []
  for (const face of ['v', 'o', 'u', 'h'] as NcFace[]) {
    if (!layout.faces[face]) continue
    const contour = contours.find((entry) => entry.kind === 'outer' && entry.face === face)
    if (!contour) return null
    const ends = splitContourEnds(contour.points, length)
    if (!ends) return null
    const arc = end === 'start' ? ends.start : ends.end
    const developed: [number, number][] = []
    for (const [x, y] of arc) {
      const station = rawStationFor(layout, face, y)
      if (station == null) continue
      developed.push([station, x])
    }
    if (developed.length < 2) return null
    developed.sort((a, b) => a[0] - b[0])
    arcs.push(developed)
  }
  if (arcs.length === 0) return null

  if (layout.origin === 'centered') {
    const points = simplifyCollinear(dedupePoints(arcs.flat().sort((a, b) => a[0] - b[0])))
    return inRange(points, -layout.seam / 2, layout.seam / 2)
  }

  // Zero origin: split at the seam (raw station 0), then concatenate 0…max and min…seam.
  const seam = layout.seam
  const right: [number, number][] = []
  const left: [number, number][] = []
  let alongAtSeam: number | null = null
  for (const arc of arcs) {
    for (let index = 0; index < arc.length; index++) {
      const point = arc[index] as [number, number]
      const [raw, along] = point
      if (raw > 1e-9) right.push([raw, along])
      else if (raw < -1e-9) left.push([raw + seam, along])
      else {
        right.push([0, along])
        left.push([seam, along])
        alongAtSeam = along
      }
      const next = arc[index + 1]
      if (!next) continue
      const [nextRaw, nextAlong] = next
      if ((raw < 0 && nextRaw > 0) || (raw > 0 && nextRaw < 0)) {
        const t = -raw / (nextRaw - raw)
        alongAtSeam = along + t * (nextAlong - along)
      }
    }
  }
  if (alongAtSeam == null) return null
  right.push([0, alongAtSeam])
  left.push([seam, alongAtSeam])
  right.sort((a, b) => a[0] - b[0])
  left.sort((a, b) => a[0] - b[0])
  const points = simplifyCollinear(dedupePoints([...dedupePoints(right), ...dedupePoints(left)]))
  return inRange(points, 0, seam)
}

export function partFromNc(ncText: string, options: FromNcOptions = {}): NcexPart | null {
  const file = parseDstv(ncText)
  const header = file.header
  const layout = unrolledLayout(header.profileType, header.dimensions, {
    flipFlanges: options.flipFlanges,
  })
  if (!layout) return null
  const section = partSectionForCode(header.profile, header.dimensions)
  if (!section || section.points.length < 3) return null

  const geometry = parseNcGeometry(ncText)
  const frame = resolveNcFaceFrame(section.points, geometry, header.profile)
  const thicknessByFace = new Map<NcFace, number>()
  const holes: NcexHole[] = []
  for (const hole of geometry.holes) {
    if (!(hole.diameter > 0)) continue
    const station = stationFor(layout, hole.face, hole.y)
    if (station == null) continue
    let thickness = thicknessByFace.get(hole.face)
    if (thickness == null) {
      thickness = faceThickness(frame, section.points, hole.face)
      thicknessByFace.set(hole.face, thickness)
    }
    holes.push({ station, along: hole.x, radius: hole.diameter / 2, face: hole.face, thickness })
  }

  const [, , legThickness, thickness] = header.dimensions
  const marks: NcexMark[] = []
  const seenMarks = new Set<string>()
  for (const mark of geometry.marks) {
    const region = layout.faces[mark.face]
    if (!region) continue
    const points: [number, number][] = []
    let developed = true
    for (const [x, y] of mark.points) {
      const station = stationFor(layout, mark.face, y)
      if (station == null) {
        developed = false
        break
      }
      points.push([station, x])
    }
    if (!developed || points.length === 0) continue
    // DSTV often carries the same mark twice (KO punch + PU scribe); keep one.
    const signature = `${mark.kind}|${mark.text?.value ?? ''}|${points
      .map(([station, along]) => `${station.toFixed(3)},${along.toFixed(3)}`)
      .join(';')}`
    if (seenMarks.has(signature)) continue
    seenMarks.add(signature)
    marks.push({
      kind: mark.kind,
      points,
      text: mark.text ? { ...mark.text, reversed: region.reversed } : undefined,
    })
  }

  const cuts: NcexCut[] = []
  for (const contour of geometry.contours) {
    if (!layout.faces[contour.face]) continue
    const points: [number, number][] = []
    let developed = true
    for (const [x, y] of contour.points) {
      const station = stationFor(layout, contour.face, y)
      if (station == null) {
        developed = false
        break
      }
      points.push([station, x])
    }
    if (!developed || points.length < 2) continue
    cuts.push({ kind: contour.kind, points })
  }

  const profileType = header.profileType.trim().toUpperCase()
  const startCut = developEndCut(layout, geometry.contours, header.length, 'start') ?? undefined
  const endCut = developEndCut(layout, geometry.contours, header.length, 'end') ?? undefined
  return {
    mark: options.mark ?? header.mark,
    profile: header.profile,
    profileType: header.profileType,
    typeCode: TYPE_CODE[profileType] ?? 8195,
    length: header.length,
    quantity: header.quantity ?? 1,
    thickness: thickness ?? 0,
    // WiseCAM writes LegThickness=2 for hollow sections, not the wall thickness.
    legThickness: profileType === 'M' ? 2 : (legThickness ?? 0),
    grade: header.grade,
    section: section.points,
    innerSection: section.innerSection ?? section.holes?.[0],
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
    rCornerMaxRadius:
      header.profileType.trim().toUpperCase() === 'M' ? (header.dimensions[4] ?? 0) : 5,
    rootRadius: header.dimensions[4] ?? 0,
  }
}

/** Develops one `.nc1` straight into an NCEP (`.ncep`) package, or null if unsupported. */
export function buildNcepFromNc(ncText: string, options: FromNcOptions = {}): Uint8Array | null {
  const part = partFromNc(ncText, options)
  return part ? buildNcex([part], { flavour: 'ncep' }) : null
}

/** The developed part + its SVG text, for the in-app unrolled preview. */
export function buildNcepSvgFromNc(
  ncText: string,
  options: FromNcOptions = {},
  palette?: NcexPalette,
): { part: NcexPart; svg: string } | null {
  const part = partFromNc(ncText, options)
  return part ? { part, svg: ncexPartSvg(part, 1000, palette) } : null
}
