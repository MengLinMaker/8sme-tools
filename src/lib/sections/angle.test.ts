import { describe, expect, it } from 'vitest'
import { angleDesignation, EQUAL_ANGLES, getAngle, UNEQUAL_ANGLES } from './angle'

describe('angle catalogue', () => {
  it('carries both the root and toe radius for every entry', () => {
    for (const angle of [...EQUAL_ANGLES, ...UNEQUAL_ANGLES]) {
      expect(angle.r1).toBeGreaterThan(0)
      expect(angle.r2).toBeGreaterThan(0)
      expect(angle.t).toBeLessThanOrEqual(angle.tNom)
      expect(angle.kind === 'EA' ? angle.a === angle.b : angle.a > angle.b).toBe(true)
    }
  })

  it('matches an equal angle on its nominal thickness', () => {
    const angle = getAngle('EA', 75, 75, 6)
    expect(angle && angleDesignation(angle)).toBe('EA75*75*6')
    expect(angle).toMatchObject({ t: 6, r1: 8, r2: 5, mass: 6.81 })
  })

  it('matches on the rolled thickness as well as the nominal one', () => {
    // A 150x150x10 is rolled at t = 9.5, so both 10 and 9.5 must resolve the same section.
    expect(getAngle('EA', 150, 150, 10)?.r2).toBe(5)
    expect(getAngle('EA', 150, 150, 9.5)?.tNom).toBe(10)
  })

  it('matches an unequal angle', () => {
    expect(getAngle('UA', 100, 75, 6)).toMatchObject({ t: 6, r1: 8, r2: 5, mass: 7.98 })
  })

  it('returns undefined for a non-standard size', () => {
    expect(getAngle('EA', 70, 70, 6)).toBeUndefined()
    expect(getAngle('EA', 75, 75, 7)).toBeUndefined()
  })
})
