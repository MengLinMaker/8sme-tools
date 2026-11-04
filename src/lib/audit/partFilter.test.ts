import { describe, expect, it } from 'vitest'
import {
  filterParts,
  parsePartQuery,
  partSearchText,
  statusForPart,
  toggleQueryToken,
  withStatusFilter,
} from './partFilter'
import type { Finding, PartRecord, Severity } from './types'

const part = (mark: string): PartRecord => ({ mark })
const finding = (severity: Severity, mark: string, code = 'X'): Finding => ({
  severity,
  code,
  mark,
  message: `${code} happened on ${mark}`,
})

const baseContext = (findings: Finding[]) => ({ findings })
const marks = (parts: PartRecord[]) => parts.map((item) => item.mark)

describe('parsePartQuery', () => {
  it('separates status words from free-text terms', () => {
    expect(parsePartQuery('error weld CUT_DEPTH')).toEqual({
      statuses: ['error'],
      terms: ['weld', 'cut_depth'],
    })
  })

  it('ORs repeated status synonyms and de-duplicates them', () => {
    expect(parsePartQuery('err error warnings ok')).toEqual({
      statuses: ['error', 'warning', 'ok'],
      terms: [],
    })
  })

  it('keeps quoted phrases as one literal term', () => {
    expect(parsePartQuery('"error weld" NW31')).toEqual({
      statuses: [],
      terms: ['error weld', 'nw31'],
    })
  })
})

describe('filterParts', () => {
  const parts = [part('NW31-1'), part('NW31-2'), part('BT100-1')]
  const findings = [
    finding('error', 'NW31-1', 'CUT_DEPTH'),
    finding('warning', 'NW31-2', 'CUT_BEVEL_CHANGE'),
  ]

  it('filters by status', () => {
    const context = baseContext(findings)
    expect(marks(filterParts(parts, 'error', context))).toEqual(['NW31-1'])
    expect(marks(filterParts(parts, 'warning', context))).toEqual(['NW31-2'])
    expect(marks(filterParts(parts, 'ok', context))).toEqual(['BT100-1'])
  })

  it('ORs multiple status words', () => {
    const context = baseContext(findings)
    expect(marks(filterParts(parts, 'error warning', context))).toEqual(['NW31-1', 'NW31-2'])
  })

  it('matches finding codes and their localised text', () => {
    const context = {
      ...baseContext(findings),
      findingText: (item: Finding) =>
        item.code === 'CUT_DEPTH' ? 'depth too deep' : 'bevel swings mid-cut',
    }
    expect(marks(filterParts(parts, 'cut depth', context))).toEqual(['NW31-1'])
    expect(marks(filterParts(parts, 'swings', context))).toEqual(['NW31-2'])
  })

  it('matches weld etchings', () => {
    const context = {
      ...baseContext(findings),
      weldingMarks: new Set(['BT100-1']),
      weldingText: () => 'etched member marks: NW31',
    }
    expect(marks(filterParts(parts, 'weld', context))).toEqual(['BT100-1'])
    expect(marks(filterParts(parts, 'etch', context))).toEqual(['BT100-1'])
  })

  it('ANDs free-text terms and the status filter', () => {
    const context = baseContext(findings)
    expect(marks(filterParts(parts, 'nw31 error', context))).toEqual(['NW31-1'])
    expect(marks(filterParts(parts, 'nw31 ok', context))).toEqual([])
  })

  it('matches the mark, profile and grade fields', () => {
    const shaped: PartRecord[] = [
      { mark: 'A', nc: { profile: 'BT100*15', grade: '300PLUS' } as PartRecord['nc'] },
      { mark: 'B', expected: { profile: '200UB29.8', grade: '300PLUS' } as never },
    ]
    const context = baseContext([])
    expect(marks(filterParts(shaped, 'bt100', context))).toEqual(['A'])
    expect(marks(filterParts(shaped, '200ub', context))).toEqual(['B'])
    expect(marks(filterParts(shaped, '300plus', context))).toEqual(['A', 'B'])
  })

  it('keeps every part when the query is blank', () => {
    const context = baseContext(findings)
    expect(filterParts(parts, '   ', context)).toBe(parts)
  })
})

describe('statusForPart', () => {
  it('treats a failed model check as a warning', () => {
    const context = {
      findings: [],
      modelChecks: new Map([['A', { ok: false }]]),
    }
    expect(statusForPart(part('A'), context)).toBe('warning')
  })
})

describe('partSearchText', () => {
  it('flattens code separators and includes file kinds', () => {
    const context = baseContext([finding('error', 'A', 'CUT_BEVEL_CHANGE')])
    const text = partSearchText(
      { mark: 'A', nc: {} as PartRecord['nc'], step: {} as PartRecord['step'] },
      context,
    )
    expect(text).toContain('cut bevel change')
    expect(text).toContain('step')
    expect(text).toContain('nc')
  })
})

describe('withStatusFilter', () => {
  it('replaces only the status words', () => {
    expect(withStatusFilter('weld error NW31', 'warning')).toBe('weld NW31 warning')
    expect(withStatusFilter('weld error', 'ok')).toBe('weld ok')
  })

  it('clears the status words for "all"', () => {
    expect(withStatusFilter('weld warning NW31', 'all')).toBe('weld NW31')
  })
})

describe('toggleQueryToken', () => {
  it('adds a missing token and removes an active one', () => {
    expect(toggleQueryToken('weld', 'error')).toBe('weld error')
    expect(toggleQueryToken('weld error', 'error')).toBe('weld')
    expect(toggleQueryToken('', 'CUT_DEPTH')).toBe('CUT_DEPTH')
  })

  it('quotes a token containing spaces', () => {
    expect(toggleQueryToken('', 'cut depth')).toBe('"cut depth"')
  })
})
