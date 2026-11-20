import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STEP_NAME_RULES,
  extractStepName,
  isDefaultStepNameRules,
  markFromFilename,
  markKey,
  nameBody,
  normalizeStepNameRules,
  quantityFromFilename,
  validateStepNameRules,
} from './stepNames'

describe('extractStepName defaults', () => {
  it('keeps the historical mark heuristics', () => {
    expect(markFromFilename('a1.nc1')).toBe('a1')
    expect(markFromFilename('M-1.nc1')).toBe('m-1')
    expect(markFromFilename('.a1.nc1')).toBe('a1')
    expect(markFromFilename('._M-1.nc1')).toBe('m-1')
    expect(markFromFilename('TR9-1  Shaft - UC (0).pdf')).toBe('tr9-1')
    expect(markFromFilename('12095, ITEM 35, SHS 75x75x6, 24 OFF[C].STEP')).toBe('item35')
    expect(markFromFilename('item10.stp')).toBe('item10')
  })

  it('keeps the historical quantity heuristics', () => {
    expect(quantityFromFilename('12095, ITEM 1, PFC 250, 1 OFF[C].STEP')).toBe(1)
    expect(quantityFromFilename('item1, SHS 75x75x6, 24off.stp')).toBe(24)
    expect(quantityFromFilename('TR9-1.nc1')).toBeNull()
    expect(quantityFromFilename('3ub-1 offcut.stp')).toBeNull()
  })

  it('reads the section callout, including underscore-separated names', () => {
    expect(extractStepName('12095, ITEM 1, PFC 250, 1 OFF[C].STEP').section?.code).toBe('250 PFC')
    expect(extractStepName('ITEM_35_SHS_75x75x6_2_OFF.step').section?.code).toBe('SHS75*75*6')
    expect(extractStepName('ITEM_10_200UB25_1_OFF.step').section?.code).toBe('200UB25.4')
  })

  it('matches a depth-first UB callout whole, so it is not reported as a fallback', () => {
    const rounded = extractStepName('12095, ITEM 10, 200UB25, 1 OFF[C].STEP')
    expect(rounded.section?.code).toBe('200UB25.4')
    expect(rounded.sectionCallout).toBe('200UB25')
    expect(rounded.sectionFromRule).toBe(true)
    expect(extractStepName('12095, ITEM 23, 150UB14, 1 OFF[C].STEP').section?.code).toBe(
      '150UB14.0',
    )
  })

  it('reports the matched range of each rule for highlighting', () => {
    const path = '12095, ITEM 10, 200UB25, 1 OFF[C].STEP'
    const name = extractStepName(path)
    const spans = Object.fromEntries(name.spans.map((span) => [span.field, span]))
    expect(spans.mark?.text).toBe('ITEM 10')
    expect(spans.quantity?.text).toBe('1')
    expect(spans.section?.text).toBe('200UB25')
    // The offsets index the body the rules were run against, not the full path.
    const body = nameBody(path)
    expect(body.slice(spans.section?.start, spans.section?.end)).toBe('200UB25')
  })

  it('returns no section span when the callout does not resolve', () => {
    const name = extractStepName('A1 UB25.step', { section: 'UB([0-9]+)' })
    expect(name.section).toBeNull()
    expect(name.sectionFromRule).toBe(false)
    expect(name.spans.some((span) => span.field === 'section')).toBe(false)
  })

  it('treats underscores as separators only when asked', () => {
    // The ITEM token is recognised regardless of separator.
    expect(markFromFilename('ITEM_35_SHS_75x75x6_2_OFF.step')).toBe('item35')
    expect(markFromFilename('ITEM_35_SHS_75x75x6_2_OFF.step', { underscoreSeparator: true })).toBe(
      'item35',
    )
    // The toggle decides where a non-ITEM mark ends.
    expect(markFromFilename('A1_drawing.step')).toBe('a1_drawing')
    expect(markFromFilename('A1_drawing.step', { underscoreSeparator: true })).toBe('a1')
    expect(
      extractStepName('ITEM_35_SHS_75x75x6_2_OFF.step', { underscoreSeparator: true }).quantity,
    ).toBe(2)
    expect(quantityFromFilename('A1_24_OFF.step')).toBe(24)
    expect(quantityFromFilename('A1_24_OFF.step', { underscoreSeparator: true })).toBe(24)
  })
})

