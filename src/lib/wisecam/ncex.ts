import { deflateSync, strToU8 } from 'fflate'
import type { NcFace } from '@/lib/parsers/ncGeometry'
import type { UnrolledLayout } from './layout'
import technologyXml from './templates/Technology.xml?raw'

/**
 * EXPERIMENTAL WiseCAM NCEX (`.ncex`) writer.
 *
 * `.ncexa` and `.ncex` are the same OPC/ZIP container (`mimetype`
 * `application/ncex+zip`): `mimetype` → `META-INF/container.xml` → `ncex.opf`
 * manifest → `CAD/` (CadRoot.xml + SVG geometry) and `CNC/` (a small toolpath
 * DSL). The Add-from-File dialog accepts **`.ncex`**; `.ncexa` is the
 * export-to-cutting-software variant and is not importable.
 *
 * The part SVG is an **unrolled tube surface**, not a 3D projection:
 *   x = perimeter station (mm, centred on 0)
 *   y = distance along the member (mm, 0…length)
 * plus the cross-section outline drawn at the origin for reference.
 * Holes are `<circle cx=station cy=along r=diameter/2>`.
 *
 * This writer emits a **CAD-only** package. WiseCAM's importer is strict about the part
 * SVG grammar: holes/truncations must carry `InnerCad` + `wh:technical`, the cut geometry
 * must be a direct child of `cadpart`, and the mark needs its `rotate` transform. The old
 * shape of this writer crashed the importer — keep the emitted documents aligned with the
 * real exports in `test/fixtures/ncep/` (see `docs/ncep-format.md` §6).
 */

const NS_CADCAM = 'http://www.weihong.com.cn/cadcam'
const NS_NCEX = 'http://www.weihong.com.cn/phoenix/ncex'
const MIMETYPE = 'application/ncex+zip'

/** A hole placed on the unrolled surface. */
export interface NcexHole {
  /** Perimeter station (mm, 0 at the unrolled seam; centred by the writer). */
  station: number
  /** Distance along the member (mm). */
  along: number
  /** Hole radius (mm). */
  radius: number
  /** DSTV face the hole was authored on (preview colouring only). */
  face?: NcFace
  /** Wall thickness of that face (mm), for preview colouring. */
  thickness?: number
}

/** A non-cutting layout mark on the unrolled surface (preview only). */
export interface NcexMark {
  /** `etch` = `SI` text, `marking` = `PU`/`KO` scribe lines. */
  kind: 'etch' | 'marking'
  /** Unrolled polyline: `[perimeter station, along the member]` (one point for text). */
  points: [number, number][]
  text?: {
    value: string
    /** Text height in the NC (mm). */
    height: number
    /** Text angle in the NC face plane (deg, CCW). */
    angle: number
    /** Whether the face's station axis runs against the NC Y axis (flips the drawn angle). */
    reversed: boolean
  }
}

/** A developed NC cut contour on the unrolled surface (preview only). */
export interface NcexCut {
  kind: 'outer' | 'inner'
  /** Unrolled polyline: `[perimeter station, along the member]`. */
  points: [number, number][]
}

/** Optional display colours for the unrolled SVG; the exported file never uses these. */
export interface NcexPalette {
  hole?: (hole: NcexHole) => string | undefined
  mark?: string
  outline?: string
}

