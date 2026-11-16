import { describe, expect, it } from 'vitest'
import { moveCutInNc } from '@/lib/parsers/ncEdit'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { partSectionForCode } from '@/lib/sections/stock'
import { assessRootFillet, rootFilletBands } from './rootFillet'

const PROFILE = 'UB310*32'
const DIMS = [298, 149, 8, 5.5, 13]
const SECTION = partSectionForCode(PROFILE, DIMS)
if (!SECTION) throw new Error('UB310*32 section missing')

function row(face: string, x: number, y: number): string {
  const pad = (value: number) => value.toFixed(2).padStart(12)
  return `${face}${pad(x)}${pad(y)}${pad(0)}${pad(0)}${pad(0)}${pad(0)}${pad(0)}`
}

function nc(body: string): string {
  return `ST\n** t.nc1\n  0\n  t\n  t\n  1\n  300PLUS\n  1\n  ${PROFILE}\n  I\n  1000\n  298\n  149\n  8\n  5.5\n  13\nAK\n${body.split('\n')[0]}\n${body.split('\n').slice(1).join('\n')}\nEN`
}

/** A rectangular web-face contour whose long edge runs along X at `y`. */
function webContour(y: number): string {
  return [
    row(`  ${'v'}`, 0, 0),
    row(' ', 100, 0),
    row(' ', 100, y),
    row(' ', 300, y),
    row(' ', 300, 0),
    row(' ', 400, 0),
    row(' ', 400, 298),
    row(' ', 0, 298),
    row(' ', 0, 0),
  ].join('\n')
}

/** A rectangular flange-face contour whose long edge runs along X at `y`. */
function flangeContour(y: number): string {
  return [
    row('  o', 0, 0),
    row(' ', 100, 0),
    row(' ', 100, y),
    row(' ', 300, y),
    row(' ', 300, 0),
    row(' ', 400, 0),
    row(' ', 400, 149),
    row(' ', 0, 149),
    row(' ', 0, 0),
  ].join('\n')
}

const options = { section: SECTION.points, dimensions: DIMS, profile: PROFILE }

describe('rootFilletBands', () => {
  it('puts the web fillets between the flat web and each flange inner face', () => {
    const bands = rootFilletBands('v', DIMS)
    expect(bands.map((band) => [band.lo, band.hi])).toEqual([
      [8, 21],
      [277, 290],
    ])
  })
})

describe('assessRootFillet', () => {
  it('flags a long web cut running inside the root fillet', () => {
    const issues = assessRootFillet(nc(webContour(15)), options)
    expect(issues).toHaveLength(1)
    const issue = issues[0]
    expect(issue?.code).toBe('CUT_ROOT_FILLET')
    expect(issue?.severity).toBe('error')
    expect(issue?.face).toBe('v')
    expect(issue?.delta).toBeCloseTo(8, 6)
    expect(issue?.params.move).toBeCloseTo(8, 1)
    expect(issue?.params.direction).toBe('inward')
    expect(issue?.params.span).toBe(200)
    expect(issue?.vertices).toEqual([2, 3])
  })

  it('clears a long cut already on the flat web', () => {
    expect(assessRootFillet(nc(webContour(100)), options)).toEqual([])
  })

  it('excludes the stock edge exactly on the flat/fillet tangent', () => {
    expect(assessRootFillet(nc(webContour(21)), options)).toEqual([])
  })

  it('flags a long flange cut backed by the root fillet and moves it outward', () => {
    const issues = assessRootFillet(nc(flangeContour(65)), options)
    expect(issues).toHaveLength(1)
    const issue = issues[0]
    expect(issue?.face).toBe('o')
    expect(issue?.delta).toBeCloseTo(-8.25, 6)
    expect(issue?.params.direction).toBe('outward')
  })

  it('ignores a short longitudinal edge and a transverse cut through the band', () => {
    const short = [
      row('  v', 0, 0),
      row(' ', 5, 0),
      row(' ', 5, 15),
      row(' ', 9, 15),
      row(' ', 9, 0),
      row(' ', 400, 0),
      row(' ', 400, 298),
      row(' ', 0, 298),
      row(' ', 0, 0),
    ].join('\n')
    expect(assessRootFillet(nc(short), options)).toEqual([])
  })

  it('does not apply to a non-I section', () => {
    const pfc = partSectionForCode('PFC100*50', [100, 50, 6.7, 4.2, 8])
    expect(pfc).not.toBeNull()
    if (!pfc) return
    expect(
      assessRootFillet(nc(webContour(15)), {
        section: pfc.points,
        dimensions: [100, 50, 6.7, 4.2, 8],
        profile: 'PFC100*50',
      }),
    ).toEqual([])
  })

  it('moves the flagged cut off the fillet so the check clears', () => {
    const before = nc(webContour(15))
    const issue = assessRootFillet(before, options)[0]
    expect(issue).toBeTruthy()
    if (!issue) return
    const after = moveCutInNc(before, {
      contourIndex: issue.contourIndex,
      vertices: issue.vertices,
      deltaY: issue.delta,
    })
    expect(assessRootFillet(after, options)).toEqual([])
  })

  it('handles a flagged edge that closes the contour back to vertex 0', () => {
    // The long fillet edge is the last edge (last unique vertex → vertex 0 / the closing duplicate).
    const body = [
      row('  v', 400, 15),
      row(' ', 400, 298),
      row(' ', 0, 298),
      row(' ', 0, 21),
      row(' ', 0, 15),
      row(' ', 400, 15),
    ].join('\n')
    const before = nc(body)
    const issue = assessRootFillet(before, options)[0]
    expect(issue).toBeTruthy()
    if (!issue) return
    expect(issue.vertices).toEqual([4, 0])
    const after = moveCutInNc(before, {
      contourIndex: issue.contourIndex,
      vertices: issue.vertices,
      deltaY: issue.delta,
    })
    const points = parseNcGeometry(after).contours[0]?.points
    // First point and its closing duplicate moved together, so the block stays closed.
    expect(points?.[0]).toEqual([400, 23])
    expect(points?.[points.length - 1]).toEqual([400, 23])
    expect(assessRootFillet(after, options)).toEqual([])
  })
})
