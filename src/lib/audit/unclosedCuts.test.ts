import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nw30Bottom, nw31Bottom, nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseNcFile } from '@/lib/parsers/nc'
import { partSectionForCode } from '@/lib/sections/stock'
import { assessUnclosedCuts, TINY_CUT_MM } from './unclosedCuts'

/** A minimal NC with the given `AK` block body (a PFC, so every face is a valid section). */
function nc(akBody: string): string {
  return `ST\n  1\n  m1\n  C300\n  1\n  PFC100*50\n  U\n  1000\n  100\n  50\n  6.7\n  4.2\n  8\nAK\n${akBody}\nEN`
}

/** One `AK` row: `X Y R angle0 dist0 angle1 dist1`. */
function row(head: string, x: number, y: number): string {
  const pad = (value: number) => value.toFixed(2).padStart(12)
  return `${head}${pad(x)}${pad(y)}${pad(0)}${pad(0).padStart(12)}${pad(0).padStart(12)}${pad(0)}${pad(0)}`
}

/** A clean, closed rectangular `v` profile — two edge-to-edge end cuts, no strays. */
const CLOSED = [
  row('  v', 0, 0),
  row(' ', 1000, 0),
  row(' ', 1000, 100),
  row(' ', 0, 100),
  row(' ', 0, 0),
].join('\n')

/** An open polyline that never closes — a broken/partial cut. */
const OPEN = [row('  v', 100, 0), row(' ', 200, 50), row(' ', 300, 0)].join('\n')

/** A closed loop floating in the middle of a wide face (never touches the section boundary). */
const FLOATING = [
  row('  v', 100, 40),
  row(' ', 120, 40),
  row(' ', 120, 60),
  row(' ', 100, 60),
  row(' ', 100, 40),
].join('\n')

/** A closed profile with one short (4 mm) edge-to-edge notch — a "little cut". */
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

/** A section 50 wide × 100 deep, so `v`'s boundary is Y ∈ [0, 100]. */
const SECTION: [number, number][] = [
  [0, 0],
  [50, 0],
  [50, 100],
  [0, 100],
]

/** An NC whose `AK` block is the clean closed profile and `IK` block the given cut-out. */
function ncWithIk(ikBody: string): string {
  return `ST\n  1\n  m1\n  C300\n  1\n  PFC100*50\n  U\n  1000\n  100\n  50\n  6.7\n  4.2\n  8\nAK\n${CLOSED}\nIK\n${ikBody}\nEN`
}

/** A small triangular cut-out (the reported artefact). */
const TRI_CUTOUT = [
  row('  o', 100, 10),
  row(' ', 140, 5),
  row(' ', 140, 15),
  row(' ', 100, 10),
].join('\n')

/** A large, ordinary rectangular opening — should not be flagged. */
const RECT_CUTOUT = [
  row('  o', 0, 0),
  row(' ', 200, 0),
  row(' ', 200, 100),
  row(' ', 0, 100),
  row(' ', 0, 0),
].join('\n')

describe('unclosedCuts', () => {
  it('accepts a clean closed profile with only edge-to-edge cuts', () => {
    expect(assessUnclosedCuts(nc(CLOSED))).toEqual([])
  })

  it('flags an open (non-closing) cut', () => {
    const issues = assessUnclosedCuts(nc(OPEN))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('CUT_UNCLOSED')
    expect(issues[0]?.severity).toBe('warning')
    expect(issues[0]?.params.reason).toBe('open')
    // The marker is carried in NC face coords for the viewer.
    expect(issues[0]?.face).toBe('v')
    expect(issues[0]?.color).toBe(0xf59e0b)
    // Whole-contour feature: removed by dropping the block.
    expect(issues[0]?.removal).toBeNull()
  })

  it('flags a loop that floats inside the face when the section is known', () => {
    expect(assessUnclosedCuts(nc(FLOATING))).toEqual([])
    const issues = assessUnclosedCuts(nc(FLOATING), { section: SECTION })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.params.reason).toBe('floating')
    expect(issues[0]?.removal).toBeNull()
  })

  it(`flags an edge-to-edge run shorter than ${TINY_CUT_MM} mm`, () => {
    const issues = assessUnclosedCuts(nc(TINY), { section: SECTION })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.params.reason).toBe('tiny')
    // The 4 mm notch is excised by deleting its vertices.
    expect(issues[0]?.removal).toEqual([3, 6])
  })

  it('flags a small triangular inner cut-out (the WiseCAM artefact)', () => {
    const issues = assessUnclosedCuts(ncWithIk(TRI_CUTOUT), { section: SECTION })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('CUT_CUTOUT')
    expect(issues[0]?.kind).toBe('inner')
    expect(issues[0]?.params.reason).toBe('cutout')
    // Whole cut-out feature: removed by dropping the IK block.
    expect(issues[0]?.removal).toBeNull()
  })

  it('accepts an ordinary large rectangular opening', () => {
    expect(assessUnclosedCuts(ncWithIk(RECT_CUTOUT), { section: SECTION })).toEqual([])
  })
})

describe('unclosedCuts on the real fixtures', () => {
  const dirs = [nw31Top('NC files'), nw31Bottom(), nw30Bottom()]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.nc1'))) {
      const path = join(dir, file)
      it.skipIf(!existsSync(path))(`${file} has no stray cuts`, () => {
        const text = readFileSync(path, 'utf8')
        const header = parseNcFile(path, text)
        const section = header.profile
          ? partSectionForCode(header.profile, header.dimensions ?? [])
          : null
        const issues = assessUnclosedCuts(text, {
          section: section?.points,
          profile: header.profile,
        })
        expect(issues.map((issue) => `${issue.face}:${issue.params.reason}`)).toEqual([])
      })
    }
  }
})