export interface NcexPart {
  mark: string
  /** Section designation, e.g. `PFC380*100`. */
  profile: string
  /** DSTV profile type letter: `I`, `U`, `M`, `T`, `L`, `RO`. */
  profileType: string
  /** WiseCAM profile enum observed in samples: 8195 tube, 8199 channel, 8200 I. */
  typeCode: number
  length: number
  quantity: number
  /** Web / main wall thickness (mm). */
  thickness: number
  /** Flange / secondary wall thickness (mm). */
  legThickness: number
  grade?: string
  /** Outer cross-section outline in our canonical stance (closed, mm). */
  section: [number, number][]
  /** Inner outline for hollow sections (optional). */
  innerSection?: [number, number][]
  /**
   * Length of the unrolled tube surface (mm). WiseCAM centres it on 0, so the seam
   * runs from `-perimeter/2` to `+perimeter/2`.
   *
   * This is **not** always the outline perimeter: a closed hollow (RHS/SHS) uses the
   * outer outline perimeter, but an open profile (PFC) uses only its outer faces
   * (web + flange backs), e.g. PFC380*100 = 380 + 100 + 100 = 580. Defaults to the
   * outline perimeter when omitted (correct for closed hollows).
   */
  unrolledPerimeter?: number
  /**
   * Developed face regions (preview only). The gaps between them are the zones WiseCAM
   * shades as non-machined faces; they are not written into the package.
   */
  unrolled?: UnrolledLayout
  /** Holes in unrolled coordinates. */
  holes?: NcexHole[]
  /** Layout marks (`SI` etch text / `PU`-`KO` scribe lines) in unrolled coordinates. */
  marks?: NcexMark[]
  /** Developed cut contours (`AK`/`IK`) in unrolled coordinates (preview only). */
  cuts?: NcexCut[]
  /** Rotate the section into the machining stance (WiseCAM `RotateAngle`). */
  rotateAngle?: number
  /** Mirror the section about YOZ (WiseCAM `Invert`). */
  invert?: boolean
  /** Stock beam length to draw on the adobe (default 3000, matching WiseCAM's export). */
  stockLength?: number
  /** `RCornerMaxRadius` in the Adobe params: 5 for I/U, the section radius for tubes. */
  rCornerMaxRadius?: number
}

export interface NcexOptions {
  /** WiseCAM format version written into the OPF metadata. */
  identifier?: string
  /** WiseCAM laser-kernel version written into the OPF metadata. */
  laserZuaVersion?: string
  /**
   * `ncep` (default) = the CAD-only part package WiseCAM exports from *Export part* /
   * *Save As* — this is the importable flavour, with **no `CNC/` payload**.
   * `machining` also emits the `CNC/` scaffold (for `.ncexa`).
   */
  flavour?: 'ncep' | 'machining'
}

const DEFAULT_IDENTIFIER = '2.0.0.0'
const DEFAULT_LASER_ZUA = '6.956.20.0'

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const mm = (value: number): string => value.toFixed(2)

/**
 * Number format for `InnerCad` vertex dumps. WiseCAM's own files carry full precision; 4 dp is
 * plenty for a discretised copy and keeps the SVG small.
 */
const nf = (value: number): string => {
  const text = value.toFixed(4)
  return text.replace(/\.?0+$/, '') || '0'
}

/**
 * `InnerCad` is the discretised copy of the same curve. WiseCAM's own part SVGs carry it on every
 * hole and truncate/end cut; the importer appears to expect it (a part without it crashes the
 * importer), so always emit it.
 */
function innerCad(points: [number, number][], close = false): string {
  if (points.length === 0) return ''
  const [first, ...rest] = points
  const parts = [`M${nf(first[0])},${nf(first[1])}`]
  for (const [x, y] of rest) parts.push(`N${nf(x)},${nf(y)},0`)
  if (close) parts.push(`N${nf(first[0])},${nf(first[1])},0`)
  return parts.join('')
}

/** A full-circle `InnerCad` dump, sampled like WiseCAM (denser for larger holes). */
function circleInnerCad(cx: number, cy: number, radius: number): string {
  const segments = radius >= 10 ? 256 : 128
  const points: [number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const angle = -Math.PI / 2 - (i / segments) * Math.PI * 2
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
  }
  return innerCad(points)
}

function pathFromPoints(points: [number, number][], close = true): string {
  if (points.length === 0) return ''
  const [first, ...rest] = points
  const parts = [`M${mm(first[0])},${mm(first[1])}`]
  for (const [x, y] of rest) parts.push(`L${mm(x)},${mm(y)}`)
  if (close) parts.push('Z')
  return parts.join(' ')
}

