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
