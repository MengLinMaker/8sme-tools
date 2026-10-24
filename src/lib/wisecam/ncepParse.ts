import { XMLParser } from 'fast-xml-parser'
import { strFromU8, unzipSync } from 'fflate'
import { z } from 'zod'
import {
  parseRotateTransform,
  parseSvgPath,
  type RotateTransform,
  rotatePoints,
  type SvgPoint,
  type SvgSubpath,
} from './svgPath'

/**
 * Read-only parser for WiseCAM `.ncep` part packages.
 *
 * The parser models the **structure** WiseCAM expects (one `cadpart`, two `IsTrucate` paths,
 * a sibling section group, layer-6 marks) and the **unrolled geometry** (`x` = perimeter
 * station, `y` = along the member). It never rewrites the package. See
 * `docs/ncep-format.md` §3 for the format and §9 for the parser rules.
 */

export const ncepPointSchema = z.tuple([z.number().finite(), z.number().finite()])
export type NcepPoint = z.infer<typeof ncepPointSchema>

export const ncepSubpathSchema = z.object({
  points: z.array(ncepPointSchema).min(2),
  closed: z.boolean(),
})
export type NcepSubpath = z.infer<typeof ncepSubpathSchema>

export const ncepIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  path: z.string().optional(),
})
export type NcepIssue = z.infer<typeof ncepIssueSchema>

export const ncepTruncateSchema = z.object({
  kind: z.literal('truncate'),
  id: z.string().optional(),
  truncateType: z.union([z.literal(0), z.literal(1)]),
  part: z.string().optional(),
  paths: z.array(ncepSubpathSchema).min(1),
  params: z.record(z.string(), z.string()),
  innerCad: z.array(ncepPointSchema).optional(),
})
export type NcepTruncate = z.infer<typeof ncepTruncateSchema>

export const ncepHoleSchema = z.object({
  kind: z.literal('hole'),
  id: z.string().optional(),
  cx: z.number().finite(),
  cy: z.number().finite(),
  r: z.number().finite().positive(),
  direction: z.number().int().optional(),
  layer: z.number().int(),
  machining: z.boolean(),
  params: z.record(z.string(), z.string()),
  innerCad: z.array(ncepPointSchema).optional(),
})
export type NcepHole = z.infer<typeof ncepHoleSchema>

export const ncepMarkSchema = z.object({
  kind: z.literal('mark'),
  id: z.string().optional(),
  tag: z.enum(['text', 'rect', 'line', 'path', 'circle', 'other']),
  label: z.string().optional(),
  text: z.string().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  height: z.number().finite().optional(),
  rotate: z.number().finite().optional(),
  layer: z.number().int(),
  machining: z.boolean(),
  paths: z.array(ncepSubpathSchema),
  params: z.record(z.string(), z.string()),
})
export type NcepMark = z.infer<typeof ncepMarkSchema>

export const ncepWireSchema = z.object({
  kind: z.literal('wire'),
  id: z.string().optional(),
  tag: z.string(),
  layer: z.number().int(),
  machining: z.boolean(),
  fill: z.boolean(),
  paths: z.array(ncepSubpathSchema).min(1),
  params: z.record(z.string(), z.string()),
})
export type NcepWire = z.infer<typeof ncepWireSchema>

export const ncepGroupSchema = z.object({
  id: z.string().optional(),
  layer: z.number().int(),
  machining: z.boolean(),
  params: z.record(z.string(), z.string()),
  userPath: z.boolean(),
  truncates: z.array(ncepTruncateSchema),
  holes: z.array(ncepHoleSchema),
  marks: z.array(ncepMarkSchema),
  wires: z.array(ncepWireSchema),
  nestedGroups: z.number().int().nonnegative(),
})
export type NcepGroup = z.infer<typeof ncepGroupSchema>

export const ncepPartGroupSchema = ncepGroupSchema.extend({
  refId: z.string().optional(),
  matrix: z.string().optional(),
})
export type NcepPartGroup = z.infer<typeof ncepPartGroupSchema>

export const ncepExtentsSchema = z.object({
  station: z.tuple([z.number(), z.number()]).nullable(),
  along: z.tuple([z.number(), z.number()]).nullable(),
})
export type NcepExtents = z.infer<typeof ncepExtentsSchema>

