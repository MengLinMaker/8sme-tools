import type { NcGeometry } from '@/lib/parsers/ncGeometry'
import type { RolledSection } from '@/lib/sections/types'
import type { BarPiece } from '@/lib/step/occ'

/**
 * EXPERIMENTAL: a Weihong-style `.nc1` describing one stock beam cut into T parts.
 *
 * Derives from the fixed-line header observed in the job NCs, then lists each part's mark
 * and its transverse cut positions per half (left = T bar split from the top, right = from
 * the bottom), in processing order. There is no known-good UB NC to match, so validate it
 * in WiseCAM before running.
 */

export interface BarNcInput {
  section: RolledSection
  name: string
  stockLength: number
  left: BarPiece[]
  right: BarPiece[]
  kerf: number
  grade?: string
}

function cumulative(pieces: BarPiece[], kerf: number): { mark: string; end: number }[] {
  const out: { mark: string; end: number }[] = []
  let cursor = 0
  pieces.forEach((piece, index) => {
    cursor += piece.length + (index > 0 ? kerf : 0)
    out.push({ mark: piece.mark, end: cursor })
  })
  return out
}

export function buildBarNc(input: BarNcInput): string {
  const { section, kerf } = input
  const grade = input.grade ?? 'C300'
  const left = cumulative(input.left, kerf)
  const right = cumulative(input.right, kerf)

  const lines = [
    'ST',
    `** ${input.name}.nc1`,
    '  CO-7255',
    `  ${input.name}`,
    `  ${input.name}`,
    '  9',
    `  ${grade}`,
    `  ${input.left.length + input.right.length}`,
    `  ${section.designation}`,
    '  I',
    `  ${input.stockLength.toFixed(2)}`,
    `  ${section.b.toFixed(2)}`,
    `  ${section.d.toFixed(2)}`,
    `  ${section.tf.toFixed(2)}`,
    `  ${section.tw.toFixed(2)}`,
    'AK',
    ...left.map((p) => `  L ${p.end.toFixed(2)} ${p.mark}`),
    ...right.map((p) => `  R ${p.end.toFixed(2)} ${p.mark}`),
    'EN',
  ]
  return lines.join('\r\n')
}

/** One nested piece's real NC geometry, at its slot along the beam. */
export interface StitchedNcPiece {
  /** Distance from the beam start to this piece's NC origin (mm). */
  start: number
  geometry: NcGeometry
}

/**
 * Merge every nested piece's real NC toolpaths into one beam geometry by shifting each piece to its
 * slot along the beam — the same placement the nested STEP stitches the parts with. Both T bars
 * (left/top and right/bottom) land on the same X range, so the result describes the whole stock UB
 * the laser cuts. Returns `null` when no piece carries geometry.
 */
export function stitchBeamGeometry(items: StitchedNcPiece[]): NcGeometry | null {
  const contours: NcGeometry['contours'] = []
  const holes: NcGeometry['holes'] = []
  const notches: NcGeometry['notches'] = []
  const marks: NcGeometry['marks'] = []
  for (const item of items) {
    for (const contour of item.geometry.contours) {
      contours.push({
        ...contour,
        points: contour.points.map(([x, y]) => [x + item.start, y] as [number, number]),
      })
    }
    for (const hole of item.geometry.holes) holes.push({ ...hole, x: hole.x + item.start })
    for (const notch of item.geometry.notches) notches.push({ ...notch, x: notch.x + item.start })
    for (const mark of item.geometry.marks) {
      marks.push({
        ...mark,
        points: mark.points.map(([x, y]) => [x + item.start, y] as [number, number]),
      })
    }
  }
  return contours.length > 0 || holes.length > 0 || marks.length > 0
    ? { contours, holes, notches, marks }
    : null
}

const mm = (value: number): string => value.toFixed(2)

/**
 * Serialise a stitched beam geometry back to DSTV `.nc1` under a whole-beam (`I`) header, so the
 * preflight NC→solid pipeline (`reconstructForViewer`) can rebuild the manufactured beam from the
 * real part toolpaths rather than an OCC boolean carve. Each contour is emitted in its own `AK`/
 * `IK` block — `parseNcGeometry` treats one block as a single contour — and only `x y radius` are
 * written (bevels are not needed for the rebuild). Returns `null` when nothing carried geometry.
 */
export function buildStitchedBeamNc(input: {
  section: RolledSection
  name: string
  stockLength: number
  items: StitchedNcPiece[]
  grade?: string
}): string | null {
  const geometry = stitchBeamGeometry(input.items)
  if (!geometry) return null
  const { section } = input
  const grade = input.grade ?? 'C300'
  const lines = [
    'ST',
    `** ${input.name}.nc1`,
    '  CO-7255',
    `  ${input.name}`,
    `  ${input.name}`,
    '  9',
    `  ${grade}`,
    '  1',
    `  ${section.designation}`,
    '  I',
    `  ${mm(input.stockLength)}`,
    `  ${mm(section.b)}`,
    `  ${mm(section.d)}`,
    `  ${mm(section.tf)}`,
    `  ${mm(section.tw)}`,
  ]
  const writeContours = (kind: 'outer' | 'inner'): void => {
    for (const contour of geometry.contours) {
      if (contour.kind !== kind) continue
      lines.push(kind === 'outer' ? 'AK' : 'IK')
      contour.points.forEach(([x, y], index) => {
        const radius = mm(contour.radii?.[index] ?? 0)
        const coords = `${mm(x)} ${mm(y)} ${radius}`
        lines.push(index === 0 ? `  ${contour.face} ${coords}` : `  ${coords}`)
      })
    }
  }
  writeContours('outer')
  writeContours('inner')
  if (geometry.holes.length > 0) {
    lines.push('BO')
    for (const hole of geometry.holes) {
      const slot = hole.slot
      if (slot && (slot.dx !== 0 || slot.dy !== 0)) {
        lines.push(
          `  ${hole.face} ${mm(hole.x)} ${mm(hole.y)} ${mm(hole.diameter)} 0.00l ${mm(slot.dx)} ${mm(slot.dy)} ${mm(slot.angle)}`,
        )
      } else {
        lines.push(`  ${hole.face} ${mm(hole.x)} ${mm(hole.y)} ${mm(hole.diameter)}`)
      }
    }
  }
  lines.push('EN')
  return lines.join('\r\n')
}
