import { describe, expect, it } from 'vitest'
import {
  applyNestNameRule,
  DEFAULT_NEST_NAME_RULE,
  matchNestNames,
  normalizeNestKey,
} from './nestNameRule'

describe('applyNestNameRule', () => {
  it('extracts ITEM marks from full Tekla callouts', () => {
    expect(
      applyNestNameRule('Modified 12095, ITEM 30, EA 200x200x20, 4 OFF[C]', DEFAULT_NEST_NAME_RULE),
    ).toMatchObject({ key: 'item30', error: null })
    expect(
      applyNestNameRule('12095, ITEM 35, SHS 75x75x6, 2 OFF[C]', DEFAULT_NEST_NAME_RULE),
    ).toMatchObject({
      key: 'item35',
    })
  })

  it('cleans QIE/WELD suffixes and extracts ordinary marks', () => {
    expect(applyNestNameRule('M_29 QIE', DEFAULT_NEST_NAME_RULE)).toMatchObject({ key: 'm-29' })
    expect(applyNestNameRule('B11-22 WELD QIE', DEFAULT_NEST_NAME_RULE)).toMatchObject({
      key: 'b11-22',
    })
    expect(applyNestNameRule('T9-7 QIE？', DEFAULT_NEST_NAME_RULE)).toMatchObject({ key: 't9-7' })
  })

  it('lets a job override the clean/extract rules', () => {
    const rule = { clean: String.raw`\s*\(.*\)$`, extract: String.raw`([A-Z]+-\d+)` }
    expect(applyNestNameRule('  XX-42 (rev 3)  ', rule)).toMatchObject({
      cleaned: 'XX-42',
      key: 'xx-42',
    })
  })

  it('reports an invalid regex instead of throwing', () => {
    const result = applyNestNameRule('M_29', { clean: '(', extract: '' })
    expect(result.error).toContain('Clean regex')
    expect(result.key).toBeNull()
  })
})

describe('normalizeNestKey', () => {
  it('treats underscore/hyphen and case as the same key', () => {
    expect(normalizeNestKey('M_29')).toBe(normalizeNestKey('M-29'))
    expect(normalizeNestKey('ITEM 35')).toBe('item35')
    expect(normalizeNestKey('M_29')).not.toBe(normalizeNestKey('M29'))
  })
})

describe('matchNestNames', () => {
  it('matches only exact normalised keys and lists the rest as unmatched', () => {
    const summary = matchNestNames(
      ['M_29 QIE', 'B7-20 WELD', 'SOMETHING ELSE'],
      ['M-29', 'B7-20', 'ITEM 30'],
      DEFAULT_NEST_NAME_RULE,
    )
    expect(summary.rows.map((row) => [row.name, row.key, row.matched])).toEqual([
      ['B7-20 WELD', 'b7-20', true],
      ['M_29 QIE', 'm-29', true],
      ['SOMETHING ELSE', 'something', false],
    ])
    expect(summary.matched).toBe(2)
    expect(summary.unmatched).toBe(1)
    expect(summary.missingProjectMarks).toEqual(['ITEM 30'])
    expect(summary.error).toBeNull()
  })

  it('surfaces names that collapse to the same key', () => {
    const summary = matchNestNames(['M_29', 'M-29 QIE'], ['M-29'], DEFAULT_NEST_NAME_RULE)
    expect(summary.ambiguous).toEqual([{ key: 'm-29', names: ['M_29', 'M-29 QIE'] }])
  })
})