function svgHeader(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg version="1.1" xmlns:wh="${NS_CADCAM}" xmlns="http://www.w3.org/2000/svg">`,
    ' <style type="text/css">',
    '\t\t.layer0 {stroke:rgb(0,0,0);fill:none;stroke-width:0.5;}',
    '\t\t.layer1 {stroke:rgb(125,45,75);fill:none;stroke-width:0.5;}',
    '\t\t.layer2 {stroke:rgb(250,90,150);fill:none;stroke-width:0.5;}',
    '\t\t.layer3 {stroke:rgb(120,135,225);fill:none;stroke-width:0.5;}',
    '\t\t.layer4 {stroke:rgb(245,180,45);fill:none;stroke-width:0.5;}',
    '\t\t.layer5 {stroke:rgb(115,225,120);fill:none;stroke-width:0.5;}',
    '\t\t.layer6 {stroke:rgb(240,15,195);fill:none;stroke-width:0.5;}',
    '\t\t.layer7 {stroke:rgb(110,60,15);fill:none;stroke-width:0.5;}',
    '</style>',
  ].join('\n')
}

const paint = (stroke?: string): string => (stroke ? ` stroke="${stroke}"` : '')

/** WiseCAM's default lead/technical template for a drilled hole. */
const TECHNICAL_CIRCLE =
  'T={LeadLine={Pos={Segment=0,Ratio=0.25,},LeadInBreak=0,Radius = 0,Seal=0,LeadIn={Type=0,Length=3,Angle=0.5235987755982988,Radius=3,AbsoluteAngle=1,},LeadOut={Type=0,Length=3,Angle=0.5235987755982988,Radius=0.1,},},};InnerT={};'
const TECHNICAL_TRUNCATE = 'T={};InnerT={};'
const TECHNICAL_EMPTY = 'T={};'

function truncatePath(
  id: number,
  points: [number, number][],
  type: 0 | 1,
  mark?: string,
  stroke?: string,
): string {
  const part = type === 1 && mark ? `Part=${xml(mark)};` : ''
  const params = `IsTrucate=1;TrucateType=${type};${part}InnerCad=${innerCad(points)};`
  return `<path wh:id="${id}" wh:class="cadpolyline" wh:layer="0" wh:isfill="1" wh:machining="1" d="${pathFromPoints(points, false)}" wh:params="${params}" wh:technical="${TECHNICAL_TRUNCATE}" class="layer0"${paint(stroke)}/>`
}

function profilePath(id: number, points: [number, number][], stroke?: string): string {
  return `<path wh:id="${id}" wh:class="cadpolyline" wh:layer="0" wh:isfill="0" wh:machining="1" d="${pathFromPoints(points)}" wh:params="ANGLE_DISTINGUISH_LW=1;ANGLE_DISTINGUISH_MODE=0;" wh:technical="${TECHNICAL_EMPTY}" class="layer0"${paint(stroke)}/>`
}

function innerProfilePath(
  id: number,
  points: [number, number][],
  stroke?: string,
  close = true,
): string {
  return `<path wh:id="${id}" wh:class="cadpolyline" wh:layer="0" wh:isfill="0" wh:machining="1" d="${pathFromPoints(points, close)}" wh:technical="${TECHNICAL_EMPTY}" class="layer0"${paint(stroke)}/>`
}

function holeCircle(id: number, hole: NcexHole, stroke?: string): string {
  const params = `InnerCad=${circleInnerCad(hole.station, hole.along, hole.radius)};`
  return `<circle wh:id="${id}" wh:class="cadcircle" wh:layer="0" wh:isfill="0" wh:machining="1" cx="${mm(hole.station)}" cy="${mm(hole.along)}" r="${mm(hole.radius)}" wh:direction="1" wh:params="${params}" wh:technical="${TECHNICAL_CIRCLE}" class="layer0"${paint(stroke)}/>`
}

function markText(id: number, part: NcexPart, stroke?: string): string {
  const x = 0
  const y = part.length / 2
  return `<text wh:id="${id}" wh:class="cadtext" wh:layer="6" wh:isfill="0" wh:machining="1" x="${mm(x)}" y="${mm(y)}" font-family="Arial" font-size="40" font-size-adjust="1" letter-spacing="0" word-spacing="0" font-weight="normal" font-style="normal" wh:font-shxfont="txt.shx" wh:font-bigfont="gbcbig.shx" wh:font-isvertrical="0" wh:font-isshape="0" wh:font-obliqueangle="0" wh:font-charset="134" wh:font-pitchandfamily="32" wh:params="IsLabel=true;LabelType=0;LabelContent=${xml(part.mark)};LabelWidth=1.000000;LabelHeight=40.000000;LabelRotate=90.0;LabelSource=1;" wh:technical="${TECHNICAL_EMPTY}" class="layer6"${paint(stroke)} transform="rotate(90 ${mm(x)},${mm(y)})">${xml(part.mark)}</text>`
}

/** The unrolled seam half-width: stations are centred on 0 like WiseCAM's own SVGs. */
function seamHalf(part: NcexPart): number {
  if (part.unrolledPerimeter != null && part.unrolledPerimeter > 0) {
    return part.unrolledPerimeter / 2
  }
  let perimeter = 0
  for (let i = 0; i < part.section.length; i++) {
    const a = part.section[i] as [number, number]
    const b = part.section[(i + 1) % part.section.length] as [number, number]
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return perimeter / 2
}

/** A PFC's inner cavity is open at the flange toes; a hollow's void is closed. */
function innerSectionClosed(part: NcexPart): boolean {
  return part.profileType.trim().toUpperCase() !== 'U'
}

/** The unrolled seam span: centred on 0 for `I`/`U`, but `M` tubes start at 0. */
function seamBounds(part: NcexPart): [number, number] {
  const half = seamHalf(part)
  return part.profileType.trim().toUpperCase() === 'M' ? [0, half * 2] : [-half, half]
}

function partSvg(part: NcexPart, refId: number, palette?: NcexPalette): string {
  const [left, right] = seamBounds(part)
  const start: [number, number][] = [
    [left, 0],
    [right, 0],
  ]
  const end: [number, number][] = [
    [right, part.length],
    [left, part.length],
  ]
  let seq = refId * 10
  const next = (): number => ++seq
  // WiseCAM's own part SVGs keep the cut geometry (truncations, holes, mark) as direct children
  // of `cadpart` and put the section outlines in a trailing `cadgroup`.
  const body: string[] = []
  body.push(truncatePath(next(), start, 0, undefined, palette?.outline))
  for (const hole of part.holes ?? []) {
    body.push(holeCircle(next(), hole, palette?.hole?.(hole)))
  }
  body.push(markText(next(), part, palette?.mark))
  body.push(truncatePath(next(), end, 1, part.mark, palette?.outline))
  const section: string[] = [profilePath(next(), part.section, palette?.outline)]
  if (part.innerSection)
    section.push(
      innerProfilePath(next(), part.innerSection, palette?.outline, innerSectionClosed(part)),
    )
  return [
    svgHeader(),
    ` <g wh:id="${refId}" wh:class="cadpart" wh:layer="-1" wh:isfill="0" wh:machining="1" wh:refid="${refId}" wh:matrixinfo3d="1,0,0,0 0,1,0,0 0,0,1,0" class="layer-1">`,
    ...body.map((line) => `  ${line}`),
    ' </g>',
    // The section is a SIBLING of cadpart in WiseCAM's own exports, not a child.
    ` <g wh:id="${refId + 1}" wh:class="cadgroup" wh:layer="0" wh:isfill="0" wh:machining="1" class="layer0">`,
    ...section.map((line) => `  ${line}`),
    ' </g>',
    '</svg>',
    '',
  ].join('\n')
}

/** The part SVG text embedded in an NCEP package, exposed for the in-app unrolled preview. */
export function ncexPartSvg(part: NcexPart, refId = 1000, palette?: NcexPalette): string {
  return partSvg(part, refId, palette)
}

function adobeSvg(part: NcexPart, stockLength: number, refId: number): string {
  const [left, right] = seamBounds(part)
  let seq = refId * 10
  const next = (): number => ++seq
  const cutGroup: string[] = []
  cutGroup.push(
    truncatePath(
      next(),
      [
        [left, 0],
        [right, 0],
      ],
      0,
    ),
  )
  cutGroup.push(
    truncatePath(
      next(),
      [
        [right, stockLength],
        [left, stockLength],
      ],
      1,
      part.mark,
    ),
  )
  const section: string[] = [profilePath(next(), part.section)]
  if (part.innerSection)
    section.push(innerProfilePath(next(), part.innerSection, undefined, innerSectionClosed(part)))
  return [
    svgHeader(),
    ` <g wh:id="${refId}" wh:class="cadgroup" wh:layer="0" wh:isfill="0" wh:machining="1" class="layer0">`,
    ...cutGroup.map((line) => `  ${line}`),
    ' </g>',
    ` <g wh:id="${refId + 1}" wh:class="cadgroup" wh:layer="0" wh:isfill="0" wh:machining="1" class="layer0">`,
    ...section.map((line) => `  ${line}`),
    ' </g>',
    '</svg>',
    '',
  ].join('\n')
}

/**
 * Fresh GUID for `technologyID`. WiseCAM uses this as a package identity/cache key: reusing a
 * GUID for changed content makes the importer reject the file even when the bytes are valid
 * (30b vs 31/32). Always emit a new GUID per part/adobe.
 */
function techId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid.toUpperCase()
  const hex = (): string =>
    Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, '0')
  return `${hex()}-${hex().slice(0, 4)}-${hex().slice(0, 4)}-${hex().slice(0, 4)}-${hex()}${hex().slice(0, 4)}`.toUpperCase()
}

function cadRoot(parts: NcexPart[], partIds: number[], adobeIds: number[]): string {
  const adobeEntries = parts.map((part, index) => {
    const id = adobeIds[index] as number
    const params = [
      `Type=${part.typeCode}`,
      `Name=${xml(part.mark)}`,
      `Thickness=${mm(part.thickness)}`,
      `LegThickness=${mm(part.legThickness)}`,
      'OuterLeadLength=2',
      'OuterLeadOutLength=2',
      'OuterLeadDir=0',
      // WiseCAM's own NCEP exports use the 3000 mm base-stock template length.
      `Length=${mm(part.stockLength ?? 3000)}`,
      `RCornerMaxRadius=${mm(part.rCornerMaxRadius ?? 5)}`,
      'Area=0',
      `TotalCount=${part.quantity}`,
      'NestedCount=0',
    ].join(';')
    return `  <Adobe idref="${id}" svgname="adobe${id}.svg" params="${params};" technologyID="${techId()}"/>`
  })
  const partEntries = parts.map((part, index) => {
    const id = partIds[index] as number
    const params = [
      `Type=${part.typeCode}`,
      `Name=${xml(part.mark)}`,
      `TotalCount=${part.quantity}`,
      'NestedCount=0',
      `Thickness=${mm(part.thickness)}`,
      `LegThickness=${mm(part.legThickness)}`,
      'Area=0',
      'RotateStyle=0',
      'Priority=5',
      `RotateAngle=${part.rotateAngle ?? 0}`,
      `Invert=${part.invert ? 1 : 0}`,
    ].join(';')
    return `  <Part idref="${id}" svgname="part${id}.svg" params="${params};"/>`
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<cadroot version="1.0" xmlns="${NS_CADCAM}">`,
    ' <Adobes>',
    ...adobeEntries,
    ' </Adobes>',
    ' <Parts>',
    ...partEntries,
    ' </Parts>',
    ` <BaseZone idref="52" count="0" adobeid="${adobeIds[0] ?? 94}"/>`,
    '</cadroot>',
    '',
  ].join('\n')
}

