import { MACHINE } from '@/lib/machine/profile'
import type { NcFace } from './ncGeometry'

/**
 * Minimal, surgical DSTV NC (`.nc1`) text editing — enough to **remove a cut** a check flagged
 * without disturbing the rest of the file. The NC is line-oriented, so the editor works on lines
 * and leaves every untouched line byte-for-byte: only the offending `AK`/`IK` block (or hole line)
 * is dropped, or the flagged run's vertices are deleted from its block.
 *
 * Contour vertices are matched in exactly the order {@link parseNcGeometry} reads them, so a
 * `contourIndex` from the geometry reader is valid here too.
 */

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
])
const FACE = /^[vouh]$/
/** The head's bevel range; values outside it are not weld prep (see `bevelChange.ts`). */
const MAX_BEVEL_DEG = Math.max(Math.abs(MACHINE.bevel.minDeg), Math.abs(MACHINE.bevel.maxDeg))

const num = (token: string | undefined): number => {
  const match = token?.match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : Number.NaN
}

interface VertexLine {
  /** Source line index in the split file. */
  line: number
  point: [number, number]
}

interface ContourBlock {
  kind: 'outer' | 'inner'
  face: NcFace
  /** Source line index of the `AK`/`IK` code. */
  codeLine: number
  /** Source line indices of every vertex data line, in order. */
  vertices: VertexLine[]
  /** Last source line index belonging to this block (inclusive). */
  lastLine: number
}

/**
 * Reads the contour blocks with their source-line positions. Mirrors `parseNcGeometry`'s flush
 * rules (face set, ≥2 points, notches skipped), so its ordering matches `NcGeometry.contours`.
 */
function readContourBlocks(text: string): ContourBlock[] {
  const lines = text.split(/\r?\n/)
  const blocks: ContourBlock[] = []
  let block = ''
  let blockLine = -1
  let face: NcFace | null = null
  let vertices: VertexLine[] = []
  let firstVertexLine = -1
  let lastDataLine = -1

  const flush = () => {
    if ((block === 'AK' || block === 'IK') && face && vertices.length >= 2) {
      blocks.push({
        kind: block === 'IK' ? 'inner' : 'outer',
        face,
        codeLine: blockLine,
        vertices,
        lastLine: lastDataLine,
      })
    }
    vertices = []
    face = null
    firstVertexLine = -1
    lastDataLine = -1
  }

  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line === '') return
    if (BLOCK_CODES.has(line)) {
      flush()
      block = line
      blockLine = index
      return
    }
    if (block !== 'AK' && block !== 'IK') return
    const tokens = line.split(/\s+/)
    let i = 0
    if (FACE.test(tokens[0] as string)) {
      face = tokens[0] as NcFace
      i = 1
    }
    if (!face) return
    const x = num(tokens[i])
    const y = num(tokens[i + 1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    // A notched-corner `t`/`w` label is not a contour vertex (see `parseNcGeometry`).
    const suffix = (tokens[i] ?? '').match(/([a-z])$/i)?.[1]?.toLowerCase()
    const suffix2 = (tokens[i + 1] ?? '').match(/([a-z])$/i)?.[1]?.toLowerCase()
    if (suffix === 't' || suffix === 'w' || suffix2 === 't' || suffix2 === 'w') return
    if (firstVertexLine < 0) firstVertexLine = index
    vertices.push({ line: index, point: [x, y] })
    lastDataLine = index
  })
  flush()

  return blocks
}

export interface RemoveCutTarget {
  /** Index of the contour in `parseNcGeometry(...).contours`. */
  contourIndex: number
  /**
   * Inclusive vertex-index range to delete (a flagged run), or `null` to drop the whole block.
   * Indices are into the contour's own `points` order.
   */
  removeVertices: [number, number] | null
}

/**
 * Removes a flagged cut from an NC file's text, returning the edited text, or the original when
 * the target can't be removed cleanly (the caller then leaves the file untouched).
 *
 *   - whole contour (`removeVertices: null`): drops the `AK`/`IK` block.
 *   - a run: deletes the run's vertices and lets its neighbours connect; the block's first vertex
 *     and its closing duplicate are always kept, so the face token and closure are preserved.
 */
