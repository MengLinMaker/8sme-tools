import { strToU8, zipSync } from 'fflate'

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
 * This writer emits a **CAD-only** package. It has NOT been round-tripped
 * through WiseCAM yet — validate with an Add-from-File import before use.
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
  /** Holes in unrolled coordinates. */
  holes?: NcexHole[]
  /** Rotate the section into the machining stance (WiseCAM `RotateAngle`). */
  rotateAngle?: number
  /** Mirror the section about YOZ (WiseCAM `Invert`). */
  invert?: boolean
  /** Stock beam length to draw on the adobe (default = part length). */
  stockLength?: number
}

export interface NcexOptions {
  /** WiseCAM format version written into the OPF metadata. */
  identifier?: string
  /** WiseCAM laser-kernel version written into the OPF metadata. */
  laserZuaVersion?: string
}

const DEFAULT_IDENTIFIER = '2.0.0.0'
const DEFAULT_LASER_ZUA = '6.956.20.0'

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const mm = (value: number): string => value.toFixed(2)

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
    '\t\t.layer6 {stroke:rgb(240,15,195);fill:none;stroke-width:0.5;}',
    '</style>',
  ].join('\n')
}

function truncatePath(id: number, points: [number, number][], type: 0 | 1): string {
  return `<path wh:id="${id}" wh:class="cadpolyline" wh:layer="0" wh:isfill="1" wh:machining="1" d="${pathFromPoints(points, false)}" wh:params="IsTrucate=1;TrucateType=${type};" class="layer0"/>`
}

function profilePath(id: number, points: [number, number][]): string {
  return `<path wh:id="${id}" wh:class="cadpolyline" wh:layer="0" wh:isfill="0" wh:machining="1" d="${pathFromPoints(points)}" class="layer0"/>`
}

function holeCircle(id: number, hole: NcexHole): string {
  return `<circle wh:id="${id}" wh:class="cadcircle" wh:layer="0" wh:isfill="0" wh:machining="1" cx="${mm(hole.station)}" cy="${mm(hole.along)}" r="${mm(hole.radius)}" wh:direction="1" class="layer0"/>`
}

