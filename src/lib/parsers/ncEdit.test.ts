import { describe, expect, it } from 'vitest'
import { removeCutFromNc, removeNcHole, setBevelInNc } from './ncEdit'
import { parseNcGeometry } from './ncGeometry'

function row(head: string, x: number, y: number): string {
  const pad = (value: number) => value.toFixed(2).padStart(12)
  return `${head}${pad(x)}${pad(y)}${pad(0)}${pad(0).padStart(12)}${pad(0).padStart(12)}${pad(0)}${pad(0)}`
}

/** One `AK` row carrying a bevel: `X Y R angle distance 0 0`. */
function bevRow(head: string, x: number, y: number, angle = 0): string {
  const pad = (value: number) => value.toFixed(2).padStart(12)
  const a = angle === 0 ? '0.00' : angle.toFixed(2)
  return `${head}${pad(x)}${pad(y)}${pad(0)}${a.padStart(12)}${pad(0).padStart(12)}${pad(0)}${pad(0)}`
}

function nc(akBody: string, boBody = ''): string {
  const bo = boBody ? `BO\n${boBody}\n` : ''
  return `ST\n  1\n  m1\n  C300\n  1\n  PFC100*50\n  U\n  1000\n  100\n  50\n  6.7\n  4.2\n  8\nAK\n${akBody}\n${bo}EN`
}

const OPEN = [row('  v', 100, 0), row(' ', 200, 50), row(' ', 300, 0)].join('\n')

const TINY = [
  row('  v', 0, 0),
  row(' ', 1000, 0),
  row(' ', 1000, 100),
  row(' ', 60, 100),
  row(' ', 60, 99),
  row(' ', 58, 99),
  row(' ', 58, 100),
  row(' ', 0, 100),
  row(' ', 0, 0),
].join('\n')

describe('removeCutFromNc', () => {
  it('drops the whole contour block for a standalone stray cut', () => {
    const before = nc(OPEN)
    expect(parseNcGeometry(before).contours).toHaveLength(1)
    const after = removeCutFromNc(before, { contourIndex: 0, removeVertices: null })
    expect(parseNcGeometry(after).contours).toHaveLength(0)
    // The rest of the file is preserved.
    expect(after).toContain('EN')
    expect(after).toContain('PFC100*50')
  })

  it('excises the vertices of a run inside a shared profile', () => {
    const before = nc(TINY)
    expect(parseNcGeometry(before).contours[0]?.points).toHaveLength(9)
    const after = removeCutFromNc(before, { contourIndex: 0, removeVertices: [3, 6] })
    const points = parseNcGeometry(after).contours[0]?.points
    expect(points).toEqual([
      [0, 0],
      [1000, 0],
      [1000, 100],
      [0, 100],
      [0, 0],
    ])
  })

  it('leaves the file untouched when the run touches an anchor vertex', () => {
    const before = nc(TINY)
    expect(removeCutFromNc(before, { contourIndex: 0, removeVertices: [0, 2] })).toBe(before)
  })

  it('ignores an out-of-range contour index', () => {
    const before = nc(OPEN)
    expect(removeCutFromNc(before, { contourIndex: 9, removeVertices: null })).toBe(before)
  })

  it('removes only the targeted block when a face has several contours', () => {
    const oBlock = [
      row('  o', 0, 0),
      row(' ', 1000, 0),
      row(' ', 1000, 50),
      row(' ', 0, 50),
      row(' ', 0, 0),
    ].join('\n')
    const two = `ST\n  1\n  m1\n  C300\n  1\n  PFC100*50\n  U\n  1000\n  100\n  50\n  6.7\n  4.2\n  8\nAK\n${OPEN}\nAK\n${oBlock}\nEN`
    expect(parseNcGeometry(two).contours).toHaveLength(2)
    const after = removeCutFromNc(two, { contourIndex: 1, removeVertices: null })
    const contours = parseNcGeometry(after).contours
    expect(contours).toHaveLength(1)
    expect(contours[0]?.face).toBe('v')
  })
})

describe('removeNcHole', () => {
  it('removes the matching BO hole line', () => {
    const before = nc(OPEN, '  v     100.00      50.00      14.00')
    expect(parseNcGeometry(before).holes).toHaveLength(1)
    const after = removeNcHole(before, { face: 'v', x: 100, y: 50, diameter: 14 })
    expect(parseNcGeometry(after).holes).toHaveLength(0)
  })

  it('leaves the file untouched when no hole matches', () => {
    const before = nc(OPEN, '  v     100.00      50.00      14.00')
    expect(removeNcHole(before, { face: 'v', x: 999, y: 50 })).toBe(before)
  })
})

/** A cut line (vertices 3–5) tapering through 5° / 12° / 20°, split by a stock edge. */
const TAPER = [
  bevRow('  v', 0, 0),
  bevRow(' ', 100, 0),
  bevRow(' ', 100, 100),
  bevRow(' ', 20, 100, 5),
  bevRow(' ', 15, 50, 12),
  bevRow(' ', 10, 10, 20),
  bevRow(' ', 0, 0),
].join('\n')

describe('setBevelInNc', () => {
  it('unifies the bevel angles on the flagged cut line', () => {
    const before = nc(TAPER)
    const after = setBevelInNc(before, { contourIndex: 0, vertices: [3, 4, 5], angle: 20 })
    const angles = parseNcGeometry(after).contours[0]?.bevels.map((bevel) => bevel[0])
    // Only the already-bevelled vertices change; the square vertices stay square.
    expect(angles).toEqual([0, 0, 0, 20, 20, 20, 0])
    expect(after).toContain('PFC100*50')
  })

  it('removes the bevel entirely when the angle is 0', () => {
    const before = nc(TAPER)
    const after = setBevelInNc(before, { contourIndex: 0, vertices: [3, 4, 5], angle: 0 })
    const angles = parseNcGeometry(after).contours[0]?.bevels.map((bevel) => bevel[0])
    expect(angles).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('ignores an out-of-range contour index', () => {
    const before = nc(TAPER)
    expect(setBevelInNc(before, { contourIndex: 9, vertices: [3], angle: 20 })).toBe(before)
  })
})
