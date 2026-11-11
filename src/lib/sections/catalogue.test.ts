import { describe, expect, it } from 'vitest'
import { CATALOGUE_SECTIONS } from './catalogue'
import { partSectionForCode, sectionThicknesses } from './stock'

describe('CATALOGUE_SECTIONS', () => {
  it('resolves every lookup section to a drawable outline and a thickness', () => {
    for (const section of CATALOGUE_SECTIONS) {
      expect(partSectionForCode(section.code, section.dims), section.code).not.toBeNull()
      expect(sectionThicknesses(section.code, section.dims).length, section.code).toBeGreaterThan(0)
    }
  })
})
