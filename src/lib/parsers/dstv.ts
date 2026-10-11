import { z } from 'zod'

/**
 * Parser for DSTV NC files (`.nc1`/`.nc`), the German steel NC standard exported by Tekla.
 *
 * Blocks: `ST` header, `AK` outer contour, `IK` inner contour, `BO` holes, `SI` marking,
 * `EN` end. Data lines start with a face letter (`v` front/web, `o` top, `u` bottom,
 * `h` rear). See `docs/nc1-dstv-format.md`.
 *
 * Zod schemas describe the parsed structure and enforce correctness at runtime.
 */

export const faceSchema = z.enum(['v', 'o', 'u', 'h'])
export type DstvFace = z.infer<typeof faceSchema>

const FACE_LETTERS = new Set(['v', 'o', 'u', 'h'])
const PROFILE_TYPES = new Set(['I', 'U', 'L', 'M', 'RO', 'RU', 'B', 'C', 'T', 'SO'])
const BLOCK_CODES = new Set([
  'ST',
  'EN',
  'BO',
  'AK',
  'IK',
  'SI',
  'PU',
  'KO',
  'KA',
  'SC',
  'TO',
  'UE',
  'PR',
  'IN',
])

/** DSTV only defines four faces; anything else is ignored rather than guessed. */
function parseFace(token: string): DstvFace | null {
  const lower = token.toLowerCase() as DstvFace
  return FACE_LETTERS.has(lower) ? lower : null
}

/** Numbers may carry a trailing reference-edge letter, e.g. `135.08s`, `0.00u`. */
function parseNumber(token: string): number {
  const cleaned = token.replace(/[^0-9.+-]/g, '')
  return cleaned === '' ? Number.NaN : Number(cleaned)
}

function numbersFrom(tokens: string[]): number[] {
  const out: number[] = []
  for (const token of tokens) {
    const value = parseNumber(token)
    if (Number.isFinite(value)) out.push(value)
  }
  return out
}

export const dstvHoleSchema = z.object({
  face: faceSchema,
  /** X along the member from the start end (mm) */
  x: z.number(),
  /** Y within the face (mm) */
  y: z.number(),
  /** diameter (mm); 0 = pop mark */
  diameter: z.number(),
  /** remaining fields (slot length/width, depth, …) */
  extra: z.array(z.number()).default([]),
})
export type DstvHole = z.infer<typeof dstvHoleSchema>

export const dstvVertexSchema = z.object({
  x: z.number(),
  y: z.number(),
  /** bulge/radius to the next vertex (0 = straight) */
  radius: z.number(),
})
export type DstvVertex = z.infer<typeof dstvVertexSchema>

export const dstvContourSchema = z.object({
  kind: z.enum(['AK', 'IK']),
  face: faceSchema,
  vertices: z.array(dstvVertexSchema),
})
export type DstvContour = z.infer<typeof dstvContourSchema>

export const dstvMarkSchema = z.object({
  face: faceSchema,
  x: z.number(),
  y: z.number(),
  height: z.number().default(0),
  angle: z.number().default(0),
  text: z.string(),
})
export type DstvMark = z.infer<typeof dstvMarkSchema>

/** A DSTV notch label (`AK` extra line): corner coords + `t` (tangential) / `w` (hole-like). */
export const dstvNotchSchema = z.object({
  face: faceSchema,
  x: z.number(),
  y: z.number(),
  type: z.enum(['t', 'w']),
})
export type DstvNotch = z.infer<typeof dstvNotchSchema>

export const dstvHeaderSchema = z.object({
  orderId: z.string().optional(),
  mark: z.string(),
  grade: z.string().optional(),
  quantity: z.number().int().optional(),
  profile: z.string(),
  /** DSTV profile type code (`T`, `I`, `M`, …) */
  profileType: z.string(),
  /** overall length (mm) */
  length: z.number(),
  /** cross-section dimensions following the length */
  dimensions: z.array(z.number()),
})
export type DstvHeader = z.infer<typeof dstvHeaderSchema>

export const dstvFileSchema = z.object({
  header: dstvHeaderSchema,
  holes: z.array(dstvHoleSchema),
  contours: z.array(dstvContourSchema),
  marks: z.array(dstvMarkSchema),
  notches: z.array(dstvNotchSchema),
  blocks: z.array(z.string()),
  /**
   * Raw data lines of every block, keyed by block code (`BO`, `AK`, `PU`, `KO`, `KA`, `SC`,
   * `TO`, `UE`, `PR`, `IN`, …). Nothing in the file is dropped, even for blocks we don't yet
   * model structurally.
   */
  raw: z.record(z.string(), z.array(z.string())),
})
export type DstvFile = z.infer<typeof dstvFileSchema>

interface Block {
  code: string
  lines: string[]
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let current: Block | null = null
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    if (BLOCK_CODES.has(trimmed)) {
      current = { code: trimmed, lines: [] }
      blocks.push(current)
      continue
    }
    if (current) current.lines.push(trimmed)
    else {
      // Lines before the first block (unusual) — keep them under a synthetic ST.
      current = { code: 'ST', lines: [trimmed] }
      blocks.unshift(current)
    }
  }
  return blocks
}

