import { parseDstv } from '@/lib/parsers/dstv'
import { resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { type NcFace, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { faceThickness } from '@/lib/parsers/ncProject'
import { outlinePoints } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import { unrolledLayout } from './layout'
import { buildNcex, type NcexPalette, type NcexPart, ncexPartSvg } from './ncex'
import { developNcGeometry } from './surface'

/**
 * Turns a DSTV `.nc1` into the geometry WiseCAM expects in an NCEP part.
 *
 * The NC is first kept in its native **face coordinates** — `(along the member, across the face)`
 * for each DSTV face, exactly on the stock surface — then developed to the unrolled NCEP net by
 * the shared surface layer (`surface.ts`). A future STEP→NCEP path uses the same layer, so both
 * sources converge on one surface representation and are directly comparable/debuggable.
 *
 * Supported families are the ones validated against real `.ncep` exports: `I` (UB/WB/UC/WC),
 * `U` (PFC) and `M` (RHS/SHS). `T`, `L` and round sections return `null` until a sample exists.
 *
 * Limitations (see `docs/wisecam-formats.md`):
 * - tube mitres are developed through the corner cylinder; I/U root-fillet arcs and bevel
 *   `PosMap` clusters are not yet emitted;
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

export function partFromNc(ncText: string, options: FromNcOptions = {}): NcexPart | null {
  const file = parseDstv(ncText)
  const header = file.header
  const layout = unrolledLayout(header.profileType, header.dimensions, {
    flipFlanges: options.flipFlanges,
  })
  if (!layout) return null
  const section = partSectionForCode(header.profile, header.dimensions)
  const sectionPoints = outlinePoints(section?.outline)
  if (!section || sectionPoints.length < 3) return null

  const geometry = parseNcGeometry(ncText)
  const frame = resolveNcFaceFrame(sectionPoints, geometry, header.profile)
  const thicknessByFace = new Map<NcFace, number>()
  const thicknessForFace = (face: NcFace): number => {
    let thickness = thicknessByFace.get(face)
    if (thickness == null) {
      thickness = faceThickness(frame, sectionPoints, face)
      thicknessByFace.set(face, thickness)
    }
    return thickness
  }

  const [, , legThickness, thickness] = header.dimensions
  const developed = developNcGeometry(geometry, layout, {
    length: header.length,
    wall: header.dimensions[2] ?? 0,
    thicknessForFace,
  })

  const profileType = header.profileType.trim().toUpperCase()
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
    section: sectionPoints,
    innerSection: section.innerOutline
      ? outlinePoints(section.innerOutline)
      : section.voidOutlines?.[0]
        ? outlinePoints(section.voidOutlines[0])
        : undefined,
    holes: developed.holes,
    marks: developed.marks,
    cuts: developed.cuts,
    startCut: developed.startCut,
    endCut: developed.endCut,
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
