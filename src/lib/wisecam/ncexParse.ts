import { XMLParser } from 'fast-xml-parser'
import { strFromU8, unzipSync } from 'fflate'
import { z } from 'zod'

/**
 * Read-only parser for a WiseCAM nest package (`.ncexa` / `.ncex` with `Results`).
 *
 * Unlike `ncepParse.ts` (one part, one adobe, no results), a nest package is a whole
 * project: many stock **adobes**, many **parts**, and one or more **results** (nest
 * layouts). Quantities live in three places and must agree:
 *
 * - `Part.TotalCount`   — how many of the part the job needs.
 * - `Part.NestedCount`  — how many the project has nested (WiseCAM's own total).
 * - `Result.PartInfo`   — `(partId,count)` per **one stock bar**; `Result.params.Count`
 *   is how many bars of that layout. So nested = `Σ(count × Count)`.
 *
 * The `<id>_0.svg` beside a result holds the placed instances; its `cadpart` count is the
 * per-bar quantity (never multiplied by `Count`). See `docs/ncexa-format.md` §3.
 *
 * The docs carry mis-encoded Chinese in `ResultName`, so parse tolerantly: the shared
 * parser keeps replacement characters but must not throw on them.
 */

export const ncexPointSchema = z.tuple([z.number().finite(), z.number().finite()])
export type NcexPoint = z.infer<typeof ncexPointSchema>

export const ncexIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  path: z.string().optional(),
})
export type NcexIssue = z.infer<typeof ncexIssueSchema>

export const ncexCadEntrySchema = z.object({
  idref: z.string(),
  svgname: z.string(),
  params: z.record(z.string(), z.string()),
  name: z.string().nullable(),
  typeCode: z.number().int().nullable(),
  totalCount: z.number().int().nullable(),
  nestedCount: z.number().int().nullable(),
  length: z.number().nullable(),
  thickness: z.number().nullable(),
  legThickness: z.number().nullable(),
  technologyId: z.string().nullable(),
})
export type NcexCadEntry = z.infer<typeof ncexCadEntrySchema>

export const ncexPlacementSchema = z.object({
  partId: z.string(),
  count: z.number().int().nonnegative(),
})
export type NcexPlacement = z.infer<typeof ncexPlacementSchema>

export const ncexResultSchema = z.object({
  idref: z.string(),
  adobeId: z.string(),
  /** The `count` XML attribute on `<Result>` (informational; not a quantity multiplier). */
  rowCount: z.number().int().nullable(),
  /** `params.Count` — how many stock bars of this layout. */
  copies: z.number().int().nonnegative(),
  /** `params.PartInfo` — pieces of each part on **one** stock bar. */
  partInfo: z.array(ncexPlacementSchema),
  /** Pieces on one bar: `Σ PartInfo[].count`. */
  piecesPerBar: z.number().int().nonnegative(),
  /** Total pieces this result produces: `piecesPerBar × copies`. */
  totalPieces: z.number().int().nonnegative(),
  utilization: z.number().nullable(),
  name: z.string().nullable(),
  /** Placed `cadpart` instances counted from `<idref>_0.svg`, per bar. */
  drawn: z.array(ncexPlacementSchema).nullable(),
  svgname: z.string().nullable(),
})
export type NcexResult = z.infer<typeof ncexResultSchema>

export const ncexPackageSchema = z.object({
  files: z.array(z.string()),
  adobes: z.array(ncexCadEntrySchema),
  parts: z.array(ncexCadEntrySchema),
  results: z.array(ncexResultSchema),
  baseZone: z
    .object({
      idref: z.string(),
      count: z.number().int().nullable(),
      adobeId: z.string().nullable(),
    })
    .nullable(),
  issues: z.array(ncexIssueSchema),
})
export type NcexPackage = z.infer<typeof ncexPackageSchema>

export const TYPE_CODE_TO_PROFILE: Record<number, 'I' | 'U' | 'M'> = {
  8195: 'M',
  8199: 'U',
  8200: 'I',
}

const MIMETYPE = 'application/ncex+zip'

const cadParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  processEntities: true,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ['Adobe', 'Part', 'BaseZone', 'Result'].includes(name),
})

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

export function parseParamString(value: string | undefined): Record<string, string> {
  const params: Record<string, string> = {}
  if (!value) return params
  for (const part of value.split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    params[part.slice(0, at)] = part.slice(at + 1)
  }
  return params
}

