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
  /** Per-vertex arc bulge/radius to the next vertex (mm; `0` = straight), aligned with `points`. */
  radii?: number[]
  /** Per-vertex reference-edge / notch suffix letter (`o`/`s`/`u`/`t`/`w`), aligned with `points`. */
  refs?: (string | null)[]
}

/**
 * A DSTV slotted hole (`BO` line with fabrication letter `l`). The cut is an **obround**
 * (stadium): two end semicircles of radius `diameter / 2`, centred at the hole's start point
 * `(x, y)` and at the far end. The DSTV `width`/`height` fields (`dx`/`dy`) are the slot vector
 * *before* rotation; `angle` (deg, counter-clockwise) rotates it to the slot's true direction — so
 * an axis-aligned slot leaves the sum as `dx`/`dy`, while `0.00l 0.00 10.00 69.95` is a 10 mm
 * end-to-end slot tilted ~20° off the face's Y axis. The start point is an end centre, not the
 * slot centre. Use {@link slotOffset} to get the far end, not `dx`/`dy` directly.
 */
export interface NcSlot {
  /** Slot vector X (mm) from the start point before the `angle` rotation; DSTV "width" field. */
  dx: number
  /** Slot vector Y (mm) from the start point before the `angle` rotation; DSTV "height" field. */
  dy: number
  /** Counter-clockwise rotation (deg) applied to `(dx, dy)` to give the slot's true direction. */
  angle: number
}

/**
 * The slotted hole's far-end offset from its start point, in face coordinates (mm): the DSTV
 * `(dx, dy)` vector rotated counter-clockwise by the slot's `angle`. This is the vector the slot
 * actually runs along — the raw `dx`/`dy` alone drop the tilt and must not be used directly.
 */