export const ncepSvgDocumentSchema = z.object({
  kind: z.enum(['part', 'adobe']),
  part: ncepPartGroupSchema.nullable(),
  groups: z.array(ncepGroupSchema),
  sections: z.array(ncepGroupSchema),
  userPaths: z.array(ncepGroupSchema),
  extents: ncepExtentsSchema,
  issues: z.array(ncepIssueSchema),
})
export type NcepSvgDocument = z.infer<typeof ncepSvgDocumentSchema>

export const ncepCadEntrySchema = z.object({
  idref: z.string(),
  svgname: z.string(),
  params: z.record(z.string(), z.string()),
  technologyID: z.string().optional(),
})
export type NcepCadEntry = z.infer<typeof ncepCadEntrySchema>

export const ncepPackageSchema = z.object({
  mark: z.string().nullable(),
  quantity: z.number().int().nullable(),
  typeCode: z.number().int().nullable(),
  profileType: z.enum(['I', 'U', 'M', 'unknown']),
  thickness: z.number().nullable(),
  legThickness: z.number().nullable(),
  adobes: z.array(ncepCadEntrySchema),
  parts: z.array(ncepCadEntrySchema),
  adobeSvg: ncepSvgDocumentSchema.nullable(),
  partSvg: ncepSvgDocumentSchema.nullable(),
  files: z.array(z.string()),
  issues: z.array(ncepIssueSchema),
})
export type NcepPackage = z.infer<typeof ncepPackageSchema>

export const TYPE_CODE_TO_PROFILE: Record<number, 'I' | 'U' | 'M'> = {
  8195: 'M',
  8199: 'U',
  8200: 'I',
}

const MIMETYPE = 'application/ncex+zip'
const STATION_TOLERANCE = 0.5
const OUTLINE_TOLERANCE = 1

const svgParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  allowBooleanAttributes: true,
})

const cadParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  processEntities: true,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ['Adobe', 'Part', 'BaseZone', 'Result'].includes(name),
})

interface XmlElement {
  tag: string
  attrs: Record<string, string>
  children: unknown[]
}

function* elements(children: unknown[]): Generator<XmlElement> {
  for (const child of children) {
    if (!child || typeof child !== 'object' || Array.isArray(child)) continue
    const record = child as Record<string, unknown>
    const keys = Object.keys(record).filter((key) => key !== ':@' && key !== '$')
    if (keys.length !== 1) continue
    const tag = keys[0] as string
    if (tag.startsWith('#') || tag === '?xml' || tag.startsWith('!')) continue
    const kids = record[tag]
    if (!Array.isArray(kids)) continue
    const rawAttrs = (record[':@'] ?? record.$ ?? {}) as Record<string, unknown>
    const attrs: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawAttrs)) attrs[key] = String(value)
    yield { tag, attrs, children: kids }
  }
}

function textOf(children: unknown[]): string {
  let text = ''
  for (const child of children) {
    if (!child || typeof child !== 'object' || Array.isArray(child)) continue
    const record = child as Record<string, unknown>
    const value = record['#text']
    if (typeof value === 'string') text += value
  }
  return text.trim()
}

function parseParamString(value: string | undefined): Record<string, string> {
  const params: Record<string, string> = {}
  if (!value) return params
  for (const part of value.split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    params[part.slice(0, at)] = part.slice(at + 1)
  }
  return params
}

function parseInnerCad(value: string | undefined): { points: NcepPoint[]; error: string | null } {
  if (!value) return { points: [], error: null }
  const points: NcepPoint[] = []
  const pieces = value.split('N')
  for (let index = 0; index < pieces.length; index++) {
    let piece = (pieces[index] as string).trim()
    if (!piece) continue
    if (index === 0) {
      if (!piece.startsWith('M')) return { points: [], error: 'InnerCad must start with M' }
      piece = piece.slice(1)
    }
    const [rawX, rawY] = piece.split(',')
    const x = Number(rawX)
    const y = Number(rawY)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { points: [], error: `bad InnerCad vertex "${piece}"` }
    }
    points.push([x, y])
  }
  if (points.length < 2) return { points: [], error: 'InnerCad has fewer than two vertices' }
  return { points, error: null }
}

function balancedBraces(value: string): boolean {
  let depth = 0
  for (const char of value) {
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth < 0) return false
    }
  }
  return depth === 0
}

