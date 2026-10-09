import { describe, expect, it } from 'vitest'
import { findSectionCode } from './pdfText'

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

  it('does not mistake grades or marks for sections', () => {
    expect(findSectionCode('CO-7255 C300 M80 31A-TF1')).toBeNull()
  })
})