function metadataBlock(options: NcexOptions): string {
  return [
    `<metadata xmlns="${NS_NCEX}" version="1.0">`,
    `<identifier>${options.identifier ?? DEFAULT_IDENTIFIER}</identifier>`,
    '<title>laser_tube</title>',
    '<LCSteelFullPath>0</LCSteelFullPath>',
    `<cnc_laserzua>${options.laserZuaVersion ?? DEFAULT_LASER_ZUA}</cnc_laserzua>`,
    '<cnc_layerparam>1.0.0.0</cnc_layerparam>',
    '<machinetype>straight</machinetype>',
    '<modifier>professional</modifier>',
    '<remarker>professional</remarker>',
    '<source>professional</source>',
    '</metadata>',
  ].join('\n')
}

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="${NS_NCEX}">
  <rootfiles>
    <rootfile full-path="CAD/cad.opf" media-type="application/ncex-package+xml"/>
    <rootfile full-path="CNC/cnc.opf" media-type="application/ncex-package+xml"/>
    <rootfile full-path="ncex.opf" media-type="application/ncex-package+xml"/>
  </rootfiles>
</container>
`

const CNC_BASE_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<root>
\t<global>
\t\t<item href="CNC/GlobalParam.zua"/>
\t</global>
\t<cnc>
\t</cnc>
\t<additionalInfo>
\t\t<TubeInfo Param="Type=1;Length=3000.000;Thickness=1.500;RectWidth=50.000;RectHeight=50.000;RectRadius=2.000;Area=287.781;"/>
\t\t<HasBevel>0</HasBevel>
\t\t<IsCutPoint>0</IsCutPoint>
\t\t<HasCounterbore>0</HasCounterbore>
\t\t<HasInkjet>0</HasInkjet>
\t</additionalInfo>
</root>
`

