import { describe, expect, it } from 'vitest'
import { compareSize } from './measure'

describe('compareSize', () => {
  it('accepts a part matching the expected size', () => {
    // Measured (length, b, d/2) roughly matches expected length 4131 and 134×103.
    expect(compareSize([4165.75, 134, 103.5], 4131, [134, 103]).ok).toBe(true)
  })

  it('flags a wrongly sized model', () => {
    expect(compareSize([4165, 200, 100], 4131, [134, 103]).ok).toBe(false)
  })

  it('is orientation-agnostic for the cross-section', () => {
    expect(compareSize([3000, 103, 134], 3000, [134, 103]).ok).toBe(true)
  })

  it('annotates multi-body models without failing the size check', () => {
    // m118-style: main body matches, but a stray surface body is present.
    const check = compareSize([2590.66, 103, 134], 2591, [134, 103], 2, true)
    expect(check.ok).toBe(true)
    expect(check.note).toContain('2 bodies')
    expect(check.note).toContain('stray')
  })
})