function toNumber(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function requiredNumber(
  value: string | undefined,
  name: string,
  issues: NcepIssue[],
): number | undefined {
  const number = toNumber(value)
  if (number == null) issues.push({ code: 'number', severity: 'error', message: `invalid ${name}` })
  return number
}

function subpathsFromPoints(points: SvgPoint[], closed: boolean): SvgSubpath[] {
  return points.length >= 2 ? [{ points, closed }] : []
}

function rectSubpath(
  x: number,
  y: number,
  width: number,
  height: number,
  transform: RotateTransform | null,
): SvgSubpath[] {
  let points: SvgPoint[] = [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ]
  if (transform) points = rotatePoints(points, transform.angle, transform.cx, transform.cy)
  return subpathsFromPoints(points, true)
}

function pointsSubpath(points: number[], closed: boolean): SvgSubpath[] {
  if (points.length < 4 || points.length % 2 !== 0) return []
  const pairs: SvgPoint[] = []
  for (let index = 0; index < points.length; index += 2) {
    pairs.push([points[index] as number, points[index + 1] as number])
  }
  return subpathsFromPoints(pairs, closed)
}

interface ElementCommon {
  id?: string
  layer: number
  machining: boolean
  fill: boolean
  params: Record<string, string>
  technical?: string
  transform: RotateTransform | null
}

function commonOf(element: XmlElement, issues: NcepIssue[]): ElementCommon {
  const layer = toNumber(element.attrs['wh:layer'])
  const params = parseParamString(element.attrs['wh:params'])
  const technical = element.attrs['wh:technical']
  if (technical && !balancedBraces(technical)) {
    issues.push({
      code: 'technical-braces',
      severity: 'warning',
      message: `unbalanced braces in wh:technical on <${element.tag}>`,
    })
  }
  return {
    id: element.attrs['wh:id'],
    layer: layer ?? 0,
    machining: element.attrs['wh:machining'] === '1',
    fill: element.attrs['wh:isfill'] === '1',
    params,
    technical,
    transform: parseRotateTransform(element.attrs.transform),
  }
}

function parseTruncate(
  element: XmlElement,
  common: ElementCommon,
  issues: NcepIssue[],
): NcepTruncate | null {
  const rawType = common.params.TrucateType
  if (rawType !== '0' && rawType !== '1') {
    issues.push({
      code: 'truncate-type',
      severity: 'error',
      message: `IsTrucate path has invalid TrucateType "${rawType ?? ''}"`,
    })
    return null
  }
  let paths: NcepSubpath[]
  try {
    paths = parseSvgPath(element.attrs.d ?? '')
  } catch (error) {
    issues.push({
      code: 'path',
      severity: 'error',
      message: `truncate path: ${(error as Error).message}`,
    })
    return null
  }
  if (paths.length === 0) {
    issues.push({ code: 'path-empty', severity: 'error', message: 'truncate path has no segments' })
    return null
  }
  const inner = parseInnerCad(common.params.InnerCad)
  if (inner.error) {
    issues.push({ code: 'innercad', severity: 'warning', message: `truncate ${inner.error}` })
  }
  return {
    kind: 'truncate',
    id: common.id,
    truncateType: rawType === '1' ? 1 : 0,
    part: common.params.Part,
    paths,
    params: common.params,
    ...(inner.points.length >= 2 ? { innerCad: inner.points } : {}),
  }
}

function parseHole(
  element: XmlElement,
  common: ElementCommon,
  issues: NcepIssue[],
): NcepHole | null {
  const cx = requiredNumber(element.attrs.cx, 'circle cx', issues)
  const cy = requiredNumber(element.attrs.cy, 'circle cy', issues)
  const r = requiredNumber(element.attrs.r, 'circle r', issues)
  if (cx == null || cy == null || r == null || r <= 0) return null
  const inner = parseInnerCad(common.params.InnerCad)
  if (inner.error) {
    issues.push({ code: 'innercad', severity: 'warning', message: `hole ${inner.error}` })
  }
  return {
    kind: 'hole',
    id: common.id,
    cx,
    cy,
    r,
    direction: toNumber(element.attrs['wh:direction']),
    layer: common.layer,
    machining: common.machining,
    params: common.params,
    ...(inner.points.length >= 2 ? { innerCad: inner.points } : {}),
  }
}

function parseMark(
  element: XmlElement,
  common: ElementCommon,
  issues: NcepIssue[],
): NcepMark | null {
  const base = {
    kind: 'mark' as const,
    id: common.id,
    layer: common.layer,
    machining: common.machining,
    params: common.params,
  }
  if (element.tag === 'text') {
    const text = textOf(element.children)
    const label = common.params.LabelContent ?? text
    const transform = common.transform
    const rotate = transform?.angle ?? toNumber(common.params.LabelRotate)
    return {
      ...base,
      tag: 'text' as const,
      label,
      text,
      x: toNumber(element.attrs.x),
      y: toNumber(element.attrs.y),
      height: toNumber(element.attrs['font-size']) ?? toNumber(common.params.LabelHeight),
      rotate,
      paths: [],
    }
  }
  if (element.tag === 'rect') {
    const x = requiredNumber(element.attrs.x, 'rect x', issues)
    const y = requiredNumber(element.attrs.y, 'rect y', issues)
    const width = requiredNumber(element.attrs.width, 'rect width', issues)
    const height = requiredNumber(element.attrs.height, 'rect height', issues)
    if (x == null || y == null || width == null || height == null) return null
    return {
      ...base,
      tag: 'rect' as const,
      paths: rectSubpath(x, y, width, height, common.transform),
    }
  }
  if (element.tag === 'line') {
    const x1 = requiredNumber(element.attrs.x1, 'line x1', issues)
    const y1 = requiredNumber(element.attrs.y1, 'line y1', issues)
    const x2 = requiredNumber(element.attrs.x2, 'line x2', issues)
    const y2 = requiredNumber(element.attrs.y2, 'line y2', issues)
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null
    const points: SvgPoint[] = [
      [x1, y1],
      [x2, y2],
    ]
    const rotated = common.transform
      ? rotatePoints(points, common.transform.angle, common.transform.cx, common.transform.cy)
      : points
    return { ...base, tag: 'line' as const, paths: subpathsFromPoints(rotated, false) }
  }
  if (element.tag === 'circle') {
    const cx = requiredNumber(element.attrs.cx, 'mark circle cx', issues)
    const cy = requiredNumber(element.attrs.cy, 'mark circle cy', issues)
    const r = requiredNumber(element.attrs.r, 'mark circle r', issues)
    if (cx == null || cy == null || r == null || r <= 0) return null
    const points: SvgPoint[] = []
    for (let index = 0; index <= 32; index++) {
      const angle = (index / 32) * Math.PI * 2
      points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r])
    }
    return { ...base, tag: 'circle' as const, paths: subpathsFromPoints(points, true) }
  }
  if (element.tag === 'path' || element.tag === 'polyline' || element.tag === 'polygon') {
    let paths: SvgSubpath[] = []
    try {
      if (element.attrs.d) {
        paths = parseSvgPath(element.attrs.d)
      } else if (element.attrs.points) {
        const numbers = element.attrs.points
          .split(/[\s,]+/)
          .map(Number)
          .filter((value) => Number.isFinite(value))
        paths = pointsSubpath(numbers, element.tag === 'polygon')
      }
    } catch (error) {
      issues.push({
        code: 'path',
        severity: 'error',
        message: `mark path: ${(error as Error).message}`,
      })
      return null
    }
    if (element.attrs.transform) {
      const transform = common.transform
      if (!transform) {
        issues.push({
          code: 'transform',
          severity: 'warning',
          message: `unsupported mark transform "${element.attrs.transform}"`,
        })
      } else {
        paths = paths.map((path) => ({
          points: rotatePoints(path.points, transform.angle, transform.cx, transform.cy),
          closed: path.closed,
        }))
      }
    }
    return { ...base, tag: 'path' as const, paths }
  }
  issues.push({
    code: 'mark-tag',
    severity: 'warning',
    message: `unclassified layer-6 element <${element.tag}>`,
  })
  return { ...base, tag: 'other' as const, paths: [] }
}