const CNC_GLOBAL_ZUA = 'GP = {\n[0] = {\n\t\tName = [[大图形]],\n},\n};\n'
const CNC_CNC_PARAM = `GlobalParam={Cad={OpfExtendMetaData=[[machinetype=straight;
]],SupportBevel=false,CutterHeadType=1,nMajorAxis=1,nMinorAxis=0,MajorRotateVec={0.000000,1.000000,0.000000},MinorRotateVec={1.000000,0.000000,0.000000},CheckLimit={1,1,0},MaxRotateLimit={90.000000,360.000000,0.000000},MinRotateLimit={-90.000000,-360.000000,0.000000},},GCodeParam={},Cnc={},}
`
const CNC_CUSTOM_PARAM = 'Customize = {\n};\n'

/** `CAD/CustomizeData.xml` as WiseCAM writes it — one empty stub per zone layer. */
const CUSTOMIZE_DATA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="${NS_CADCAM}">
 <ZoneBlock idref="52">
${Array.from({ length: 8 }, (_, id) => `  <customize id="${id}" params=""/>`).join('\n')}
 </ZoneBlock>
</root>
`

/**
 * Builds an NCEX package from one or more parts.
 *
 * Default flavour is **`ncep`** — the CAD-only part package WiseCAM produces from
 * *Export part* / *Save As*, which is the one its Add-from-File importer accepts. It has
 * **no `CNC/` payload** (the container still lists the CNC rootfile, exactly as WiseCAM's
 * own `.ncep` does). `machining` adds the `CNC/` scaffold for `.ncexa`.
 */
export function buildNcex(parts: NcexPart[], options: NcexOptions = {}): Uint8Array {
  if (parts.length === 0) throw new Error('buildNcex: no parts')
  const flavour = options.flavour ?? 'ncep'
  const partIds = parts.map((_, index) => 1000 + index)
  const adobeIds = parts.map((_, index) => 500 + index)
  const files: Record<string, Uint8Array> = {}

  files.mimetype = strToU8(MIMETYPE)
  files['META-INF/container.xml'] = strToU8(CONTAINER_XML)
  files['CAD/CadRoot.xml'] = strToU8(cadRoot(parts, partIds, adobeIds))
  files['CAD/cad.opf'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" ?>\n<package>\n${metadataBlock(options)}\n<cad>\n\t<item href="CAD/CadRoot.xml"/>\n</cad>\n</package>\n`,
  )
  files['CAD/Technology.xml'] = strToU8(technologyXml)
  files['CAD/CustomizeData.xml'] = strToU8(CUSTOMIZE_DATA_XML)
  parts.forEach((part, index) => {
    const partId = partIds[index] as number
    const adobeId = adobeIds[index] as number
    files[`CAD/part${partId}.svg`] = strToU8(partSvg(part, partId))
    files[`CAD/adobe${adobeId}.svg`] = strToU8(
      adobeSvg(part, part.stockLength ?? part.length, adobeId),
    )
  })

  if (flavour === 'machining') {
    files['CNC/cnc.opf'] = strToU8(
      '<?xml version = "1.0" encoding="UTF-8" ?>\n<cnc>\n\t<item href="CNC/Base.xml"/>\n</cnc>\n',
    )
    files['CNC/Base.xml'] = strToU8(CNC_BASE_XML)
    files['CNC/GlobalParam.zua'] = strToU8(CNC_GLOBAL_ZUA)
    files['CNC/CncParam.zua'] = strToU8(CNC_CNC_PARAM)
    files['CNC/CustomParam.zua'] = strToU8(CNC_CUSTOM_PARAM)
  }

  // WiseCAM's own `.ncep` lists the CAD payload in this order (no CNC items).
  const cadManifest = [
    'CAD/CadRoot.xml',
    'CAD/cad.opf',
    'CAD/Technology.xml',
    'CAD/CustomizeData.xml',
    ...parts.flatMap((_, index) => [
      `CAD/adobe${adobeIds[index]}.svg`,
      `CAD/part${partIds[index]}.svg`,
    ]),
  ]
  const cncManifest =
    flavour === 'machining'
      ? [
          'CNC/cnc.opf',
          'CNC/Base.xml',
          'CNC/GlobalParam.zua',
          'CNC/CncParam.zua',
          'CNC/CustomParam.zua',
        ]
      : []
  const manifest = [...cadManifest, ...cncManifest]
    .map((path) => `        <item href="${path}" />`)
    .join('\n')
  files['ncex.opf'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" ?>\n<package>\n${metadataBlock(options)}\n    <manifest>\n${manifest}\n    </manifest>\n</package>\n`,
  )

  // Entry order and per-entry ZIP metadata must match WiseCAM's own (Qt) ZIP writer:
  // `mimetype` and `META-INF/container.xml` stored; CAD/CNC entries deflated with GP flag
  // 0x0006 and internal_attr=1; `ncex.opf` deflated with flags 0. fflate's `zipSync`
  // deflates the container and drops these flags, which WiseCAM rejects.
  const order = ['mimetype', 'META-INF/container.xml', ...cadManifest, ...cncManifest, 'ncex.opf']
  return zipQt(files, order)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = []
  private length = 0

  get offset(): number {
    return this.length
  }

  push(bytes: Uint8Array | number[]): void {
    const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    this.chunks.push(chunk)
    this.length += chunk.length
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const dateBits = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: dateBits }
}