function markText(id: number, part: NcexPart): string {
  return `<text wh:id="${id}" wh:class="cadtext" wh:layer="6" wh:isfill="0" wh:machining="1" x="${mm(0)}" y="${mm(part.length / 2)}" font-size="8" class="layer6" wh:params="IsLabel=true;LabelType=0;LabelContent=${xml(part.mark)};LabelWidth=1;LabelHeight=8;LabelRotate=0;LabelSource=1">${xml(part.mark)}</text>`
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

function partSvg(part: NcexPart, refId: number): string {
  const half = seamHalf(part)
  const start: [number, number][] = [
    [-half, 0],
    [half, 0],
  ]
  const end: [number, number][] = [
    [half, part.length],
    [-half, part.length],
  ]
  let seq = refId * 10
  const next = (): number => ++seq
  const body: string[] = []
  body.push(truncatePath(next(), start, 0))
  body.push(truncatePath(next(), end, 1))
  body.push(profilePath(next(), part.section))
  if (part.innerSection) body.push(profilePath(next(), part.innerSection))
  for (const hole of part.holes ?? []) body.push(holeCircle(next(), hole))
  body.push(markText(next(), part))
  return [
    svgHeader(),
    ` <g wh:id="${refId}" wh:class="cadpart" wh:layer="-1" wh:isfill="0" wh:machining="1" wh:refid="${refId}" class="layer-1">`,
    ...body.map((line) => `  ${line}`),
    ' </g>',
    '</svg>',
    '',
  ].join('\n')
}

function adobeSvg(part: NcexPart, stockLength: number, refId: number): string {
  const half = seamHalf(part)
  let seq = refId * 10
  const next = (): number => ++seq
  const body: string[] = []
  body.push(
    truncatePath(
      next(),
      [
        [-half, 0],
        [half, 0],
      ],
      0,
    ),
  )
  body.push(
    truncatePath(
      next(),
      [
        [half, stockLength],
        [-half, stockLength],
      ],
      1,
    ),
  )
  body.push(profilePath(next(), part.section))
  if (part.innerSection) body.push(profilePath(next(), part.innerSection))
  return [
    svgHeader(),
    ` <g wh:id="${refId}" wh:class="cadadobe" wh:layer="-1" wh:isfill="0" wh:machining="1" class="layer-1">`,
    ...body.map((line) => `  ${line}`),
    ' </g>',
    '</svg>',
    '',
  ].join('\n')
}

/** Stable-ish GUID text for `technologyID`; WiseCAM does not appear to validate it. */
function techId(seed: number): string {
  const hex = (n: number, width: number): string => (n >>> 0).toString(16).padStart(width, '0')
  const a = hex(seed * 2654435761, 8)
  const b = hex(seed * 40503 + 1, 4)
  const c = hex(seed * 7919 + 2, 4)
  const d = hex(seed * 104729 + 3, 4)
  const e = hex(seed * 15485863 + 4, 12)
  return `${a}-${b}-${c}-${d}-${e}`.toUpperCase()
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
      `Length=${mm(part.stockLength ?? part.length)}`,
      'RCornerMaxRadius=999',
      'Area=0',
      `TotalCount=${part.quantity}`,
      'NestedCount=0',
    ].join(';')
    return `  <Adobe idref="${id}" svgname="adobe${id}.svg" params="${params};" technologyID="${techId(id)}"/>`
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

/**
 * Builds an NCEX (`.ncex`) package from one or more parts.
 *
 * The archive is a valid OPC/ZIP with `mimetype` first and uncompressed; WiseCAM
 * regenerates the toolpath on import, so no `CNC/Plate*.zua` is emitted.
 */
export function buildNcex(parts: NcexPart[], options: NcexOptions = {}): Uint8Array {
  if (parts.length === 0) throw new Error('buildNcex: no parts')
  const partIds = parts.map((_, index) => 1000 + index)
  const adobeIds = parts.map((_, index) => 500 + index)
  const files: Record<string, Uint8Array> = {}

  files.mimetype = strToU8(MIMETYPE)
  files['META-INF/container.xml'] = strToU8(CONTAINER_XML)
  files['CAD/CadRoot.xml'] = strToU8(cadRoot(parts, partIds, adobeIds))
  parts.forEach((part, index) => {
    const partId = partIds[index] as number
    const adobeId = adobeIds[index] as number
    files[`CAD/part${partId}.svg`] = strToU8(partSvg(part, partId))
    files[`CAD/adobe${adobeId}.svg`] = strToU8(
      adobeSvg(part, part.stockLength ?? part.length, adobeId),
    )
  })
  files['CAD/cad.opf'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" ?>\n<package>\n${metadataBlock(options)}\n<cad>\n\t<item href="CAD/CadRoot.xml"/>\n</cad>\n</package>\n`,
  )
  files['CNC/cnc.opf'] = strToU8(
    '<?xml version = "1.0" encoding="UTF-8" ?>\n<cnc>\n\t<item href="CNC/Base.xml"/>\n</cnc>\n',
  )
  files['CNC/Base.xml'] = strToU8(CNC_BASE_XML)
  files['CNC/GlobalParam.zua'] = strToU8(CNC_GLOBAL_ZUA)
  files['CNC/CncParam.zua'] = strToU8(CNC_CNC_PARAM)
  files['CNC/CustomParam.zua'] = strToU8(CNC_CUSTOM_PARAM)

  const manifest = Object.keys(files)
    .filter((path) => path !== 'mimetype' && path !== 'ncex.opf')
    .map((path) => `        <item href="${path}" />`)
    .join('\n')
  files['ncex.opf'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" ?>\n<package>\n${metadataBlock(options)}\n    <manifest>\n${manifest}\n    </manifest>\n</package>\n`,
  )

  // mimetype must be the first entry and stored (no compression) — OPC readers reject otherwise.
  const ordered: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    mimetype: [files.mimetype as Uint8Array, { level: 0 }],
  }
  for (const [path, data] of Object.entries(files)) {
    if (path === 'mimetype') continue
    ordered[path] = [data, { level: 6 }]
  }
  return zipSync(ordered)
}
