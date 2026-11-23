import { describe, expect, it } from 'vitest'
import { isRejectedSection, isTeeSection, stockSectionLabel } from './rejectedSection'

describe('isTeeSection', () => {
  it('recognises a BT tee code', () => {
    expect(isTeeSection('BT100*15')).toBe(true)
    expect(isTeeSection('BT 100x15')).toBe(true)
  })

  it('treats a parent-UB label with a (T) suffix as the UB, not a tee', () => {
    expect(isTeeSection('200UB29.8 (T)')).toBe(false)
    expect(isTeeSection('100UB29.8 (T)')).toBe(false)
  })

  it('does not treat a whole UB, or another family, as a tee', () => {
    expect(isTeeSection('200UB29.8')).toBe(false)
    expect(isTeeSection('150 PFC')).toBe(false)
    expect(isTeeSection('SHS75*75*6.0')).toBe(false)
    expect(isTeeSection(null)).toBe(false)
  })
})

describe('stockSectionLabel', () => {
  it('drops the geometry detector’s (T) suffix so the parent UB is named', () => {
    expect(stockSectionLabel('200UB29.8 (T)')).toBe('200UB29.8')
    expect(stockSectionLabel('100UB29.8(T)')).toBe('100UB29.8')
    expect(stockSectionLabel('200UB29.8')).toBe('200UB29.8')
    expect(stockSectionLabel('BT100*15')).toBe('BT100*15')
  })
})

describe('isRejectedSection', () => {
  it('rejects a BT tee code, which is not a stock section', () => {
    expect(isRejectedSection({ profile: 'BT100*15', label: 'BT100*15' })).toBe(true)
  })

  it('keeps a parent-UB label even when it names a T piece', () => {
    expect(isRejectedSection({ label: '200UB29.8 (T)' })).toBe(false)
    expect(isRejectedSection({ label: '100UB29.8 (T)' })).toBe(false)
  })

  it('keeps ordinary stock sections', () => {
    expect(isRejectedSection({ profile: '200UB29.8', label: '200UB29.8' })).toBe(false)
    // A mass variant the catalogue may not carry is still a UB.
    expect(isRejectedSection({ profile: 'UB360*57', label: 'UB360*57' })).toBe(false)
    expect(isRejectedSection({ profile: 'SHS75*75*6.0', label: 'SHS75*75*6.0' })).toBe(false)
    expect(isRejectedSection({ profile: '150 PFC', label: '150 PFC' })).toBe(false)
    expect(isRejectedSection({ profile: 'EA75*75*6', label: 'EA75*75*6' })).toBe(false)
  })

  it('rejects a section it cannot recognise', () => {
    expect(isRejectedSection({ label: '—' })).toBe(true)
    expect(isRejectedSection({ profile: '', label: '' })).toBe(true)
    expect(isRejectedSection({ label: 'M_29' })).toBe(true)
    expect(isRejectedSection({ profile: 'PLT10', label: 'PLT10' })).toBe(true)
  })

  it('uses the profile when the label is absent', () => {
    expect(isRejectedSection({ profile: 'BT100*15' })).toBe(true)
    expect(isRejectedSection({ profile: '200UB29.8' })).toBe(false)
  })
})
