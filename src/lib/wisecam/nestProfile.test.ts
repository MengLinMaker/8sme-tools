import { describe, expect, it } from 'vitest'
import type { NcexPackage } from './ncexParse'
import { MIXED_PROFILE, nestProfile, profileFromNestPath, UNKNOWN_PROFILE } from './nestProfile'

function pkgWith(name: string): NcexPackage {
  return { parts: [{ name }] } as unknown as NcexPackage
}

describe('profileFromNestPath', () => {
  it('finds the profile folder, not the filename or Weld/Other subfolders', () => {
    expect(profileFromNestPath('PFC 300x90/M40.ncexa')).toBe('PFC 300x90')
    expect(profileFromNestPath('UB 75x150/Weld/T4-25 x2.ncexa')).toBe('UB 75x150')
    expect(profileFromNestPath('SHS 75x75 T5/item 35 x2.ncexa')).toBe('SHS 75x75 T5')
    expect(profileFromNestPath('Angle 200x200 T20/item 30.ncexa')).toBe('Angle 200x200 T20')
    expect(profileFromNestPath('26 Luenard Balwyn North.ncexa')).toBeNull()
  })
})

describe('nestProfile', () => {
  it('prefers the path folder', () => {
    expect(nestProfile('PFC 250x90/M38.ncexa', pkgWith('M_38'))).toBe('PFC 250x90')
  })

  it('falls back to the part-name section and flags mixed/unknown', () => {
    expect(nestProfile('nests/M38.ncexa', pkgWith('12095, ITEM 5, PFC 150, 1 OFF[C]'))).toContain(
      'PFC',
    )
    expect(
      nestProfile('nests/mixed.ncexa', {
        parts: [{ name: 'SHS 75x75x6' }, { name: '200UB25' }],
      } as unknown as NcexPackage),
    ).toBe(MIXED_PROFILE)
    expect(nestProfile('nests/unknown.ncexa', pkgWith('M_29'))).toBe(UNKNOWN_PROFILE)
  })
})
