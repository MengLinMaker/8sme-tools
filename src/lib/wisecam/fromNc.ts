import { parseDstv } from '@/lib/parsers/dstv'
import { type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { faceThickness } from '@/lib/parsers/ncProject'
import { partSectionForCode } from '@/lib/sections/stock'
import { stationFor, unrolledLayout } from './layout'
import {
  buildNcex,
  type NcexHole,
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
  /** Draw this stock length on the adobe (defaults to the part length). */
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
  return {
    mark: header.mark,
    profile: header.profile,
    profileType: header.profileType,
    typeCode: TYPE_CODE[header.profileType.trim().toUpperCase()] ?? 8195,
    length: header.length,
    quantity: header.quantity ?? 1,
    thickness: thickness ?? 0,
    legThickness: legThickness ?? 0,
    grade: header.grade,
    section: section.points,
    innerSection: section.holes?.[0],
    holes,
    unrolledPerimeter: layout.seam,
    rotateAngle: options.rotateAngle,
    invert: options.invert,
    stockLength: options.stockLength,
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
