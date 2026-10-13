import { existsSync, readFileSync } from 'node:fs'
import { nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { assessBevelChange, BEVEL_SAME_DEG } from './bevelChange'

/** A minimal NC with the given `AK` block body (a PFC, so every face is valid). */
function nc(akBody: string): string {
  return `ST\n  1\n  m1\n  C300\n  1\n  PFC100*50\n  U\n  1000\n  100\n  50\n  6.7\n  4.2\n  8\nAK\n${akBody}\nEN`
}

/** One `AK` row: `X Y R angle0 dist0 angle1 dist1`. */
function row(head: string, x: number, y: number, angle = 0, distance = 0): string {
  const pad = (value: number) => value.toFixed(2).padStart(12)
  const a = angle === 0 ? '0.00' : angle.toFixed(2)
  const d = distance === 0 ? '0.00' : distance.toFixed(2)
  return `${head}${pad(x)}${pad(y)}${pad(0)}${a.padStart(12)}${d.padStart(12)}${pad(0)}${pad(0)}`
}

/** A square whose last three vertices taper through different bevels — one cut line. */
const TAPER = [
  row('  v', 0, 0),
  row(' ', 100, 0),
  row(' ', 100, 100),
  row(' ', 20, 100, 5),
  row(' ', 15, 50, 12),
  row(' ', 10, 10, 20),
  row(' ', 0, 0),
].join('\n')

/** The same square but the bevel is one angle throughout. */
const UNIFORM = [
  row('  v', 0, 0),
  row(' ', 100, 0),
  row(' ', 100, 100, 20),
  row(' ', 20, 100, 20),
  row(' ', 10, 10, 20),
  row(' ', 0, 0),
].join('\n')

/** Two separate bevelled cuts split by a square (0°) vertex — different lines, so not a change. */
const SPLIT = [
  row('  v', 0, 0, 10),
  row(' ', 50, 0),
  row(' ', 100, 0, 20),
  row(' ', 100, 100),
  row(' ', 0, 100),
].join('\n')

/**
 * A PFC-style end cut: the cut runs edge to edge (Y 100 → 0) with a changing bevel, between two
 * raw-stock edges (the far end and the two along-member stock edges are not cuts).
 */
const COPE = [
  row('  v', 0, 0),
  row(' ', 200, 0),
  row(' ', 200, 100),
  row(' ', 40, 100, 5),
  row(' ', 30, 50, 15),
  row(' ', 20, 0, 25),
].join('\n')

describe('bevelChange', () => {
  it('2° is the same-bevel tolerance', () => {
    expect(BEVEL_SAME_DEG).toBe(2)
  })

  it('flags a bevel that changes along one continuous cut line', () => {
    const issues = assessBevelChange(nc(TAPER))
    expect(issues.map((i) => i.code)).toEqual(['CUT_BEVEL_CHANGE'])
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.params.face).toBe('v')
    expect(issues[0]?.params.suggested).toBe('20.0')
    // The marker the viewer draws: the cut line is carried in NC face coords.
    expect(issues[0]?.face).toBe('v')
    expect(issues[0]?.from).toHaveLength(2)
    expect(issues[0]?.to).toHaveLength(2)
  })

  it('accepts a cut line with a single bevel', () => {
    expect(assessBevelChange(nc(UNIFORM))).toEqual([])
  })

  it('treats a 0° vertex as the end of a cut line, not a direction change', () => {
    expect(assessBevelChange(nc(SPLIT))).toEqual([])
  })

  it('marks the whole cut line, edge to edge', () => {
    const issues = assessBevelChange(nc(COPE))
    expect(issues).toHaveLength(1)
    // The full cut runs Y 100 → 0; the far end and the stock edges are not part of it.
    expect(issues[0]?.lines).toEqual([
      [
        [40, 100],
        [30, 50],
        [20, 0],
      ],
    ])
  })
})

describe('bevelChange on real NW31-top parts', () => {
  const flagged = ['m31', 'm41', 'm124', 'm180']
  for (const mark of flagged) {
    const path = nw31Top('NC files', `${mark}.nc1`)
    it.skipIf(!existsSync(path))(`${mark} (PFC) flags the changing bevel on its v face`, () => {
      const issues = assessBevelChange(readFileSync(path, 'utf8'))
      expect(issues.length).toBeGreaterThan(0)
      expect(issues.every((issue) => issue.code === 'CUT_BEVEL_CHANGE')).toBe(true)
      expect(issues.some((issue) => issue.params.face === 'v')).toBe(true)
    })
  }

  // The RHS is mitred at both ends: one bevelled cut per end, each a single angle — the head sets a
  // direction per cut, so opposite signs at opposite ends are not a direction change.
  const path = nw31Top('NC files', 'm117.nc1')
  it.skipIf(!existsSync(path))('m117 (RHS) two single-bevel end cuts do not flag', () => {
    expect(assessBevelChange(readFileSync(path, 'utf8'))).toEqual([])
  })
})
