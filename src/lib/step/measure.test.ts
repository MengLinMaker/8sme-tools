import { describe, expect, it } from 'vitest'
import {
  compareGeometry,
  compareModels,
  compareSize,
  STEEL_DENSITY_KG_PER_MM3,
  type StepMeasure,
} from './measure'

function measure(size: [number, number, number], volume: number, area = 0): StepMeasure {
  return { size, bodies: 1, extra: false, volume, area }
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

describe('compareGeometry', () => {
  // m118: drawing lists 1.19 m² / 38.84 kg; a matching STEP measures 1.2002 m² and ~38.25 kg.
  const drawing = { area: 1.19, weight: 38.84 }
  const volumeFor = (kg: number) => kg / STEEL_DENSITY_KG_PER_MM3

  it('passes when the STEP area and mass match the drawing', () => {
    const check = compareGeometry({ volume: volumeFor(38.25), area: 1_200_183 }, drawing)
    expect(check.ok).toBe(true)
    expect(check.areaOk).toBe(true)
    expect(check.massOk).toBe(true)
  })

  it('flags a surface-area mismatch', () => {
    const check = compareGeometry({ volume: volumeFor(38.25), area: 900_000 }, drawing)
    expect(check.areaOk).toBe(false)
    expect(check.ok).toBe(false)
  })

  it('flags a mass mismatch', () => {
    const check = compareGeometry({ volume: volumeFor(20), area: 1_200_183 }, drawing)
    expect(check.massOk).toBe(false)
    expect(check.ok).toBe(false)
  })

  it('skips a column the drawing omits', () => {
    const check = compareGeometry({ volume: 0, area: 0 }, {})
    expect(check.ok).toBe(true)
    expect(check.expectedArea).toBeUndefined()
    expect(check.expectedMass).toBeUndefined()
  })
})
