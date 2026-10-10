import { describe, expect, it } from 'vitest'
import { compareModels, compareSize, type StepMeasure } from './measure'

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