function parseWire(
  element: XmlElement,
  common: ElementCommon,
  issues: NcepIssue[],
): NcepWire | null {
  let paths: SvgSubpath[] = []
  try {
    if (element.tag === 'path' || element.tag === 'polyline' || element.tag === 'polygon') {
      if (element.attrs.d) paths = parseSvgPath(element.attrs.d)
      else if (element.attrs.points) {
        const numbers = element.attrs.points
          .split(/[\s,]+/)
          .map(Number)
          .filter((value) => Number.isFinite(value))
        paths = pointsSubpath(numbers, element.tag === 'polygon')
      }
    } else if (element.tag === 'rect') {
      const x = requiredNumber(element.attrs.x, 'rect x', issues)
      const y = requiredNumber(element.attrs.y, 'rect y', issues)
      const width = requiredNumber(element.attrs.width, 'rect width', issues)
      const height = requiredNumber(element.attrs.height, 'rect height', issues)
      if (x != null && y != null && width != null && height != null) {
        paths = rectSubpath(x, y, width, height, common.transform)
      }
    } else if (element.tag === 'line') {
      const x1 = requiredNumber(element.attrs.x1, 'line x1', issues)
      const y1 = requiredNumber(element.attrs.y1, 'line y1', issues)
      const x2 = requiredNumber(element.attrs.x2, 'line x2', issues)
      const y2 = requiredNumber(element.attrs.y2, 'line y2', issues)
      if (x1 != null && y1 != null && x2 != null && y2 != null) {
        paths = subpathsFromPoints(
          [
            [x1, y1],
            [x2, y2],
          ],
          false,
        )
      }
    }
  } catch (error) {
    issues.push({
      code: 'path',
      severity: 'error',
      message: `wire path: ${(error as Error).message}`,
    })
    return null
  }
  if (paths.length === 0) return null
  return {
    kind: 'wire',
    id: common.id,
    tag: element.tag,
    layer: common.layer,
    machining: common.machining,
    fill: common.fill,
    paths,
    params: common.params,
  }
}

