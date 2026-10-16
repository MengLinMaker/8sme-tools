import { describe, expect, it } from 'vitest'
import { findMaterialEntries, findSectionCode } from './pdfText'

describe('findSectionCode', () => {
  it('finds section callouts in Tekla drawing text', () => {
    expect(findSectionCode('a1  CO-7255 ... 1 a1 EA75*75*6 C300 4131')).toBe('EA75*75*6')
    expect(findSectionCode('m118 BT100*15 C300 2591')).toBe('BT100*15')
    expect(findSectionCode('m105 SHS100*100*6.0 C350 3966')).toBe('SHS100*100*6.0')
    expect(findSectionCode('m24 RHS150*100*9.0 C350 4273')).toBe('RHS150*100*9.0')
    expect(findSectionCode('m13 PFC100*50 C300 1582')).toBe('PFC100*50')
  })

  it('finds full UB and numeric-prefix channel designations', () => {
    expect(findSectionCode('200UB29.8-01 CO-7255 I 12000')).toBe('200UB29.8')
    expect(findSectionCode('150PFC C300 3000')).toBe('150PFC')
  })

  it('finds universal columns and taper flange beams', () => {
    expect(findSectionCode('m1 310UC158 C300 3000')).toBe('310UC158')
    expect(findSectionCode('m2 125 TFB C300 2500')).toBe('125TFB')
  })

  it('finds the looser RFQ forms (family, space, x-separated dims)', () => {
    expect(findSectionCode('12095, item 30, ea 200x200x20, 4 off[c]')).toBe('EA200X200X20')
    expect(findSectionCode('12095, item 33, ea 50x50x3, 2 off')).toBe('EA50X50X3')
    expect(findSectionCode('RHS 89x89x5 stock')).toBe('RHS89X89X5')
    expect(findSectionCode('shs 100x100x6.0')).toBe('SHS100X100X6.0')
  })

  it('does not mistake grades or marks for sections', () => {
    expect(findSectionCode('CO-7255 C300 M80 31A-TF1')).toBeNull()
  })
})

describe('findMaterialEntries', () => {
  it('reads MARK SECTION GRADE LENGTH Qty from the material list', () => {
    const [entry] = findMaterialEntries('m105 SHS100*100*6.0 C350 3966 4 1.48 66.32')
    expect(entry).toEqual({
      mark: 'm105',
      section: 'SHS100*100*6.0',
      grade: 'C350',
      length: 3966,
      qty: 4,
      area: 1.48,
      weight: 66.32,
    })
  })

  it('reads tee and angle rows', () => {
    expect(findMaterialEntries('1 a1 EA75*75*6 C300 4131 1 1.20 28.11')[0]).toMatchObject({
      mark: 'a1',
      section: 'EA75*75*6',
      length: 4131,
      qty: 1,
    })
    expect(findMaterialEntries('m118 BT100*15 C300 2591 1 1.19 38.84')[0]).toMatchObject({
      mark: 'm118',
      section: 'BT100*15',
      qty: 1,
    })
  })
})
