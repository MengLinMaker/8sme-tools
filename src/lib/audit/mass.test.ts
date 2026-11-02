import { describe, expect, it } from 'vitest'
import { massBand } from './mass'

describe('massBand', () => {
  it('bands a per-piece mass at the documented limits', () => {
    expect(massBand(30.1)).toBe('red')
    expect(massBand(30)).toBe('yellow')
    expect(massBand(20)).toBe('yellow')
    expect(massBand(19.9)).toBe('green')
  })

  it('returns null when the mass is unknown', () => {
    expect(massBand(null)).toBeNull()
    expect(massBand(undefined)).toBeNull()
    expect(massBand(Number.NaN)).toBeNull()
  })
})