function parseGroup(element: XmlElement, issues: NcepIssue[]): NcepGroup {
  const common = commonOf(element, issues)
  const group: NcepGroup = {
    id: common.id,
    layer: common.layer,
    machining: common.machining,
    params: common.params,
    userPath: Boolean(common.params.USERPATH),
    truncates: [],
    holes: [],
    marks: [],
    wires: [],
    nestedGroups: 0,
  }
  for (const child of elements(element.children)) {
    if (child.tag === 'g') {
      group.nestedGroups++
      const cls = child.attrs['wh:class'] ?? ''
      issues.push({
        code: 'nested-group',
        severity: 'warning',
        message: `nested <g${cls ? ` wh:class="${cls}"` : ''}> inside a group (features are direct children)`,
      })
      continue
    }
    const childCommon = commonOf(child, issues)
    if (childCommon.params.IsTrucate === '1') {
      const truncate = parseTruncate(child, childCommon, issues)
      if (truncate) group.truncates.push(truncate)
      continue
    }
    if (child.tag === 'circle' && childCommon.layer === 0) {
      const hole = parseHole(child, childCommon, issues)
      if (hole) group.holes.push(hole)
      continue
    }
    if (childCommon.layer === 6) {
      const mark = parseMark(child, childCommon, issues)
      if (mark) group.marks.push(mark)
      continue
    }
    const wire = parseWire(child, childCommon, issues)
    if (wire) group.wires.push(wire)
  }
  return group
}

function computedExtents(
  truncates: NcepTruncate[],
): { station: [number, number]; along: [number, number] } | null {
  const points = truncates.flatMap((truncate) => truncate.paths.flatMap((path) => path.points))
  if (points.length === 0) return null
  const stations = points.map(([x]) => x)
  const alongs = points.map(([, y]) => y)
  return {
    station: [Math.min(...stations), Math.max(...stations)],
    along: [Math.min(...alongs), Math.max(...alongs)],
  }
}