export interface ZipQtOptions {
  /** Deflate level for CAD/CNC/ncex.opf entries (default 6; level 9 is suspect, see probe log). */
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  /** Store every entry instead of deflating CAD/CNC (probe/debug only). */
  storeAll?: boolean
  /** Override the DOS timestamp (probe/debug only). */
  timestamp?: Date
  /** `none` writes flags 0 on CAD/CNC instead of Qt's `0x0006` (probe/debug only). */
  flags?: 'qt' | 'none'
  /** Override version-made-by (probe/debug only). */
  versionMadeBy?: number
}

/**
 * Writes a ZIP in WiseCAM's dialect (Qt `QZipWriter`): version-made-by 0, stored
 * `mimetype`/`META-INF/container.xml`, deflated CAD/CNC with GP flag `0x0006` +
 * internal_attr 1, and `ncex.opf` deflated with flags 0.
 */
export function zipQt(
  files: Record<string, Uint8Array>,
  order: string[],
  options: ZipQtOptions = {},
): Uint8Array {
  const { time, date } = dosDateTime(options.timestamp)
  const local = new ByteWriter()
  const central = new ByteWriter()
  const offsets = new Map<string, number>()

  for (const path of order) {
    const data = files[path]
    if (!data) throw new Error(`zipQt: missing ${path}`)
    const name = strToU8(path)
    const stored = options.storeAll || path === 'mimetype' || path === 'META-INF/container.xml'
    const method = stored ? 0 : 8
    const flags = stored || path === 'ncex.opf' || options.flags === 'none' ? 0 : 0x0006
    const internalAttr = stored ? 0 : 1
    const body = stored ? data : deflateSync(data, { level: options.level ?? 6 })
    const crc = crc32(data)
    const offset = local.offset
    offsets.set(path, offset)

    local.push(u32(0x04034b50))
    local.push(u16(20))
    local.push(u16(flags))
    local.push(u16(method))
    local.push(u16(time))
    local.push(u16(date))
    local.push(u32(crc))
    local.push(u32(body.length))
    local.push(u32(data.length))
    local.push(u16(name.length))
    local.push(u16(0))
    local.push(name)
    local.push(body)

    central.push(u32(0x02014b50))
    central.push(u16(options.versionMadeBy ?? 0))
    central.push(u16(20))
    central.push(u16(flags))
    central.push(u16(method))
    central.push(u16(time))
    central.push(u16(date))
    central.push(u32(crc))
    central.push(u32(body.length))
    central.push(u32(data.length))
    central.push(u16(name.length))
    central.push(u16(0))
    central.push(u16(0))
    central.push(u16(0))
    central.push(u16(internalAttr))
    central.push(u32(0))
    central.push(u32(offset))
    central.push(name)
  }

  const centralOffset = local.offset
  const centralSize = central.offset
  local.push(central.finish())
  local.push(u32(0x06054b50))
  local.push(u16(0))
  local.push(u16(0))
  local.push(u16(order.length))
  local.push(u16(order.length))
  local.push(u32(centralSize))
  local.push(u32(centralOffset))
  local.push(u16(0))
  return local.finish()
}
