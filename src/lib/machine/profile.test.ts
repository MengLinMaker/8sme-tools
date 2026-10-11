import { describe, expect, it } from 'vitest'
import {
  bevelAllowed,
  envelopeFits,
  KL90010T,
  MACHINE,
  stockLengthAllowed,
} from '@/lib/machine/profile'

describe('KL-90010-T machine profile', () => {
  it('exposes the documented envelope', () => {
    expect(KL90010T.envelope.maxLengthMm).toBe(13_500)
    expect(KL90010T.envelope.maxRoundMm).toBe(900)
    expect(KL90010T.envelope.maxSquareMm).toBe(400)
    expect(KL90010T.envelope.hBeam).toEqual({ depthMm: 800, flangeMm: 300 })
    expect(KL90010T.envelope.maxThicknessMm).toBe(25)
    expect(KL90010T.bevel).toEqual({ minDeg: -45, maxDeg: 45 })
    expect(KL90010T.bottomCutMaxGrams).toBe(10)
    expect(KL90010T.unmachinableDepthMm).toBe(30)
    expect(KL90010T.defaultStockLengthMm).toBe(12_000)
  })

  it('defaults checks to the workshop machine', () => {
    expect(MACHINE).toBe(KL90010T)
    expect(envelopeFits({ roundMm: 900 })).toBe(true)
    expect(bevelAllowed(45)).toBe(true)
    expect(stockLengthAllowed(13_500)).toBe(true)
  })
})

describe('envelopeFits', () => {
  it('ignores omitted fields', () => {
    expect(envelopeFits({})).toBe(true)
    expect(envelopeFits({ roundMm: 200 })).toBe(true)
  })

  it('is inclusive at each limit and false just past it', () => {
    expect(envelopeFits({ lengthMm: 13_500 })).toBe(true)
    expect(envelopeFits({ lengthMm: 13_501 })).toBe(false)
    expect(envelopeFits({ roundMm: 900 })).toBe(true)
    expect(envelopeFits({ roundMm: 901 })).toBe(false)
    expect(envelopeFits({ squareMm: 400 })).toBe(true)
    expect(envelopeFits({ squareMm: 401 })).toBe(false)
    expect(envelopeFits({ thicknessMm: 25 })).toBe(true)
    expect(envelopeFits({ thicknessMm: 26 })).toBe(false)
  })

  it('checks H-beam depth and flange independently', () => {
    expect(envelopeFits({ hBeam: { depthMm: 800, flangeMm: 300 } })).toBe(true)
    expect(envelopeFits({ hBeam: { depthMm: 801, flangeMm: 300 } })).toBe(false)
    expect(envelopeFits({ hBeam: { depthMm: 800, flangeMm: 301 } })).toBe(false)
    expect(envelopeFits({ hBeam: { depthMm: 300, flangeMm: 800 } })).toBe(false)
  })
})

describe('bevelAllowed', () => {
  it('allows the inclusive -45…+45 band', () => {
    expect(bevelAllowed(0)).toBe(true)
    expect(bevelAllowed(45)).toBe(true)
    expect(bevelAllowed(-45)).toBe(true)
    expect(bevelAllowed(45.1)).toBe(false)
    expect(bevelAllowed(-45.1)).toBe(false)
  })
})

describe('stockLengthAllowed', () => {
  it('is the single-pass length cap', () => {
    expect(stockLengthAllowed(12_000)).toBe(true)
    expect(stockLengthAllowed(13_500)).toBe(true)
    expect(stockLengthAllowed(13_501)).toBe(false)
  })
})