describe('extractStepName custom rules', () => {
  it('reports whether each field came from the rule or the fallback', () => {
    const item = extractStepName('12095, ITEM 35, SHS 75x75x6, 24 OFF[C].STEP')
    expect(item).toMatchObject({
      mark: 'item35',
      markFromRule: true,
      quantity: 24,
      quantityFromRule: true,
      sectionFromRule: true,
    })
    const plain = extractStepName('TR9-1  Shaft - UC (0).pdf')
    expect(plain.mark).toBe('tr9-1')
    expect(plain.markFromRule).toBe(false)
    expect(plain.quantityFromRule).toBe(false)
  })

  it('reads the mark from a capture group', () => {
    const name = extractStepName('WALL-2_A17_SHS_75x75x6.step', {
      mark: '_(A[0-9]+)_',
      underscoreSeparator: true,
    })
    expect(name.mark).toBe('a17')
    expect(name.markError).toBeNull()
  })

  it('reads a custom quantity and falls back when the pattern misses', () => {
    expect(
      extractStepName('A1 SHS 75x75x6 QTY 24.step', { quantity: 'qty\\s*([0-9]+)' }).quantity,
    ).toBe(24)
    // No match → the built-in `<n> OFF` rule still runs.
    expect(
      extractStepName('A1 SHS 75x75x6 12 OFF.step', { quantity: 'qty\\s*([0-9]+)' }).quantity,
    ).toBe(12)
  })

  it('reads a section callout captured from anywhere', () => {
    const name = extractStepName('A17 (SHS 89x89x5).step', {
      section: '\\((SHS[^)]+)\\)',
    })
    expect(name.section?.code).toBe('SHS89*89*5')
  })

  it('falls back to the built-in heuristic when a custom pattern is invalid', () => {
    const name = extractStepName('12095, ITEM 35, SHS 75x75x6, 24 OFF[C].STEP', {
      mark: '([unclosed',
      quantity: '([unclosed',
    })
    expect(name.mark).toBe('item35')
    expect(name.quantity).toBe(24)
    expect(name.markError).not.toBeNull()
    expect(name.quantityError).not.toBeNull()
  })

  it('falls back to the built-in heuristic when a custom pattern does not match', () => {
    const name = extractStepName('TR9-1.nc1', { mark: '^ITEM-([0-9]+)$' })
    expect(name.mark).toBe('tr9-1')
    expect(name.markError).toBeNull()
  })
})

describe('rule helpers', () => {
  it('normalises a stored partial config', () => {
    expect(normalizeStepNameRules({ underscoreSeparator: true })).toEqual({
      ...DEFAULT_STEP_NAME_RULES,
      underscoreSeparator: true,
    })
  })

  it('recognises the defaults', () => {
    expect(isDefaultStepNameRules(undefined)).toBe(true)
    expect(isDefaultStepNameRules({ mark: '  ' })).toBe(true)
    expect(isDefaultStepNameRules({ mark: 'ITEM-([0-9]+)' })).toBe(false)
  })

  it('validates each pattern for the settings form', () => {
    expect(validateStepNameRules({ mark: 'ITEM-([0-9]+)' })).toEqual({
      mark: null,
      quantity: null,
      section: null,
    })
    const errors = validateStepNameRules({ mark: '([', quantity: '(', section: '+' })
    expect(errors.mark).not.toBeNull()
    expect(errors.quantity).not.toBeNull()
    expect(errors.section).not.toBeNull()
  })

  it('strips the directory, extension and leading dots from a name', () => {
    expect(nameBody('STEP/._M-1.nc1')).toBe('M-1')
  })
})

describe('markKey', () => {
  it('joins the same part written differently', () => {
    expect(markKey('ITEM 35')).toBe(markKey('item35'))
    expect(markKey('A/1')).toBe(markKey('A_1'))
    expect(markKey('item 7')).toBe(markKey('item7'))
  })

  it('keeps hyphenated suffixes distinct', () => {
    expect(markKey('TR9-1')).not.toBe(markKey('TR9-2'))
    expect(markKey('item 1.1')).not.toBe(markKey('item 11'))
  })
})
