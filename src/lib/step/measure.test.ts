import { describe, expect, it } from 'vitest'
import {
  compareGeometry,
  compareModels,
  compareSize,
  STEEL_DENSITY_KG_PER_MM3,
  type StepMeasure,
  stepOnlySizeCheck,
} from './measure'

function measure(size: [number, number, number], volume: number): StepMeasure {
  return { size, bodies: 1, extra: false, volume }
}

describe('compareModels', () => {
  it('matches a size- and volume-equivalent model regardless of orientation', () => {
    const step = measure([2591, 134, 103], 3_500_000)
    const made = measure([103, 2590, 134], 3_550_000)
    expect(compareModels(step, made).ok).toBe(true)
  })

  it('flags a size mismatch', () => {
    const step = measure([2591, 134, 103], 3_500_000)
    const made = measure([2591, 200, 103], 3_500_000)
    expect(compareModels(step, made).ok).toBe(false)
  })

  it('flags a volume mismatch beyond the rebuild slack', () => {
    const step = measure([2591, 134, 103], 3_500_000)
    const made = measure([2591, 134, 103], 3_000_000)
    const result = compareModels(step, made)
    expect(result.ok).toBe(false)
    expect(result.volumeOk).toBe(false)
    expect(result.volumeDelta).toBeLessThan(0)
  })
})

describe('compareSize', () => {
  it('accepts a part matching the expected size', () => {
    // Measured (length, b, d/2) roughly matches expected length 4131 and 134×103.
    expect(compareSize([4165.75, 134, 103.5], 4131, [134, 103]).ok).toBe(true)
  })

  it('flags a wrongly sized model', () => {
    expect(compareSize([4165, 200, 100], 4131, [134, 103]).ok).toBe(false)
  })

  it('is orientation-agnostic for the cross-section', () => {
    expect(compareSize([3000, 103, 134], 3000, [134, 103]).ok).toBe(true)
  })

  it('annotates multi-body models without failing the size check', () => {
    // m118-style: main body matches, but a stray surface body is present.
    const check = compareSize([2590.66, 103, 134], 2591, [134, 103], 2, true)
    expect(check.ok).toBe(true)
    expect(check.bodies).toBe(2)
    expect(check.stray).toBe(true)
  })
})

describe('stepOnlySizeCheck', () => {
  it('reports the measured extents length-first when there is no expected size', () => {
    const check = stepOnlySizeCheck({ size: [134, 2591, 103], bodies: 1, extra: false, volume: 0 })
    expect(check.error).toBe('stepOnly')
    expect(check.measured).toEqual([2591, 134, 103])
    expect(check.ok).toBe(false)
  })

  it('carries the body count and stray flag through', () => {
    const check = stepOnlySizeCheck({ size: [100, 100, 100], bodies: 2, extra: true, volume: 0 })
    expect(check.bodies).toBe(2)
    expect(check.stray).toBe(true)
  })
})

describe('compareGeometry', () => {
  // m118 (a solid T): drawing lists 38.84 kg; a matching STEP measures ~38.25 kg.
  const drawing = { weight: 38.84 }
  const volumeFor = (kg: number) => kg / STEEL_DENSITY_KG_PER_MM3

  it('passes when the STEP mass matches the drawing', () => {
    const check = compareGeometry({ volume: volumeFor(38.25) }, drawing)
    expect(check.ok).toBe(true)
    expect(check.massOk).toBe(true)
  })

  it('flags a mass mismatch', () => {
    const check = compareGeometry({ volume: volumeFor(20) }, drawing)
    expect(check.massOk).toBe(false)
    expect(check.ok).toBe(false)
  })

  it('skips the check when the drawing omits the weight', () => {
    const check = compareGeometry({ volume: 0 }, {})
    expect(check.ok).toBe(true)
    expect(check.expectedMass).toBeUndefined()
  })
})
