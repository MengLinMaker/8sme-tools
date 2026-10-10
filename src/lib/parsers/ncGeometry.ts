/**
 * Minimal DSTV NC (`.nc1`) geometry reader.
 *
 * Reads the `AK`/`IK` (outer/inner contours) and `BO` (holes) blocks so a part can be
 * drawn from its NC even when its STEP is wrong. Coordinates are per face: X runs along
 * the member, Y is within the face (`v` front/web, `o` top, `u` bottom, `h` rear).
 */

export type NcFace = 'v' | 'o' | 'u' | 'h'

export interface NcContour {
  face: NcFace
  kind: 'outer' | 'inner'
  points: [number, number][]
  /**
   * Per-vertex extra fields after `X Y R`, aligned with `points`. These are the DSTV
   * welding-preparation / bevel pairs — up to two `angle, distance` values (`0` = none).
   */
  bevels: number[][]
}

export interface NcHole {
  face: NcFace
  x: number
  y: number
  diameter: number
}

export interface NcGeometry {
  contours: NcContour[]
  holes: NcHole[]
}

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

/** `0.00`, `0.00u`, `124.38s` → the numeric part. */
function num(token: string | undefined): number {
  if (token == null) return Number.NaN
  const match = token.match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : Number.NaN
}

export function parseNcGeometry(text: string): NcGeometry {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const contours: NcContour[] = []
  const holes: NcHole[] = []

  let block = ''
  let face: NcFace | null = null
  let current: [number, number][] = []
  let currentBevels: number[][] = []

  const flush = () => {
    if ((block === 'AK' || block === 'IK') && face && current.length >= 2) {
      contours.push({
        face,
        kind: block === 'IK' ? 'inner' : 'outer',
        points: current,
        bevels: currentBevels,
      })
    }
    current = []
    currentBevels = []
  }

  for (const line of lines) {
    if (line === '') continue
    if (BLOCK_CODES.has(line)) {
      flush()
      block = line
      face = null
      continue
    }
    if (block !== 'AK' && block !== 'IK' && block !== 'BO') continue

    const tokens = line.split(/\s+/)
    let index = 0
    if (FACE.test(tokens[0])) {
      face = tokens[0] as NcFace
      index = 1
    }
    if (!face) continue

    const x = num(tokens[index])
    const y = num(tokens[index + 1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue

    if (block === 'BO') {
      const diameter = num(tokens[index + 2])
      holes.push({ face, x, y, diameter: Number.isFinite(diameter) ? diameter : 0 })
    } else {
      current.push([x, y])
      // R then up to four welding-preparation values (two angle/distance pairs).
      const bevel: number[] = []
      for (let i = index + 2; i <= index + 5; i++) {
        const value = num(tokens[i])
        bevel.push(Number.isFinite(value) ? value : 0)
      }
      currentBevels.push(bevel)
    }
  }
  flush()

  return { contours, holes }
}