function parseHeader(lines: string[]): DstvHeader {
  const tokens = lines.filter((l) => !l.startsWith('**'))
  const typeIndex = tokens.findIndex((t) => PROFILE_TYPES.has(t))
  const profileType = typeIndex >= 0 ? tokens[typeIndex] : 'SO'
  const profile = typeIndex > 0 ? tokens[typeIndex - 1] : (tokens[0] ?? '')
  const orderId = tokens[0]
  const mark = tokens.find((t, i) => i > 0 && /^[A-Za-z]+\d+$/.test(t) && !PROFILE_TYPES.has(t))
  const grade = tokens.find((t) => /^[A-Z]\d{2,3}$/.test(t))
  const gradeIndex = grade ? tokens.indexOf(grade) : -1
  const quantityToken = gradeIndex >= 0 ? tokens[gradeIndex + 1] : undefined
  const quantity = quantityToken && /^\d+$/.test(quantityToken) ? Number(quantityToken) : undefined

  const afterType = tokens.slice(typeIndex + 1).map(parseNumber)
  const numeric = afterType.filter((n) => Number.isFinite(n))
  const length = numeric[0] ?? 0
  const dimensions = numeric.slice(1)

  return dstvHeaderSchema.parse({
    orderId,
    mark: mark ?? profile,
    grade,
    quantity,
    profile,
    profileType,
    length,
    dimensions,
  })
}

function parseHoles(lines: string[]): DstvHole[] {
  const holes: DstvHole[] = []
  for (const line of lines) {
    const [faceToken, ...rest] = line.split(/\s+/)
    const face = parseFace(faceToken)
    if (!face) continue
    const nums = numbersFrom(rest)
    if (nums.length < 3) continue
    holes.push(
      dstvHoleSchema.parse({
        face,
        x: nums[0],
        y: nums[1],
        diameter: nums[2],
        extra: nums.slice(3),
      }),
    )
  }
  return holes
}

function parseContours(code: 'AK' | 'IK', lines: string[]): DstvContour[] {
  const contours: DstvContour[] = []
  let current: DstvContour | null = null
  for (const line of lines) {
    const tokens = line.split(/\s+/)
    const face = parseFace(tokens[0])
    const nums = numbersFrom(face ? tokens.slice(1) : tokens)
    if (face) {
      current = { kind: code, face, vertices: [] }
      contours.push(current)
    }
    if (!current) continue
    // Skip a DSTV notch label (`t`/`w`) — it is not a contour vertex.
    const index = face ? 1 : 0
    if (notchSuffix(tokens[index]) ?? notchSuffix(tokens[index + 1])) continue
    // One vertex per line: x, y, radius, then extra fields (bevel/angles).
    if (nums.length >= 2) {
      current.vertices.push(
        dstvVertexSchema.parse({ x: nums[0], y: nums[1], radius: nums[2] ?? 0 }),
      )
    }
  }
  return contours
}

/** Trailing notch-type letter on a coordinate token: `w` (hole-like) / `t` (tangential). */
function notchSuffix(token: string | undefined): 't' | 'w' | null {
  const match = token?.match(/([tw])$/i)
  return match ? (match[1].toLowerCase() as 't' | 'w') : null
}

/**
 * DSTV notch labels (`AK` extra lines): the corner coords carrying `t`/`w`. They are *not*
 * contour vertices, so they are collected separately rather than as duplicate points.
 */
function parseNotches(lines: string[]): DstvNotch[] {
  const notches: DstvNotch[] = []
  let face: DstvFace | null = null
  for (const line of lines) {
    const tokens = line.split(/\s+/)
    const parsedFace = parseFace(tokens[0])
    if (parsedFace) face = parsedFace
    if (!face) continue
    const index = parsedFace ? 1 : 0
    const xTok = tokens[index]
    const yTok = tokens[index + 1]
    const type = notchSuffix(xTok) ?? notchSuffix(yTok)
    if (!type) continue
    const x = parseNumber(xTok ?? '')
    const y = parseNumber(yTok ?? '')
    if (Number.isFinite(x) && Number.isFinite(y)) notches.push({ face, x, y, type })
  }
  return notches
}

function parseMarks(lines: string[]): DstvMark[] {
  const marks: DstvMark[] = []
  for (const line of lines) {
    const [faceToken, ...rest] = line.split(/\s+/)
    const face = parseFace(faceToken)
    if (!face) continue
    const nums = numbersFrom(rest)
    const text = rest.find((t) => /[A-Za-z]/.test(t) && !/^[A-Za-z]?\d/.test(t))
    if (nums.length < 2) continue
    marks.push(
      dstvMarkSchema.parse({
        face,
        x: nums[0],
        y: nums[1],
        height: nums[2] ?? 0,
        angle: nums[3] ?? 0,
        text: text ?? '',
      }),
    )
  }
  return marks
}

export function parseDstv(text: string): DstvFile {
  const blocks = splitBlocks(text)
  const byCode = new Map<string, string[]>()
  for (const block of blocks) {
    const existing = byCode.get(block.code) ?? []
    byCode.set(block.code, [...existing, ...block.lines])
  }

  const headerLines = blocks[0]?.code === 'ST' ? blocks[0].lines : []
  const holes = [...parseHoles(byCode.get('BO') ?? [])]
  const contours = [
    ...parseContours('AK', byCode.get('AK') ?? []),
    ...parseContours('IK', byCode.get('IK') ?? []),
  ]
  const marks = parseMarks(byCode.get('SI') ?? [])
  const notches = [...parseNotches(byCode.get('AK') ?? []), ...parseNotches(byCode.get('IK') ?? [])]

  const raw: Record<string, string[]> = {}
  for (const block of blocks) {
    raw[block.code] = [...(raw[block.code] ?? []), ...block.lines]
  }

  return dstvFileSchema.parse({
    header: parseHeader(headerLines),
    holes,
    contours,
    marks,
    notches,
    blocks: blocks.map((b) => b.code),
    raw,
  })
}
