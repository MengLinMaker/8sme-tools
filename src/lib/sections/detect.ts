import { angleDesignation, EQUAL_ANGLES, UNEQUAL_ANGLES } from './angle'
import { PFC_SECTIONS } from './pfc'
import { partSectionForCode, sectionMassPerMetre } from './stock'
import { TFB_SECTIONS } from './tfb'
import { UB_SECTIONS } from './ub'
import { UC_SECTIONS } from './uc'

/**
 * Infers the **stocked section** a part is cut from, purely from its measured cross-section.
 *
 * This is the STEP-only fallback: when a job ships no NC and no drawings, preflight has no
 * profile code to read, so the section is recovered from the real geometry. The cross-section is
 * extracted by the OCC worker ({@link file://./../step/readSection.ts}) as an outer outline plus
 * any enclosed voids, handed here, and matched against every family we stock:
 *
 *  - Universal Beams (UB), Universal Columns (UC) and Taper Flange Beams (TFB) — I-sections;
 *  - Parallel Flange Channels (PFC) — channels;
 *  - equal/unequal angles (EA/UA) — L-sections;
 *  - T sections — a UB split lengthwise (mapped back to its parent UB);
 *  - rectangular/square/circular hollows (RHS/SHS/CHS) — reconstructed from the wall.
 *
 * **Why shape matching, not just dimensions.** A `200UB29.8` (207 × 134) and a `460UB82.1`
 * (460 × 191) differ by size, but a T from a `150UB14.0` (75 × 75, area ≈ 865 mm²) is nearly the
 * same bounding box *and* area as an `EA75*75*6` (75 × 75, ≈ 864 mm²). Dimensions and area alone
 * cannot tell an L from a T, so each candidate is rasterised to a normalised occupancy grid and
 * compared by intersection-over-union over the eight square symmetries.
 */

/** A measured cross-section: the outer outline plus any enclosed voids (holes / hollow). */
export interface MeasuredSection {
  outer: [number, number][]
  holes?: [number, number][][]
}

/** The section a part is inferred to be cut from. */
export interface SectionGuess {
  /** family key, e.g. `ub`, `tee`, `rhs` */
  family: string
  /** a code accepted by `stockOutlineForCode` / `partSectionForCode` (drives the stock ghost) */
  code: string
  /** extra dims for the code (NC header order), where the code alone is not enough */
  dims: number[]
  /** friendly display label, e.g. `200UB29.8` or `RHS150*100*9.0` (the drawing callout) */
  label: string
  /** nominal mass per metre (kg/m), where known */
  mass: number | null
  /** match confidence 0..1 (grid IoU); 1 = pixel-identical */
  score: number
  /**
   * The **real** cross-section the match came from. Its outline is the true part, so a STEP-only
   * ghost drawn from it sits flush — but it is only trustworthy because `code` matched a known
   * section (the caller gates on `score`). Absent when the outline was not available.
   */
  outline?: MeasuredSection
}

const GRID = 32
/** Dimension match: within `max(2.5mm, 5%)` on both cross extents. */
const DIM_ABS_TOL = 2.5
const DIM_REL_TOL = 0.05
/** Minimum grid IoU to accept a solid-profile match. */
const MIN_IOU = 0.7
/**
 * Rank weights for surviving candidates. The grid is coarse (32²) so the IoU of two mass variants
 * of one section is quantised — a `200UB22.3` and `200UB25.4` (7.0 vs 7.8 flange) can both rasterise
 * to IoU ≈ 1, and aliasing can even rank the thinner section higher. The measured **area**, by
 * contrast, resolves the flange/web thickness directly, so it carries the deciding weight; the IoU
 * stays as the shape/family gate (via `MIN_IOU`) rather than the tie-breaker.
 */
const AREA_WEIGHT = 1.0
const DIM_WEIGHT = 0.1
/** A hole counts as a hollow void (not a drilled feature) when it is this concentric + large. */
const VOID_AREA_FRACTION = 0.15
const VOID_CENTRE_TOL = 6

interface Bbox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function bbox(points: [number, number][]): Bbox {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

function polygonArea(points: [number, number][]): number {
  let twice = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    twice += points[j][0] * points[i][1] - points[i][0] * points[j][1]
  }
  return Math.abs(twice) / 2
}

