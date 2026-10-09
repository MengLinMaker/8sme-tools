import { describe, expect, it } from 'vitest'
import { inferParentUb, inferTee } from './infer'

describe('inferParentUb', () => {
  it('identifies a BT100*15 T as half of a 200UB29.8', () => {
    // Real dims from the NW31 Top frames job (profile BT100*15).
    const match = inferParentUb([134, 103, 9.6, 6.3, 8.9])
    expect(match?.section.designation).toBe('200UB29.8')
    expect(match?.score).toBeGreaterThan(0)
  })

  it('distinguishes mass variants of the same nominal depth', () => {
    // Tees from 610UB125 and 460UB82.1.
    expect(inferParentUb([229, 306, 19.6, 11.9])?.section.designation).toBe('610UB125')
    expect(inferParentUb([191, 230, 16.0, 9.9])?.section.designation).toBe('460UB82.1')
  })

  it('rejects non-T sections', () => {
    expect(inferParentUb([75, 75, 6, 6, 8])).toBeNull() // equal angle EA75*75*6
    expect(inferParentUb([150, 100, 9, 9, 22.5])).toBeNull() // RHS150*100*9.0
    expect(inferParentUb([100, 50, 6.7, 4.2, 8])).toBeNull() // PFC100*50
  })

  it('needs at least four dimensions', () => {
    expect(inferParentUb([134, 103])).toBeNull()
  })
})

describe('inferTee', () => {
  it('accepts a real BT tee', () => {
    expect(inferTee('BT100*15', [134, 103, 9.6, 6.3, 8.9])?.section.designation).toBe('200UB29.8')
  })

  it('rejects hollow and channel profiles even if the dims match a UB', () => {
    // These dims fingerprint a 200UB29.8, but the named profile is not a T.
    expect(inferTee('RHS134*100*9.6', [134, 103, 9.6, 6.3, 8.9])).toBeNull()
    expect(inferTee('PFC134*100', [134, 103, 9.6, 6.3, 8.9])).toBeNull()
    expect(inferTee('SHS134*100*9.6', [134, 103, 9.6, 6.3, 8.9])).toBeNull()
  })

  it('falls back to the section fingerprint when the profile is unnamed', () => {
    expect(inferTee('', [134, 103, 9.6, 6.3, 8.9])?.section.designation).toBe('200UB29.8')
    expect(inferTee('', [150, 100, 9, 9, 22.5])).toBeNull()
  })
})
