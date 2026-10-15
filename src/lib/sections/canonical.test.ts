import { describe, expect, it } from 'vitest'
import {
  BOTTOM_CUT_MAX_GRAMS,
  bottomCutAllowed,
  CUT_FACES,
  cutPriority,
  faceRole,
  holeRemovedMassGrams,
  profileFamily,
  removedMassGrams,
} from './canonical'

describe('profileFamily', () => {
  it('classifies the common job codes', () => {
    expect(profileFamily('200UB29.8')).toBe('i')
    expect(profileFamily('310UC158')).toBe('i')
    expect(profileFamily('125TFB')).toBe('i')
    expect(profileFamily('PFC100*50')).toBe('channel')
    expect(profileFamily('150PFC')).toBe('channel')
    expect(profileFamily('RHS150*100*9.0')).toBe('tube')
    expect(profileFamily('SHS100*100*6.0')).toBe('tube')
    expect(profileFamily('BT100*15')).toBe('tee')
    expect(profileFamily('EA75*75*6')).toBe('angle')
    expect(profileFamily('UA100*75*6')).toBe('angle')
    expect(profileFamily('CHS114.3*5.4')).toBe('round')
  })

  it('returns null for non-sections', () => {
    expect(profileFamily('C300')).toBeNull()
    expect(profileFamily('')).toBeNull()
  })
})

describe('faceRole', () => {
  it('an I in H stance has top/bottom flanges and side webs', () => {
    expect(faceRole('i', 'o')).toBe('top')
    expect(faceRole('i', 'u')).toBe('bottom')
    expect(faceRole('i', 'v')).toBe('side')
    expect(faceRole('i', 'h')).toBe('side')
  })

  it('a channel in n stance puts the flange faces on the sides and the web (h) on top', () => {
    expect(faceRole('channel', 'o')).toBe('side')
    expect(faceRole('channel', 'u')).toBe('side')
    expect(faceRole('channel', 'h')).toBe('top')
    expect(faceRole('channel', 'v')).toBe('bottom')
  })

  it('a tube in the long-horizontal stance puts the short faces on the sides and v/h flat', () => {
    // Tekla authors an RHS long-side-vertical; seated long-horizontal the short `o`/`u` become the
    // two sides and the long `v`/`h` become bottom/top.
    expect(faceRole('tube', 'o')).toBe('side')
    expect(faceRole('tube', 'u')).toBe('side')
    expect(faceRole('tube', 'v')).toBe('bottom')
    expect(faceRole('tube', 'h')).toBe('top')
  })

  it('ranks side cuts ahead of top, and top ahead of bottom', () => {
    // I: o = top (1), v = side (0), u = bottom (2).
    expect(cutPriority('i', 'v')).toBeLessThan(cutPriority('i', 'o'))
    expect(cutPriority('i', 'o')).toBeLessThan(cutPriority('i', 'u'))
    // Channel: both flanges are sides — the preferred cut.
    expect(cutPriority('channel', 'o')).toBe(0)
    expect(cutPriority('channel', 'u')).toBe(0)
  })
})

describe('CUT_FACES', () => {
  it('extracts the sides + top by default', () => {
    expect(CUT_FACES.i).toEqual(['o', 'u', 'h'])
    expect(CUT_FACES.channel).toEqual(['o', 'u', 'h'])
    expect(CUT_FACES.tee).toEqual(['o', 'u', 'h'])
  })

  it('drops o and v for an angle', () => {
    expect(CUT_FACES.angle).toEqual(['u', 'h'])
  })
})

describe('bottom-cut mass guard', () => {
  it('uses 7850 kg/m³', () => {
    // 1 mm² × 1000 mm = 1000 mm³ of steel ≈ 7.85 g
    expect(removedMassGrams(1, 1000)).toBeCloseTo(7.85, 2)
  })

  it('calibrates the 10 g threshold on real holes', () => {
    // Ø14 through a 9.6 mm flange ≈ 11.6 g — too heavy for a bottom drop.
    expect(holeRemovedMassGrams(14, 9.6)).toBeGreaterThan(BOTTOM_CUT_MAX_GRAMS)
    expect(bottomCutAllowed(holeRemovedMassGrams(14, 9.6))).toBe(false)
    // Ø10 through 9.6 mm ≈ 5.9 g — fine.
    expect(holeRemovedMassGrams(10, 9.6)).toBeLessThan(BOTTOM_CUT_MAX_GRAMS)
    expect(bottomCutAllowed(holeRemovedMassGrams(10, 9.6))).toBe(true)
  })

  it('honours an explicit threshold', () => {
    expect(bottomCutAllowed(20, 25)).toBe(true)
    expect(bottomCutAllowed(30, 25)).toBe(false)
  })
})
