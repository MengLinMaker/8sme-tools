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
})
