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

  it('ranks weld etchings with info, above clean parts', () => {
    const ctx = { ...context([]), weldingMarks: new Set(['weld']) }
    expect(severityRank(part('weld'), ctx)).toBe(2)
    expect(severityRank(part('clean'), ctx)).toBe(3)
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

  it('puts parts with both an issue and a weld mark first within that status', () => {
    const parts = [part('warn'), part('warn-weld'), part('err')]
    const ctx = {
      ...context([
        finding('warning', 'warn'),
        finding('warning', 'warn-weld'),
        finding('error', 'err'),
      ]),
      weldingMarks: new Set(['warn-weld']),
    }
    expect(sortParts(parts, 'severity', 1, ctx).map((p) => p.mark)).toEqual([
      'err',
      'warn-weld',
      'warn',
    ])
  })

  it('sorts by the quantity column and reverses', () => {
    const parts = [
      { mark: 'a', nc: { quantity: 3 } } as PartRecord,
      { mark: 'b', nc: { quantity: 1 } } as PartRecord,
    ]
    const ctx = context([])
    expect(sortParts(parts, 'qty', 1, ctx).map((p) => p.mark)).toEqual(['b', 'a'])
    expect(sortParts(parts, 'qty', -1, ctx).map((p) => p.mark)).toEqual(['a', 'b'])
  })

  it('sorts marks naturally, not lexically', () => {
    const parts = [part('m-12'), part('m-2'), part('m-21'), part('m-1')]
    expect(sortParts(parts, 'mark', 1, context([])).map((p) => p.mark)).toEqual([
      'm-1',
      'm-2',
      'm-12',
      'm-21',
    ])
  })

  it('sorts by the displayed mass and keeps missing values last in both directions', () => {
    const parts = [part('a'), part('b'), part('c')]
    const masses: Record<string, number | null> = { a: 30, b: null, c: 10 }
    const ctx = { ...context([]), mass: (p: PartRecord) => masses[p.mark] ?? null }
    expect(sortParts(parts, 'mass', 1, ctx).map((p) => p.mark)).toEqual(['c', 'a', 'b'])
    expect(sortParts(parts, 'mass', -1, ctx).map((p) => p.mark)).toEqual(['a', 'c', 'b'])
  })

  it('sorts the model column by size, length first', () => {
    const parts = [part('long'), part('short'), part('none')]
    const ctx = {
      ...context([]),
      modelChecks: new Map([
        ['long', { ok: true, measured: [3000, 200, 100] as [number, number, number] }],
        ['short', { ok: true, measured: [500, 200, 100] as [number, number, number] }],
      ]),
    }
    expect(sortParts(parts, 'model', 1, ctx).map((p) => p.mark)).toEqual(['short', 'long', 'none'])
  })

  it('sorts by the first assembly and puts unassembled parts last', () => {
    const parts = [
      { mark: 'a' },
      {
        mark: 'b',
        assemblies: [{ assembly: 'B-1', assemblyQty: 1, qtyPerAssembly: 1, total: 1 }],
      },
      {
        mark: 'c',
        assemblies: [{ assembly: 'A-1', assemblyQty: 1, qtyPerAssembly: 1, total: 1 }],
      },
    ] as PartRecord[]
    expect(sortParts(parts, 'assembly', 1, context([])).map((p) => p.mark)).toEqual(['c', 'b', 'a'])
  })
})