function validateSvg(document: NcepSvgDocument): void {
  const issues = document.issues
  if (document.kind === 'part') {
    if (!document.part) {
      issues.push({ code: 'cadpart', severity: 'error', message: 'missing wh:class="cadpart"' })
    } else {
      if (!document.part.refId) {
        issues.push({
          code: 'cadpart-refid',
          severity: 'warning',
          message: 'cadpart has no wh:refid',
        })
      }
      if (document.part.truncates.length !== 2) {
        issues.push({
          code: 'truncate-count',
          severity: 'error',
          message: `cadpart has ${document.part.truncates.length} IsTrucate paths (expected 2)`,
        })
      } else {
        const types = document.part.truncates.map((truncate) => truncate.truncateType).sort()
        if (types[0] !== 0 || types[1] !== 1) {
          issues.push({
            code: 'truncate-types',
            severity: 'error',
            message: `cadpart truncates are types ${types.join(',')} (expected 0 and 1)`,
          })
        }
      }
    }
  } else if (document.part) {
    issues.push({
      code: 'adobe-cadpart',
      severity: 'error',
      message: 'adobe SVG contains a cadpart',
    })
  }

  if (document.sections.length === 0) {
    issues.push({
      code: 'section',
      severity: 'error',
      message: 'missing sibling cadgroup section outline',
    })
  }

  const partTruncates = document.part?.truncates ?? []
  const extents = computedExtents(partTruncates)
  document.extents = extents
    ? { station: extents.station, along: extents.along }
    : { station: null, along: null }

  if (extents && partTruncates.length === 2) {
    const ranges = partTruncates.map((truncate) => {
      const points = truncate.paths.flatMap((path) => path.points)
      const stations = points.map(([x]) => x)
      return [Math.min(...stations), Math.max(...stations)] as [number, number]
    })
    const first = ranges[0] as [number, number]
    const second = ranges[1] as [number, number]
    if (
      Math.abs(first[0] - second[0]) > STATION_TOLERANCE ||
      Math.abs(first[1] - second[1]) > STATION_TOLERANCE
    ) {
      issues.push({
        code: 'truncate-span',
        severity: 'warning',
        message: `start/end truncates span different stations (${first.join('..')} vs ${second.join('..')})`,
      })
    }
  }

  const holes = document.part?.holes ?? []
  if (extents) {
    for (const hole of holes) {
      if (
        hole.cx < extents.station[0] - OUTLINE_TOLERANCE ||
        hole.cx > extents.station[1] + OUTLINE_TOLERANCE
      ) {
        issues.push({
          code: 'hole-station',
          severity: 'warning',
          message: `hole at x=${hole.cx.toFixed(2)} is outside the developed station range`,
        })
      }
      if (
        hole.cy < extents.along[0] - OUTLINE_TOLERANCE ||
        hole.cy > extents.along[1] + OUTLINE_TOLERANCE
      ) {
        issues.push({
          code: 'hole-along',
          severity: 'warning',
          message: `hole at y=${hole.cy.toFixed(2)} is outside the cut envelope`,
        })
      }
    }
  }
}

export function parseNcepSvg(text: string, kind: 'part' | 'adobe'): NcepSvgDocument {
  const issues: NcepIssue[] = []
  let parsed: unknown
  try {
    parsed = svgParser.parse(text)
  } catch (error) {
    issues.push({ code: 'xml', severity: 'error', message: (error as Error).message })
    return {
      kind,
      part: null,
      groups: [],
      sections: [],
      userPaths: [],
      extents: { station: null, along: null },
      issues,
    }
  }
  if (!Array.isArray(parsed)) {
    issues.push({ code: 'xml', severity: 'error', message: 'SVG root is not an element list' })
    return {
      kind,
      part: null,
      groups: [],
      sections: [],
      userPaths: [],
      extents: { station: null, along: null },
      issues,
    }
  }

  let root: XmlElement | null = null
  for (const element of elements(parsed)) {
    if (element.tag === 'svg') {
      root = element
      break
    }
  }
  if (!root) {
    issues.push({ code: 'xml', severity: 'error', message: 'missing <svg> root' })
    return {
      kind,
      part: null,
      groups: [],
      sections: [],
      userPaths: [],
      extents: { station: null, along: null },
      issues,
    }
  }

  let part: NcepPartGroup | null = null
  const groups: NcepGroup[] = []
  for (const child of elements(root.children)) {
    if (child.tag !== 'g') continue
    const cls = child.attrs['wh:class']
    if (cls === 'cadpart') {
      if (part) {
        issues.push({
          code: 'cadpart-multiple',
          severity: 'error',
          message: 'multiple cadpart groups',
        })
        continue
      }
      const group = parseGroup(child, issues)
      part = {
        ...group,
        refId: child.attrs['wh:refid'],
        matrix: child.attrs['wh:matrixinfo3d'],
      }
      continue
    }
    if (cls === 'cadgroup' || cls === 'cadrelationgroup') {
      groups.push(parseGroup(child, issues))
      continue
    }
    issues.push({
      code: 'root-group',
      severity: 'warning',
      message: `unclassified root group${cls ? ` wh:class="${cls}"` : ''}`,
    })
  }

  const sections = groups.filter(
    (group) =>
      !group.userPath &&
      group.truncates.length === 0 &&
      group.holes.length === 0 &&
      group.marks.length === 0 &&
      group.wires.length > 0,
  )
  const userPaths = groups.filter((group) => group.userPath)

  const document: NcepSvgDocument = {
    kind,
    part,
    groups,
    sections,
    userPaths,
    extents: { station: null, along: null },
    issues,
  }
  validateSvg(document)

  const validated = ncepSvgDocumentSchema.safeParse(document)
  if (!validated.success) {
    for (const issue of validated.error.issues) {
      issues.push({
        code: 'schema',
        severity: 'error',
        message: `${issue.path.join('.')}: ${issue.message}`,
      })
    }
  }
  return document
}