export function removeCutFromNc(ncText: string, target: RemoveCutTarget): string {
  const lines = ncText.split(/\r?\n/)
  const blocks = readContourBlocks(ncText)
  const block = blocks[target.contourIndex]
  if (!block) return ncText

  const drop = new Set<number>()
  if (target.removeVertices == null) {
    for (let index = block.codeLine; index <= block.lastLine; index++) drop.add(index)
    return lines.filter((_, index) => !drop.has(index)).join('\n')
  }

  const [first, last] = target.removeVertices
  const count = block.vertices.length
  if (first <= 0 || last >= count - 1) {
    // The run touches the block's anchor vertices (the face-token first vertex, or the closing
    // duplicate). Deleting it would break the block's header/closure — leave the file alone.
    return ncText
  }
  for (let index = first; index <= last; index++) {
    const vertex = block.vertices[index]
    if (vertex) drop.add(vertex.line)
  }

  const remaining = block.vertices.filter((vertex) => !drop.has(vertex.line))
  if (remaining.length < 2) {
    for (let index = block.codeLine; index <= block.lastLine; index++) drop.add(index)
  }
  return lines.filter((_, index) => !drop.has(index)).join('\n')
}

export interface RemoveHoleTarget {
  face: NcFace
  x: number
  y: number
  /** Hole diameter, to disambiguate two holes at the same point (rare). */
  diameter?: number
}

/** Removes a `BO` hole line from an NC file's text (a flagged stray hole), or returns the original. */
export function removeNcHole(ncText: string, target: RemoveHoleTarget): string {
  const lines = ncText.split(/\r?\n/)
  let block = ''
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? '').trim()
    if (line === '') continue
    if (BLOCK_CODES.has(line)) {
      block = line
      continue
    }
    if (block !== 'BO') continue
    const tokens = line.split(/\s+/)
    let i = 0
    if (FACE.test(tokens[0] as string)) i = 1
    const face = tokens[0] as NcFace
    const x = num(tokens[i])
    const y = num(tokens[i + 1])
    const diameter = num(tokens[i + 2])
    if (face !== target.face) continue
    if (Math.hypot(x - target.x, y - target.y) > 0.01) continue
    if (target.diameter != null && Math.abs(diameter - target.diameter) > 0.01) continue
    return lines.filter((_, kept) => kept !== index).join('\n')
  }
  return ncText
}

export interface SetBevelTarget {
  /** Index of the contour in `parseNcGeometry(...).contours`. */
  contourIndex: number
  /** Contour vertex indices (into `points`/`bevels`) whose bevel should be unified. */
  vertices: number[]
  /** Bevel angle (deg) to apply; `0` removes the bevel from the line. */
  angle: number
}

/**
 * Replaces the numeric tokens at the given token indices of a raw line, preserving the surrounding
 * whitespace and right-aligning each replacement to at least the width it replaced. DSTV is a
 * fixed-column format, so leaving every other byte and space untouched keeps the block readable.
 */
function replaceTokens(raw: string, replacements: Map<number, string>): string {
  const tokens = [...raw.matchAll(/\S+/g)]
  let out = ''
  let last = 0
  tokens.forEach((match, index) => {
    const start = match.index ?? 0
    const text = match[0]
    out += raw.slice(last, start)
    const replacement = replacements.get(index)
    out +=
      replacement == null ? text : replacement.padStart(Math.max(text.length, replacement.length))
    last = start + text.length
  })
  return out + raw.slice(last)
}

/**
 * Unifies the bevel on a flagged cut line: **every vertex on the line** is set to one angle — square
 * portions included — so the head never has to change tilt mid-cut; with `angle: 0` the bevel is
 * removed entirely. The prep is written on the side of the plate the line already uses, carrying
 * that side's distance onto vertices that were square. The opposite-side prep is cleared so
 * `selectWeldingPrep` cannot pick a different angle there. Only the bevel `angle`/`distance` fields
 * change, so every other field and all whitespace is preserved.
 *
 * `vertices` come from the same contour the geometry reader used, so they line up with the block's
 * data lines. An out-of-range contour index leaves the file untouched.
 */