export function slotOffset(slot: NcSlot): [number, number] {
  const rad = (slot.angle * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return [slot.dx * cos - slot.dy * sin, slot.dx * sin + slot.dy * cos]
}

export interface NcHole {
  face: NcFace
  x: number
  y: number
  diameter: number
  /** Set when the `BO` line is a slotted (`l`) hole; plain drilled holes leave it undefined. */
  slot?: NcSlot
}

/**
 * A DSTV **notch** instruction (`AK` block). Per the DSTV spec a notched corner adds an extra
 * line that is *not* part of the contour: the corner coordinates plus the notch type — `t`
 * (tangential) or `w` (hole-like). It is easy to mistake for a duplicate contour vertex, so it
 * is separated out here.
 */
export interface NcNotch {
  face: NcFace
  /** corner X along the member (mm) */
  x: number
  /** corner Y within the face (mm) */
  y: number
  /** `t` = tangential notch, `w` = hole-like notch */
  type: 't' | 'w'
}

/** `SI` numbering/marking text: the etch that identifies the piece. */
export interface NcMarkText {
  /** The text to etch (e.g. the part mark). */
  value: string
  /** Text height (mm); `0` when the NC omits it. */
  height: number
  /** Text rotation in the face plane (deg, counter-clockwise); `0` when omitted. */
  angle: number
}

/**
 * A non-cutting layout mark. `PU` (powder/scribe) and `KO` (centre/punch) hold polylines that
 * follow the mark on the surface; `SI` holds etch text at a single point.
 */
export interface NcMark {
  face: NcFace
  /** `etch` = `SI` text, `marking` = `PU`/`KO` scribe lines. */
  kind: 'etch' | 'marking'
  /** Scribe polyline in face coordinates (a single point for `SI` text). */
  points: [number, number][]
  /** Present for `SI` text marks. */
  text?: NcMarkText
}

export interface NcGeometry {
  contours: NcContour[]
  holes: NcHole[]
  notches: NcNotch[]
  marks: NcMark[]
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

/**
 * The trailing letter on a coordinate token. Reference-edge suffixes are `o` (top) / `s` (axis) /
 * `u` (bottom); notch types are `t` (tangential) / `w` (hole-like). Null when there is no letter.
 */
function coordSuffix(token: string | undefined): 'o' | 's' | 'u' | 't' | 'w' | null {
  const match = token?.match(/([a-z])$/i)
  return match ? (match[1].toLowerCase() as 'o' | 's' | 'u' | 't' | 'w') : null
}

export function parseNcGeometry(text: string): NcGeometry {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const contours: NcContour[] = []
  const holes: NcHole[] = []
  const notches: NcNotch[] = []
  const marks: NcMark[] = []

  let block = ''
  let face: NcFace | null = null
  let current: [number, number][] = []
  let currentBevels: number[][] = []
  let currentRadii: number[] = []
  let currentRefs: (string | null)[] = []
  let currentMark: { face: NcFace; kind: 'marking'; points: [number, number][] } | null = null

  const flushMark = () => {
    if (currentMark && currentMark.points.length >= 2) {
      marks.push({ face: currentMark.face, kind: currentMark.kind, points: currentMark.points })
    }
    currentMark = null
  }

  const flush = () => {
    if ((block === 'AK' || block === 'IK') && face && current.length >= 2) {
      contours.push({
        face,
        kind: block === 'IK' ? 'inner' : 'outer',
        points: current,
        bevels: currentBevels,
        radii: currentRadii,
        refs: currentRefs,
      })
    }
    flushMark()
    current = []
    currentBevels = []
    currentRadii = []
    currentRefs = []
  }

  for (const line of lines) {
    if (line === '') continue
    if (BLOCK_CODES.has(line)) {
      flush()
      block = line
      face = null
      continue
    }
    if (block !== 'AK' && block !== 'IK' && block !== 'BO' && block !== 'SI' && block !== 'PU' && block !== 'KO') continue

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

    if (block === 'SI') {
      // DSTV order: `face X Y angle height text` (the angle precedes the text height).
      const angle = num(tokens[index + 2])
      const height = num(tokens[index + 3])
      const value = tokens
        .slice(index + 4)
        .join(' ')
        .replace(/\s+$/, '')
      marks.push({
        face,
        kind: 'etch',
        points: [[x, y]],
        text: {
          value,
          height: Number.isFinite(height) ? height : 0,
          angle: Number.isFinite(angle) ? angle : 0,
        },
      })
      continue
    }
    if (block === 'PU' || block === 'KO') {
      if (!currentMark || currentMark.face !== face) {
        flushMark()
        currentMark = { face, kind: 'marking', points: [] }
      }
      currentMark.points.push([x, y])
      continue
    }

    if (block === 'BO') {
      const diameter = num(tokens[index + 2])
      const hole: NcHole = { face, x, y, diameter: Number.isFinite(diameter) ? diameter : 0 }
      // The field after the diameter is `ttt.tt` carrying a fabrication letter: `l` = slotted/
      // oblong hole, `g` = thread, `m` = mark, `s` = counterbore; a blank = full (plain) hole.
      // Only `l` appends the slot's width, height and angle.
      const type = tokens[index + 3]?.match(/([a-z])$/i)?.[1]?.toLowerCase()
      if (type === 'l') {
        const dx = num(tokens[index + 4])
        const dy = num(tokens[index + 5])
        const angle = num(tokens[index + 6])
        hole.slot = {
          dx: Number.isFinite(dx) ? dx : 0,
          dy: Number.isFinite(dy) ? dy : 0,
          angle: Number.isFinite(angle) ? angle : 0,
        }
      }
      holes.push(hole)
      continue
    }
    // A notched corner adds an extra `AK` line — the corner coords carrying `t`/`w` — that is not
    // a contour vertex. Record it separately instead of letting it collapse as a duplicate point.
    const suffix = coordSuffix(tokens[index]) ?? coordSuffix(tokens[index + 1])
    if (suffix === 't' || suffix === 'w') {
      notches.push({ face, x, y, type: suffix })
      continue
    }
    current.push([x, y])
    currentRadii.push(num(tokens[index + 2]))
    currentRefs.push(coordSuffix(tokens[index]) ?? coordSuffix(tokens[index + 1]))
    // Welding-preparation / bevel pairs (two angle/distance values) AFTER the radius at
    // `index + 2`: the radius is a corner blend, not a bevel, so it must not count.
    const bevel: number[] = []
    for (let i = index + 3; i <= index + 6; i++) {
      const value = num(tokens[i])
      bevel.push(Number.isFinite(value) ? value : 0)
    }
    currentBevels.push(bevel)
  }
  flush()

  return { contours, holes, notches, marks }
}
