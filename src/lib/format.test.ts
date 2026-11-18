import { describe, expect, it } from 'vitest'
import { formatMass, formatNumber } from './format'

describe('formatNumber', () => {
  it('groups thousands with the locale separator', () => {
    expect(formatNumber(26347.7, 1, 'en-AU')).toBe('26,347.7')
    expect(formatNumber(1234, 0, 'en-AU')).toBe('1,234')
  })
})

describe('formatMass', () => {
  it('keeps sub-tonne masses in kg with one decimal', () => {
    expect(formatMass(842.5, 'en-AU')).toBe('842.5 kg')
    expect(formatMass(999.9, 'en-AU')).toBe('999.9 kg')
  })

  it('switches to tonnes at a tonne and above', () => {
    expect(formatMass(1000, 'en-AU')).toBe('1.00 t')
    expect(formatMass(1050, 'en-AU')).toBe('1.05 t')
    expect(formatMass(26347.7, 'en-AU')).toBe('26.3 t')
  })
})