function toNumber(value: string | undefined): number | null {
  if (value == null || value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function intParam(
  params: Record<string, string>,
  key: string,
  issues: NcexIssue[],
  path: string,
): number | null {
  const raw = params[key]
  if (raw == null) return null
  const value = toNumber(raw)
  if (value == null) {
    issues.push({
      code: 'number',
      severity: 'warning',
      message: `${path}: invalid ${key} "${raw}"`,
      path,
    })
    return null
  }
  return Math.trunc(value)
}

function numberParam(params: Record<string, string>, key: string): number | null {
  return toNumber(params[key])
}

function cadEntry(
  value: Record<string, unknown>,
  kind: 'adobe' | 'part',
  issues: NcexIssue[],
): NcexCadEntry | null {
  const idref = value.idref == null ? '' : String(value.idref)
  const svgname = value.svgname == null ? '' : String(value.svgname)
  if (!idref || !svgname) {
    issues.push({
      code: 'cad-entry',
      severity: 'error',
      message: `CadRoot ${kind} without idref/svgname`,
      path: `CAD/CadRoot.xml`,
    })
    return null
  }
  const params = parseParamString(value.params == null ? undefined : String(value.params))
  const path = `CAD/CadRoot.xml#${kind}:${idref}`
  return {
    idref,
    svgname,
    params,
    name: params.Name ?? null,
    typeCode: intParam(params, 'Type', issues, path),
    totalCount: intParam(params, 'TotalCount', issues, path),
    nestedCount: intParam(params, 'NestedCount', issues, path),
    length: numberParam(params, 'Length'),
    thickness: numberParam(params, 'Thickness'),
    legThickness: numberParam(params, 'LegThickness'),
    technologyId: value.technologyID == null ? null : String(value.technologyID),
  }
}

export function parsePartInfo(value: string | undefined): NcexPlacement[] {
  if (!value) return []
  const placements: NcexPlacement[] = []
  for (const match of value.matchAll(/\(([^,()]+),(\d+)\)/g)) {
    const partId = (match[1] as string).trim()
    const count = Number(match[2])
    if (!partId || !Number.isFinite(count)) continue
    placements.push({ partId, count: Math.trunc(count) })
  }
  return placements
}

/**
 * Count the placed `cadpart` instances in a result SVG, grouped by `wh:refid`.
 *
 * The result SVG is a nest drawing, not a part: every placed piece is one `<g
 * wh:class="cadpart" wh:refid="…">`. WiseCAM does not nest these groups, so a tag scan
 * is enough (and survives the mis-encoded XML that breaks strict DOM parsers).
 */
export function countPlacedParts(svg: string): NcexPlacement[] {
  const counts = new Map<string, number>()
  for (const match of svg.matchAll(/<g\b[^>]*>/g)) {
    const tag = match[0]
    if (!/class="cadpart"/.test(tag)) continue
    const ref = /wh:refid="([^"]+)"/.exec(tag)?.[1]
    if (!ref) continue
    counts.set(ref, (counts.get(ref) ?? 0) + 1)
  }
  return [...counts].map(([partId, count]) => ({ partId, count }))
}

function parseResult(
  value: Record<string, unknown>,
  files: Record<string, Uint8Array>,
  issues: NcexIssue[],
): NcexResult | null {
  const idref = value.idref == null ? '' : String(value.idref)
  if (!idref) {
    issues.push({
      code: 'result-id',
      severity: 'error',
      message: 'CadRoot Result without idref',
      path: 'CAD/CadRoot.xml',
    })
    return null
  }
  const path = `CAD/CadRoot.xml#result:${idref}`
  const params = parseParamString(value.params == null ? undefined : String(value.params))
  const partInfo = parsePartInfo(params.PartInfo)
  if (params.PartInfo && partInfo.length === 0) {
    issues.push({
      code: 'partinfo',
      severity: 'warning',
      message: `result ${idref}: PartInfo has no (partId,count) pairs`,
      path,
    })
  }
  const copies = intParam(params, 'Count', issues, path) ?? 1
  if (copies < 0) {
    issues.push({
      code: 'result-copies',
      severity: 'error',
      message: `result ${idref}: negative Count ${copies}`,
      path,
    })
  }
  const piecesPerBar = partInfo.reduce((total, placement) => total + placement.count, 0)
  const svgname = `${idref}_0.svg`
  const svg = files[`CAD/${svgname}`]
  const drawn = svg ? countPlacedParts(strFromU8(svg)) : null
  return {
    idref,
    adobeId: value.adobeid == null ? '' : String(value.adobeid),
    rowCount: toNumber(value.count == null ? undefined : String(value.count)) ?? null,
    copies: Math.max(0, copies),
    partInfo,
    piecesPerBar,
    totalPieces: piecesPerBar * Math.max(0, copies),
    utilization: numberParam(params, 'Utilization'),
    name: params.ResultName ?? null,
    drawn,
    svgname: svg ? svgname : null,
  }
}

