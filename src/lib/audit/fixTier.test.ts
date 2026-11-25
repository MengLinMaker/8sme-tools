import { describe, expect, it } from 'vitest'
import { AUTO_FIX_CODES, fixTierForCode, MANUAL_FIX_CODES } from './fixTier'

describe('fixTierForCode', () => {
  it('puts only codes with a computed target in the batch set', () => {
    expect([...AUTO_FIX_CODES].sort()).toEqual([
      'BEVEL_OUT_OF_RANGE',
      'CUT_CUTOUT',
      'CUT_END_PIECE',
      'CUT_ROOT_FILLET',
      'CUT_UNCLOSED',
    ])
  })

  it('keeps judgement calls out of the batch set', () => {
    // Each has a fix, but the right answer depends on the part, not on a rule.
    for (const code of [
      'STRAY_BODY',
      'MANUFACTURE_MISMATCH',
      'MANUFACTURE_BORDERLINE',
      'CUT_BEVEL_CHANGE',
    ]) {
      expect(fixTierForCode(code)).toBe('manual')
    }
  })

  it('leaves unfixable findings without a tier', () => {
    for (const code of [
      'PROFILE_MISMATCH',
      'GRADE_MISMATCH',
      'LENGTH_DIFFERENCE',
      'GEOMETRY_WEIGHT_MISMATCH',
      'CUT_DEPTH',
      'CUT_CORNER',
      'CUT_STEP',
      'STEP_INVALID',
      'PDF_INVALID',
      'QTY_UNKNOWN',
    ]) {
      expect(fixTierForCode(code)).toBeNull()
    }
  })

  it('never classifies a code in both tiers', () => {
    for (const code of AUTO_FIX_CODES) expect(MANUAL_FIX_CODES.has(code)).toBe(false)
  })
})