function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Rasterises an outline (minus voids) into a `GRID²` occupancy, normalised to its own bbox. */
function rasterize(outer: [number, number][], holes: [number, number][][] = []): Uint8Array {
  const { minX, minY, maxX, maxY } = bbox(outer)
  const w = maxX - minX || 1
  const h = maxY - minY || 1
  const sx = GRID / w
  const sy = GRID / h
  const to = ([x, y]: [number, number]): [number, number] => [(x - minX) * sx, (y - minY) * sy]
  const o = outer.map(to)
  const hs = holes.map((hole) => hole.map(to))
  const cells = new Uint8Array(GRID * GRID)
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = i + 0.5
      const y = j + 0.5
      if (!pointInPolygon(x, y, o)) continue
      if (hs.some((hole) => pointInPolygon(x, y, hole))) continue
      cells[j * GRID + i] = 1
    }
  }
  return cells
}

/** The eight square symmetries as index maps `(i,j) → (i',j')`. */
const SYMMETRIES: ((i: number, j: number) => [number, number])[] = (() => {
  const last = GRID - 1
  const quarter: ((i: number, j: number) => [number, number])[] = [
    (i, j) => [i, j],
    (i, j) => [j, last - i],
    (i, j) => [last - i, last - j],
    (i, j) => [last - j, i],
  ]
  const mirrored = quarter.map((turn) => (i: number, j: number) => turn(j, i))
  return [...quarter, ...mirrored]
})()

/** Best intersection-over-union of two occupancy grids over the eight symmetries. */
function gridIou(a: Uint8Array, b: Uint8Array): number {
  let best = 0
  for (const turn of SYMMETRIES) {
    let inter = 0
    let union = 0
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const [ti, tj] = turn(i, j)
        const av = a[j * GRID + i]
        const bv = b[tj * GRID + ti]
        if (av || bv) {
          union++
          if (av && bv) inter++
        }
      }
    }
    if (union > 0) best = Math.max(best, inter / union)
  }
  return best
}

interface Candidate {
  family: string
  code: string
  dims: number[]
  label: string
  mass: number | null
  cells: Uint8Array
  /** sorted descending cross extents */
  extents: [number, number]
  area: number
}

function makeCandidate(
  family: string,
  code: string,
  dims: number[],
  label: string,
  mass: number | null,
): Candidate | null {
  const section = partSectionForCode(code, dims)
  if (!section) return null
  const { minX, minY, maxX, maxY } = bbox(section.points)
  const size = [maxX - minX, maxY - minY] as [number, number]
  const extents: [number, number] = size[0] >= size[1] ? [size[0], size[1]] : [size[1], size[0]]
  let area = polygonArea(section.points)
  for (const hole of section.holes ?? []) area -= polygonArea(hole)
  return {
    family,
    code,
    dims,
    label,
    mass,
    cells: rasterize(section.points, section.holes ?? []),
    extents,
    area,
  }
}

/** Every stocked solid-profile section, built once. */
let candidateCache: Candidate[] | null = null
function candidates(): Candidate[] {
  if (candidateCache) return candidateCache
  const out: Candidate[] = []
  const push = (candidate: Candidate | null): void => {
    if (candidate) out.push(candidate)
  }
  for (const section of UB_SECTIONS) {
    push(makeCandidate('ub', section.designation, [], section.designation, section.mass))
    push(
      makeCandidate(
        'tee',
        'BT',
        [section.b, section.d / 2, section.tf, section.tw, section.r ?? 0],
        `${section.designation} (T)`,
        section.mass / 2,
      ),
    )
  }
  for (const section of UC_SECTIONS) {
    push(makeCandidate('uc', section.designation, [], section.designation, section.mass))
  }
  for (const section of TFB_SECTIONS) {
    // Drawing callout, no space: `125TFB`.
    const callout = `${section.d}TFB`
    push(makeCandidate('tfb', callout, [], callout, section.mass))
  }
  for (const section of PFC_SECTIONS) {
    // Drawing callout, depth × flange: `PFC100*50`.
    const callout = `PFC${section.d}*${section.b}`
    push(makeCandidate('pfc', callout, [], callout, section.mass))
  }
  for (const angle of [...EQUAL_ANGLES, ...UNEQUAL_ANGLES]) {
    push(
      makeCandidate(
        'angle',
        angleDesignation(angle),
        [angle.a, angle.b, angle.t, angle.r1, angle.r2],
        angleDesignation(angle),
        angle.mass,
      ),
    )
  }
  candidateCache = out
  return out
}

/** The concentric, large void that marks a hollow (rather than a drilled hole). */
function hollowVoid(measured: MeasuredSection, outerArea: number): [number, number][] | null {
  const outerBox = bbox(measured.outer)
  const ocx = (outerBox.minX + outerBox.maxX) / 2
  const ocy = (outerBox.minY + outerBox.maxY) / 2
  for (const hole of measured.holes ?? []) {
    const box = bbox(hole)
    const area = polygonArea(hole)
    if (area < outerArea * VOID_AREA_FRACTION) continue
    const cx = (box.minX + box.maxX) / 2
    const cy = (box.minY + box.maxY) / 2
    if (Math.hypot(cx - ocx, cy - ocy) > VOID_CENTRE_TOL) continue
    return hole
  }
  return null
}

