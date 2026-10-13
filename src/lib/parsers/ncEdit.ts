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