function parseBaseZone(value: unknown): NcexPackage['baseZone'] {
  const record = asRecord(value)
  if (!record) return null
  const idref = record.idref == null ? '' : String(record.idref)
  if (!idref) return null
  return {
    idref,
    count: toNumber(record.count == null ? undefined : String(record.count)) ?? null,
    adobeId: record.adobeid == null ? null : String(record.adobeid),
  }
}

function emptyPackage(issues: NcexIssue[]): NcexPackage {
  return { files: [], adobes: [], parts: [], results: [], baseZone: null, issues }
}

export function parseNexPackage(bytes: Uint8Array): NcexPackage {
  const issues: NcexIssue[] = []
  let files: Record<string, Uint8Array>
  try {
    // A nest export carries a ~7 MB `TechnologySets.xml` and dozens of part/adobe SVGs that the
    // quantity check never reads. Filter at the ZIP layer so a folder of 40+ nestings doesn't
    // inflate hundreds of megabytes. `mimetype`, CadRoot and the result drawings are enough.
    files = unzipSync(bytes, {
      filter: (file) =>
        file.name === 'mimetype' ||
        file.name === 'CAD/CadRoot.xml' ||
        /^CAD\/[^/]+_0\.svg$/.test(file.name),
    })
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

  const cadBytes = files['CAD/CadRoot.xml']
  if (!cadBytes) {
    issues.push({
      code: 'missing-file',
      severity: 'error',
      message: 'missing CAD/CadRoot.xml',
    })
    return { ...emptyPackage(issues), files: names }
  }

  let parsed: unknown
  try {
    parsed = cadParser.parse(strFromU8(cadBytes))
  } catch (error) {
    issues.push({
      code: 'cadroot',
      severity: 'error',
      message: `CadRoot.xml: ${(error as Error).message}`,
      path: 'CAD/CadRoot.xml',
    })
    return { ...emptyPackage(issues), files: names }
  }
  const root = asRecord(parsed)
  const cadroot = root ? asRecord(root.cadroot) : null
  if (!cadroot) {
    issues.push({
      code: 'cadroot',
      severity: 'error',
      message: 'missing <cadroot>',
      path: 'CAD/CadRoot.xml',
    })
    return { ...emptyPackage(issues), files: names }
  }

  const adobes = asArray(asRecord(cadroot.Adobes)?.Adobe)
    .map((entry) => cadEntry(entry, 'adobe', issues))
    .filter((entry): entry is NcexCadEntry => entry != null)
  const parts = asArray(asRecord(cadroot.Parts)?.Part)
    .map((entry) => cadEntry(entry, 'part', issues))
    .filter((entry): entry is NcexCadEntry => entry != null)
  const results = asArray(asRecord(cadroot.Results)?.Result)
    .map((entry) => parseResult(entry, files, issues))
    .filter((entry): entry is NcexResult => entry != null)

  const partIds = new Set(parts.map((part) => part.idref))
  const adobeIds = new Set(adobes.map((adobe) => adobe.idref))
  for (const result of results) {
    for (const placement of result.partInfo) {
      if (!partIds.has(placement.partId)) {
        issues.push({
          code: 'result-part',
          severity: 'error',
          message: `result ${result.idref}: PartInfo references missing part ${placement.partId}`,
          path: `CAD/CadRoot.xml#result:${result.idref}`,
        })
      }
    }
    if (result.adobeId && !adobeIds.has(result.adobeId)) {
      issues.push({
        code: 'result-adobe',
        severity: 'warning',
        message: `result ${result.idref}: references missing adobe ${result.adobeId}`,
        path: `CAD/CadRoot.xml#result:${result.idref}`,
      })
    }
    if (result.drawn) {
      const drawnTotal = result.drawn.reduce((total, placement) => total + placement.count, 0)
      if (drawnTotal !== result.piecesPerBar) {
        issues.push({
          code: 'result-drawing',
          severity: 'error',
          message: `result ${result.idref}: drawing has ${drawnTotal} placed part(s), PartInfo declares ${result.piecesPerBar}`,
          path: `CAD/${result.svgname}`,
        })
      }
    }
  }

  const result: NcexPackage = {
    files: names,
    adobes,
    parts,
    results,
    baseZone: parseBaseZone(cadroot.BaseZone),
    issues,
  }
  const validated = ncexPackageSchema.safeParse(result)
  if (!validated.success) {
    for (const issue of validated.error.issues) {
      issues.push({
        code: 'schema',
        severity: 'error',
        message: `${issue.path.join('.')}: ${issue.message}`,
        path: 'CAD/CadRoot.xml',
      })
    }
  }
  return result
}

export function profileForType(typeCode: number | null): 'I' | 'U' | 'M' | 'unknown' {
  if (typeCode == null) return 'unknown'
  return TYPE_CODE_TO_PROFILE[typeCode] ?? 'unknown'
}
