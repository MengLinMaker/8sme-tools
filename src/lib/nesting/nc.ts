import type { UbSection } from '@/lib/sections/types'

/**
 * EXPERIMENTAL: a Weihong-style `.nc1` describing one stock beam cut into T parts.
 *
 * Derives from the fixed-line header observed in the job NCs and lists the transverse
 * cut positions for each half (left = T bar split from the top, right = from the bottom),
 * in processing order. There is no known-good UB NC to match, so validate in WiseCAM.
 */

export interface BarNcInput {
  section: UbSection
  name: string
  stockLength: number
  left: number[]
  right: number[]
  kerf: number
  grade?: string
}

function cumulative(lengths: number[], kerf: number): number[] {
  const positions: number[] = []
  let cursor = 0
  lengths.forEach((length, index) => {
    cursor += length + (index > 0 ? kerf : 0)
    positions.push(cursor)
  })
  return positions
}

export function buildBarNc(input: BarNcInput): string {
  const { section, kerf } = input
  const grade = input.grade ?? 'C300'
  const pieces = input.left.length + input.right.length
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
    `  ${pieces}`,
    `  ${section.designation}`,
    '  I',
    `  ${input.stockLength.toFixed(2)}`,
    `  ${section.b.toFixed(2)}`,
    `  ${section.d.toFixed(2)}`,
    `  ${section.tf.toFixed(2)}`,
    `  ${section.tw.toFixed(2)}`,
    'AK',
    ...left.map((x) => `  L ${x.toFixed(2)}`),
    ...right.map((x) => `  R ${x.toFixed(2)}`),
    'EN',
  ]
  return lines.join('\r\n')
}
