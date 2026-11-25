import { describe, expect, it } from 'vitest'
import { findingOpKey, ncOpForFinding } from '@/lib/audit/fixOps'
import { assessManufacturability } from '@/lib/audit/manufacturability'
import { assessRootFillet } from '@/lib/audit/rootFillet'
import { assessUnclosedCutsGeometry } from '@/lib/audit/unclosedCuts'
import { moveCutInNc, removeCutFromNc, setOutOfRangeBevelInNc } from '@/lib/parsers/ncEdit'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { outlinePoints } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import type { Finding } from './schemas'

/** A finding in the shape the page builds: the issue's own params plus what the op needs. */
function finding(code: string, params: Record<string, string | number>): Finding {
  return { code, severity: 'error', mark: 'm1', message: code, params }
}

const pad = (value: number) => value.toFixed(2).padStart(12)
const row = (head: string, x: number, y: number, a0 = 0, d0 = 0, a1 = 0, d1 = 0) =>
  `${head}${pad(x)}${pad(y)}${pad(0)}${pad(a0)}${pad(d0)}${pad(a1)}${pad(d1)}`

// --- root fillet: a UB310*32 web cut running inside the rolled fillet -----------------------------

const PROFILE = 'UB310*32'
const DIMS = [298, 149, 8, 5.5, 13]
const SECTION = partSectionForCode(PROFILE, DIMS)
if (!SECTION) throw new Error('UB310*32 section missing')

function ubNc(body: string): string {
  return `ST\n** t.nc1\n  0\n  t\n  t\n  1\n  300PLUS\n  1\n  ${PROFILE}\n  I\n  1000\n  298\n  149\n  8\n  5.5\n  13\nAK\n${body}\nEN`
}

const WEB_AT_FILLET = [
  row('  v', 0, 0),
  row(' ', 100, 0),
  row(' ', 100, 15),
  row(' ', 300, 15),
  row(' ', 300, 0),
  row(' ', 400, 0),
  row(' ', 400, 298),
  row(' ', 0, 298),
  row(' ', 0, 0),
].join('\n')

// --- unclosed: a closed loop floating in the middle of a PFC's face ------------------------------

const PFC = 'PFC100*50'
const PFC_DIMS = [100, 50, 6.7, 4.2, 8]
const PFC_SECTION = partSectionForCode(PFC, PFC_DIMS)
if (!PFC_SECTION) throw new Error('PFC100*50 section missing')

function pfcNc(body: string): string {
  return `ST\n  1\n  m1\n  C300\n  1\n  ${PFC}\n  U\n  1000\n  100\n  50\n  6.7\n  4.2\n  8\nAK\n${body}\nEN`
}

/** A closed profile with a 4 mm edge-to-edge notch — a stray run inside a shared contour. */
const TINY_NOTCH = [
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

// --- bevel out of range: a 60° prep, past the head's ±45° ----------------------------------------

function teeNc(body: string): string {
  return `ST\n  1\n  m1\n  C300\n  1\n  BT100*15\n  T\n  1000\n  134\n  103\n  9.6\n  6.3\n  8.9\nAK\n${body}\nEN`
}

const STEEP_BEVEL = [
  row('  o', 0, 0),
  row(' ', 100, 0),
  row(' ', 100, 30, 60, 9),
  row(' ', 60, 30, 60, 9),
  row(' ', 60, 100),
  row(' ', 0, 100),
].join('\n')

describe('ncOpForFinding', () => {
  it('moves a root-fillet cut off the fillet so the check clears', () => {
    const before = ubNc(WEB_AT_FILLET)
    const options = { section: outlinePoints(SECTION?.outline), dimensions: DIMS, profile: PROFILE }
    const issue = assessRootFillet(before, options)[0]
    expect(issue?.code).toBe('CUT_ROOT_FILLET')
    if (!issue) return

    const target = finding('CUT_ROOT_FILLET', {
      ...issue.params,
      contourIndex: issue.contourIndex,
      vertices: issue.vertices.join(','),
    })
    expect(findingOpKey(target)).toBe(`fillet:${issue.contourIndex}:${issue.vertices.join(',')}`)
    const op = ncOpForFinding(target)
    expect(op?.kind).toBe('moveCut')
    if (op?.kind !== 'moveCut') return

    const after = moveCutInNc(before, {
      contourIndex: op.contourIndex,
      vertices: op.vertices,
      deltaY: op.deltaY,
    })
    expect(assessRootFillet(after, options)).toEqual([])
  })

  it('removes a stray cut-out so the check clears', () => {
    const before = pfcNc(TINY_NOTCH)
    const options = { section: outlinePoints(PFC_SECTION?.outline), profile: PFC }
    const issue = assessUnclosedCutsGeometry(parseNcGeometry(before), options)[0]
    expect(issue?.removal).not.toBeNull()
    if (!issue) return

    const target = finding(issue.code, {
      ...issue.params,
      contourIndex: issue.contourIndex,
      removal: issue.removal?.join(',') ?? '',
    })
    const op = ncOpForFinding(target)
    expect(op?.kind).toBe('removeCut')
    if (op?.kind !== 'removeCut') return

    const after = removeCutFromNc(before, {
      contourIndex: op.contourIndex,
      removeVertices: op.removeVertices,
    })
    expect(
      assessUnclosedCutsGeometry(parseNcGeometry(after), options).filter(
        (left) => left.code === issue.code,
      ),
    ).toEqual([])
  })

  it('clamps every out-of-range bevel so the check clears', () => {
    let ncText = teeNc(STEEP_BEVEL)
    const issues = assessManufacturability(ncText).filter(
      (candidate) => candidate.code === 'BEVEL_OUT_OF_RANGE',
    )
    // One finding per segment, so a batch applies one op each.
    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) {
      if (!issue.params) continue
      const op = ncOpForFinding(finding('BEVEL_OUT_OF_RANGE', issue.params))
      expect(op?.kind).toBe('outOfRangeBevel')
      if (op?.kind !== 'outOfRangeBevel') continue
      ncText = setOutOfRangeBevelInNc(ncText, {
        contourIndex: op.contourIndex,
        vertex: op.vertex,
        angle: op.angle,
      })
    }
    expect(
      assessManufacturability(ncText).filter(
        (candidate) => candidate.code === 'BEVEL_OUT_OF_RANGE',
      ),
    ).toEqual([])
  })

  it('has no NC edit for a finding that is not an NC-line issue', () => {
    expect(ncOpForFinding(finding('STRAY_BODY', { bodies: 2 }))).toBeNull()
    expect(findingOpKey(finding('MANUFACTURE_MISMATCH', { note: 'x' }))).toBeNull()
  })
})
