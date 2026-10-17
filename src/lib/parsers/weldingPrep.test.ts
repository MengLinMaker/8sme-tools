import { existsSync, readFileSync } from 'node:fs'
import { nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseNcGeometry } from './ncGeometry'
import { MAX_BEVEL_DEG, selectWeldingPrep } from './weldingPrep'

/**
 * The DSTV AK trailing fields are a **welding preparation**, not a cut-face descriptor: up to two
 * `(φ, Y)` couples, one per side of the plate (DSTV 87 §"Welding preparation"). φ is the torch
 * angle to the vertical and is **not bounded by the head** — Tekla freely writes steep values.
 * The NC view must pick a couple the head can actually cut, never the steepest.
 */
describe('selectWeldingPrep', () => {
  it('picks the in-range side of a two-sided prep instead of the steepest', () => {
    // m119/m159 v & h faces carry (φ=45°, Y=0) plus a back-side couple at 79.4°.
    expect(selectWeldingPrep([45, 0, 79.4, 1.87]).angle).toBe(45)
    expect(selectWeldingPrep([45, 0, 79.39, 1.86]).angle).toBe(45)
  })

  it('reads a plain single-sided mitre prep', () => {
    expect(selectWeldingPrep([-20.05, 9, 0, 0]).angle).toBeCloseTo(-20.05)
    expect(selectWeldingPrep([20.05, 0, 0, 0]).angle).toBeCloseTo(20.05)
  })

  it('falls through to a valid second couple when the first is out of range', () => {
    expect(selectWeldingPrep([-55.57, 5.09, -4.5, 6.7]).angle).toBeCloseTo(-4.5)
  })

  it('returns no bevel when every couple is square or out of the head range', () => {
    expect(selectWeldingPrep([79.4, 1.87, 0, 0]).angle).toBe(0)
    expect(selectWeldingPrep([0, 0, 0, 0]).angle).toBe(0)
    expect(selectWeldingPrep(undefined).angle).toBe(0)
  })

  it('never returns an angle the head cannot cut', () => {
    for (const bevel of [
      [45, 0, 79.4, 1.87],
      [-55.57, 5.09, -4.5, 6.7],
      [53.1, 1.9, 5.71, 0],
    ]) {
      expect(Math.abs(selectWeldingPrep(bevel).angle)).toBeLessThanOrEqual(MAX_BEVEL_DEG)
    }
  })

  it('carries the Y of the selected couple, not the largest Y', () => {
    expect(selectWeldingPrep([45, 0, 79.4, 1.87]).distance).toBe(0)
    expect(selectWeldingPrep([-20.05, 9, 0, 0]).distance).toBe(9)
  })
})

describe('welding prep on real NW31-top parts', () => {
  const expected: Record<string, number> = { m119: 45, m159: 45, m24: 20.05 }
  for (const [mark, deg] of Object.entries(expected)) {
    const path = nw31Top('NC files', `${mark}.nc1`)
    it.skipIf(!existsSync(path))(`${mark} selects a ${deg}° bevel within the head range`, () => {
      const geo = parseNcGeometry(readFileSync(path, 'utf8'))
      const angles = geo.contours
        .flatMap((c) => c.bevels.map((b) => selectWeldingPrep(b).angle))
        .filter((a) => a !== 0)
      // Every rendered bevel is something the head can cut...
      expect(angles.every((a) => Math.abs(a) <= MAX_BEVEL_DEG)).toBe(true)
      // ...and the part's real prep survives (not lost to the steep back-side couple).
      expect(angles.some((a) => Math.abs(Math.abs(a) - deg) < 0.2)).toBe(true)
    })
  }
})