function parseCadEntry(value: Record<string, unknown>): NcepCadEntry | null {
  const idref = value.idref == null ? '' : String(value.idref)
  const svgname = value.svgname == null ? '' : String(value.svgname)
  if (!idref || !svgname) return null
  return {
    idref,
    svgname,
    params: parseParamString(value.params == null ? undefined : String(value.params)),
    ...(value.technologyID == null ? {} : { technologyID: String(value.technologyID) }),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    const record = asRecord(value)
    return record ? [record] : []
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry)
    return record ? [record] : []
  })
}

interface CadRoot {
  adobes: NcepCadEntry[]
  parts: NcepCadEntry[]
}

function parseCadRoot(text: string, issues: NcepIssue[]): CadRoot {
  let parsed: unknown
  try {
    parsed = cadParser.parse(text)
  } catch (error) {
    issues.push({ code: 'cadroot', severity: 'error', message: (error as Error).message })
    return { adobes: [], parts: [] }
  }
  const root = asRecord(parsed)
  const cadroot = root ? asRecord(root.cadroot) : null
  if (!cadroot) {
    issues.push({ code: 'cadroot', severity: 'error', message: 'missing <cadroot>' })
    return { adobes: [], parts: [] }
  }
  const adobesRecord = asRecord(cadroot.Adobes)
  const partsRecord = asRecord(cadroot.Parts)
  const adobes = asArray(adobesRecord?.Adobe)
    .map(parseCadEntry)
    .filter((entry): entry is NcepCadEntry => entry != null)
  const parts = asArray(partsRecord?.Part)
    .map(parseCadEntry)
    .filter((entry): entry is NcepCadEntry => entry != null)
  return { adobes, parts }
}

function numberParam(params: Record<string, string>, key: string): number | null {
  const value = toNumber(params[key])
  return value ?? null
}

function emptyPackage(issues: NcepIssue[]): NcepPackage {
  return {
    mark: null,
    quantity: null,
    typeCode: null,
    profileType: 'unknown',
    thickness: null,
    legThickness: null,
    adobes: [],
    parts: [],
    adobeSvg: null,
    partSvg: null,
    files: [],
    issues,
  }
}