/** Rounds to 0.1 mm — the sampled geometry carries ~1e-9 noise that must not reach a callout. */
function round01(value: number): number {
  return Math.round(value * 10) / 10
}

/** A section dimension as a callout writes it: whole mm when possible (`89`), else `88.9`. */
function dimText(value: number): string {
  return String(round01(value))
}

/** The nominal wall in a callout always carries one decimal: `6.0`, `9.0`, `5.0`. */
function wallText(value: number): string {
  return value.toFixed(1)
}

/** Reconstructs a hollow callout (RHS/SHS/CHS) from the outer size and the concentric void. */
function detectHollow(measured: MeasuredSection, outerArea: number): SectionGuess | null {
  const void_ = hollowVoid(measured, outerArea)
  if (!void_) return null
  const outerBox = bbox(measured.outer)
  const ow = outerBox.maxX - outerBox.minX
  const oh = outerBox.maxY - outerBox.minY
  const long = round01(Math.max(ow, oh))
  const short = round01(Math.min(ow, oh))
  const voidBox = bbox(void_)
  const vw = voidBox.maxX - voidBox.minX
  const vh = voidBox.maxY - voidBox.minY
  const wall = round01((ow - vw + (oh - vh)) / 4)
  if (!(long > 0) || !(short > 0) || !(wall > 0)) return null

  // A circle fills ~π/4 of its bounding box; a rounded square is a little fuller.
  const circular = Math.abs(ow - oh) < DIM_ABS_TOL && outerArea / (ow * oh) < 0.8
  const t = wallText(wall)
  // The callout as the drawings write it: `SHS89*89*5.0`, `RHS150*100*9.0`, `CHS88.9*5.0`.
  let code: string
  let family: string
  if (circular) {
    family = 'chs'
    code = `CHS${dimText(long)}*${t}`
  } else if (long - short <= Math.max(DIM_ABS_TOL, long * DIM_REL_TOL)) {
    family = 'shs'
    code = `SHS${dimText(long)}*${dimText(short)}*${t}`
  } else {
    family = 'rhs'
    code = `RHS${dimText(long)}*${dimText(short)}*${t}`
  }
  return {
    family,
    code,
    dims: [],
    label: code,
    mass: sectionMassPerMetre(code, []),
    score: 1,
  }
}

/**
 * Infers the stocked section from a measured cross-section. Hollows are reconstructed from the
 * outer size and wall; solid profiles are matched against every catalogued I/channel/angle/T
 * section by dimensions (within tolerance) and normalised shape (grid IoU).
 */
export function inferSectionFromCross(measured: MeasuredSection): SectionGuess | null {
  if (measured.outer.length < 3) return null
  const outerArea = polygonArea(measured.outer)

  const hollow = detectHollow(measured, outerArea)
  if (hollow) return { ...hollow, outline: measured }

  const measuredCells = rasterize(measured.outer, [])
  const outerBox = bbox(measured.outer)
  const mw = outerBox.maxX - outerBox.minX
  const mh = outerBox.maxY - outerBox.minY
  const extents: [number, number] = mw >= mh ? [mw, mh] : [mh, mw]

  let best: SectionGuess | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const candidate of candidates()) {
    const [cl, cs] = candidate.extents
    const tolL = Math.max(DIM_ABS_TOL, cl * DIM_REL_TOL)
    const tolS = Math.max(DIM_ABS_TOL, cs * DIM_REL_TOL)
    if (Math.abs(extents[0] - cl) > tolL || Math.abs(extents[1] - cs) > tolS) continue

    const areaPenalty = Math.abs(outerArea - candidate.area) / Math.max(candidate.area, 1)
    if (areaPenalty > 0.25) continue

    const iou = gridIou(measuredCells, candidate.cells)
    if (iou < MIN_IOU) continue
    const dimPenalty = Math.abs(extents[0] - cl) / tolL + Math.abs(extents[1] - cs) / tolS
    const composite = iou - DIM_WEIGHT * dimPenalty - AREA_WEIGHT * areaPenalty
    if (composite > bestScore) {
      bestScore = composite
      best = {
        family: candidate.family,
        code: candidate.code,
        dims: candidate.dims,
        label: candidate.label,
        mass: candidate.mass,
        score: iou,
      }
    }
  }
  return best ? { ...best, outline: measured } : null
}
