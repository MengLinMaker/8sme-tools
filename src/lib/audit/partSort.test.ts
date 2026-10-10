import { describe, expect, it } from 'vitest'
import { severityRank, sortParts } from './partSort'
import type { Finding, PartRecord, Severity } from './types'

const part = (mark: string): PartRecord => ({ mark })
const finding = (severity: Severity, mark: string): Finding => ({
  severity,
  code: 'X',
  mark,
  message: 'msg',
})
const context = (findings: Finding[]) => ({
  findings,
  materials: new Map(),
  modelChecks: new Map(),
})

describe('severityRank', () => {
  it('ranks the worst finding first, clean parts last', () => {
    const ctx = context([finding('warning', 'a'), finding('error', 'b')])
    expect(severityRank(part('a'), ctx)).toBe(1)
    expect(severityRank(part('b'), ctx)).toBe(0)
    expect(severityRank(part('c'), ctx)).toBe(3)
  })

  it('treats a failed model check as a problem', () => {
    const ctx = {
      findings: [],
      materials: new Map(),
      modelChecks: new Map([['m1', { ok: false }]]),
    }
    expect(severityRank(part('m1'), ctx)).toBeLessThan(3)
  })
})

describe('sortParts', () => {
  it('puts problems first by severity', () => {
    const parts = [part('clean'), part('warn'), part('err')]
    const ctx = context([finding('warning', 'warn'), finding('error', 'err')])
    expect(sortParts(parts, 'severity', 1, ctx).map((p) => p.mark)).toEqual([
      'err',
      'warn',
      'clean',
    ])
  })

  it('sorts by a numeric column and reverses', () => {
    const parts = [
      { mark: 'a', nc: { quantity: 3 } } as PartRecord,
      { mark: 'b', nc: { quantity: 1 } } as PartRecord,
    ]
    const ctx = context([])
    expect(sortParts(parts, 'ncQty', 1, ctx).map((p) => p.mark)).toEqual(['b', 'a'])
    expect(sortParts(parts, 'ncQty', -1, ctx).map((p) => p.mark)).toEqual(['a', 'b'])
  })
})