export function parseNcepPackage(bytes: Uint8Array): NcepPackage {
  const issues: NcepIssue[] = []
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch (error) {
    issues.push({ code: 'zip', severity: 'error', message: (error as Error).message })
    return emptyPackage(issues)
  }
  const names = Object.keys(files)

  const mimetype = files.mimetype ? strFromU8(files.mimetype) : ''
  if (mimetype !== MIMETYPE) {
    issues.push({
      code: 'mimetype',
      severity: 'error',
      message: `mimetype is "${mimetype}" (expected "${MIMETYPE}")`,
    })
  }

  const required = [
    'META-INF/container.xml',
    'ncex.opf',
    'CAD/cad.opf',
    'CAD/CadRoot.xml',
    'CAD/Technology.xml',
    'CAD/CustomizeData.xml',
  ]
  for (const path of required) {
    if (!files[path]) {
      issues.push({ code: 'missing-file', severity: 'warning', message: `missing ${path}` })
    }
  }
  if (names.some((name) => name.startsWith('CNC/'))) {
    issues.push({
      code: 'cnc-payload',
      severity: 'warning',
      message: 'package carries a CNC/ payload (this is an NCEX, not a CAD-only NCEP)',
    })
  }

  const cadRootBytes = files['CAD/CadRoot.xml']
  const cad = cadRootBytes
    ? parseCadRoot(strFromU8(cadRootBytes), issues)
    : { adobes: [], parts: [] }
  if (cad.adobes.length !== 1) {
    issues.push({
      code: 'adobe-count',
      severity: cad.adobes.length === 0 ? 'error' : 'warning',
      message: `CadRoot has ${cad.adobes.length} Adobe entries (NCEP expects 1)`,
    })
  }
  if (cad.parts.length !== 1) {
    issues.push({
      code: 'part-count',
      severity: cad.parts.length === 0 ? 'error' : 'warning',
      message: `CadRoot has ${cad.parts.length} Part entries (NCEP expects 1)`,
    })
  }

  const partEntry = cad.parts[0]
  const adobeEntry = cad.adobes[0]
  const partParams = partEntry?.params ?? {}
  const adobeParams = adobeEntry?.params ?? {}
  const mark = partParams.Name ?? adobeParams.Name ?? null
  const typeCode = numberParam(partParams, 'Type')
  const quantity = numberParam(partParams, 'TotalCount') ?? numberParam(adobeParams, 'TotalCount')
  const thickness = numberParam(partParams, 'Thickness')
  const legThickness = numberParam(partParams, 'LegThickness')
  const profileType = typeCode == null ? 'unknown' : (TYPE_CODE_TO_PROFILE[typeCode] ?? 'unknown')

  const readSvg = (svgname: string | undefined): string | null => {
    if (!svgname) return null
    const path = `CAD/${svgname}`
    const data = files[path]
    if (!data) {
      issues.push({ code: 'missing-svg', severity: 'error', message: `missing ${path}` })
      return null
    }
    return strFromU8(data)
  }

  const partText = readSvg(partEntry?.svgname)
  const adobeText = readSvg(adobeEntry?.svgname)
  const partSvg = partText ? parseNcepSvg(partText, 'part') : null
  const adobeSvg = adobeText ? parseNcepSvg(adobeText, 'adobe') : null

  if (partSvg) {
    for (const issue of partSvg.issues) {
      issues.push({ ...issue, path: 'part', message: `part: ${issue.message}` })
    }
  }
  if (adobeSvg) {
    for (const issue of adobeSvg.issues) {
      issues.push({ ...issue, path: 'adobe', message: `adobe: ${issue.message}` })
    }
  }

  if (mark == null) {
    issues.push({ code: 'mark', severity: 'error', message: 'CadRoot Part has no Name (mark)' })
  }
  if (quantity == null || quantity <= 0) {
    issues.push({
      code: 'quantity',
      severity: 'warning',
      message: `invalid TotalCount "${partParams.TotalCount ?? ''}"`,
    })
  }
  if (typeCode == null) {
    issues.push({ code: 'type', severity: 'warning', message: 'CadRoot Part has no Type' })
  } else if (profileType === 'unknown') {
    issues.push({
      code: 'type',
      severity: 'warning',
      message: `unknown WiseCAM Type=${typeCode}`,
    })
  }

  if (mark && partSvg) {
    const labels = partSvg.part?.marks
      .map((mark) => mark.label ?? mark.text)
      .filter((label): label is string => Boolean(label))
    if (labels && labels.length > 0 && !labels.includes(mark)) {
      issues.push({
        code: 'mark-mismatch',
        severity: 'warning',
        message: `CadRoot mark "${mark}" differs from SVG label(s) ${labels.join(', ')}`,
      })
    }
  }

  const result: NcepPackage = {
    mark,
    quantity: quantity == null ? null : Math.trunc(quantity),
    typeCode,
    profileType,
    thickness,
    legThickness,
    adobes: cad.adobes,
    parts: cad.parts,
    adobeSvg,
    partSvg,
    files: names,
    issues,
  }

  const validated = ncepPackageSchema.safeParse(result)
  if (!validated.success) {
    for (const issue of validated.error.issues) {
      issues.push({
        code: 'schema',
        severity: 'error',
        message: `${issue.path.join('.')}: ${issue.message}`,
      })
    }
  }
  return result
}

export function ncepErrors(pkg: NcepPackage): NcepIssue[] {
  return pkg.issues.filter((issue) => issue.severity === 'error')
}