export function setBevelInNc(ncText: string, target: SetBevelTarget): string {
  const lines = ncText.split(/\r?\n/)
  const blocks = readContourBlocks(ncText)
  const block = blocks[target.contourIndex]
  if (!block) return ncText
  const wanted = new Set(target.vertices)
  const rows: { line: number; raw: string; tokens: RegExpMatchArray[]; offset: number }[] = []
  for (let index = 0; index < block.vertices.length; index++) {
    if (!wanted.has(index)) continue
    const vertex = block.vertices[index]
    const raw = vertex ? lines[vertex.line] : undefined
    if (raw == null) continue
    const tokens = [...raw.matchAll(/\S+/g)]
    const first = tokens[0]?.[0]
    rows.push({ line: vertex.line, raw, tokens, offset: first && FACE.test(first) ? 1 : 0 })
  }
  // Angle fields are the 1st and 3rd values after the radius (`offset+3`, `offset+5`); their
  // distances follow (`offset+4`, `offset+6`). Values outside the head's range are not weld prep.
  // Pick the plate side the line already mostly uses, and the distance it carries.
  const sideCount = [0, 0]
  const sideDistance: number[][] = [[], []]
  for (const row of rows) {
    for (const side of [0, 1] as const) {
      const angleSlot = row.offset + 3 + 2 * side
      const current = num(row.tokens[angleSlot]?.[0])
      if (!Number.isFinite(current) || current === 0 || Math.abs(current) > MAX_BEVEL_DEG) continue
      sideCount[side] = (sideCount[side] ?? 0) + 1
      const distance = num(row.tokens[angleSlot + 1]?.[0])
      if (distance > 0) sideDistance[side]?.push(distance)
    }
  }
  const side = (sideCount[1] ?? 0) > (sideCount[0] ?? 0) ? 1 : 0
  const distanceCounts = new Map<number, number>()
  for (const distance of sideDistance[side] ?? []) {
    distanceCounts.set(distance, (distanceCounts.get(distance) ?? 0) + 1)
  }
  let dominantDistance = 0
  let dominantCount = 0
  for (const [distance, count] of distanceCounts) {
    if (count > dominantCount) {
      dominantCount = count
      dominantDistance = distance
    }
  }

  for (const row of rows) {
    const replacements = new Map<number, string>()
    if (target.angle === 0) {
      for (const slot of [row.offset + 3, row.offset + 5]) replacements.set(slot, '0.00')
      for (const slot of [row.offset + 4, row.offset + 6]) {
        if (row.tokens[slot]) replacements.set(slot, '0.00')
      }
    } else {
      const angleSlot = row.offset + 3 + 2 * side
      const distanceSlot = angleSlot + 1
      replacements.set(angleSlot, target.angle.toFixed(2))
      const currentDistance = num(row.tokens[distanceSlot]?.[0])
      const distance = currentDistance > 0 ? currentDistance : dominantDistance
      if (distance > 0) replacements.set(distanceSlot, distance.toFixed(2))
      // Clear the other plate side so the chosen angle is the only prep on this vertex.
      const otherAngleSlot = row.offset + 3 + 2 * (1 - side)
      const other = num(row.tokens[otherAngleSlot]?.[0])
      if (Number.isFinite(other) && other !== 0 && Math.abs(other) <= MAX_BEVEL_DEG) {
        replacements.set(otherAngleSlot, '0.00')
        replacements.set(otherAngleSlot + 1, '0.00')
      }
    }
    lines[row.line] = replaceTokens(row.raw, replacements)
  }
  return lines.join('\n')
}

/**
 * Changes only the out-of-range welding prep on one vertex: its angle is set to `angle` (in range), or
 * the couple is deleted when `angle` is 0. In-range couples on the same vertex are left untouched.
 */
export function setOutOfRangeBevelInNc(
  ncText: string,
  target: { contourIndex: number; vertex: number; angle: number },
): string {
  const lines = ncText.split(/\r?\n/)
  const block = readContourBlocks(ncText)[target.contourIndex]
  const vertex = block?.vertices[target.vertex]
  const raw = vertex ? lines[vertex.line] : undefined
  if (raw == null) return ncText
  const tokens = [...raw.matchAll(/\S+/g)]
  const first = tokens[0]?.[0]
  const offset = first && FACE.test(first) ? 1 : 0
  const replacements = new Map<number, string>()
  for (const [angleSlot, distanceSlot] of [
    [offset + 3, offset + 4],
    [offset + 5, offset + 6],
  ] as const) {
    const current = num(tokens[angleSlot]?.[0])
    if (!Number.isFinite(current) || Math.abs(current) <= MAX_BEVEL_DEG) continue
    if (target.angle === 0) {
      replacements.set(angleSlot, '0.00')
      replacements.set(distanceSlot, '0.00')
    } else {
      replacements.set(angleSlot, target.angle.toFixed(2))
    }
  }
  if (replacements.size === 0) return ncText
  lines[vertex?.line ?? 0] = replaceTokens(raw, replacements)
  return lines.join('\n')
}
