import { describe, expect, it } from 'vitest'
import { BEVEL_PRESETS_DEG, bevelThicknessMm, CUT_TABLE_RANGE_MM, suggestCut } from './cutParams'
import { KL90010T, type MachineProfile } from './profile'

describe('suggestCut (O₂ carbon steel)', () => {
  it('matches the 5 mm research row and flips focus into the CAM sign', () => {
    const cut = suggestCut(5)
    expect(cut.powerPct).toBe(25)
    expect(cut.focusMm).toBe(4)
    expect(cut.camFocusMm).toBe(-4)
    expect(cut.heightMm).toBe(0.8)
    expect(cut.pressureBar).toBe(0.7)
    expect(cut.speedMinMmMin).toBe(3)
    expect(cut.speedMaxMmMin).toBe(3.6)
  })

  it('interpolates between rows', () => {
    const cut = suggestCut(6.3)
    expect(cut.powerPct).toBeGreaterThanOrEqual(29)
    expect(cut.powerPct).toBeLessThanOrEqual(30)
    expect(cut.focusMm).toBe(4)
  })

  it('uses the explicit 12 kW rows above 10 mm', () => {
    const cut = suggestCut(10)
    expect(cut.powerPct).toBe(50)
    expect(cut.focusMm).toBe(6)
    expect(cut.camFocusMm).toBe(-6)
    expect(cut.pressureBar).toBe(0.6)
  })

  it('clamps below the table floor and above the ceiling', () => {
    expect(suggestCut(1).thicknessMm).toBe(CUT_TABLE_RANGE_MM.min)
    expect(suggestCut(40).thicknessMm).toBe(CUT_TABLE_RANGE_MM.max)
    expect(suggestCut(1).notes.join(' ')).toContain('floor')
    expect(suggestCut(40).notes.join(' ')).toContain('ceiling')
  })

  it('keeps power above the source minimum', () => {
    expect(suggestCut(3).powerPct).toBeGreaterThanOrEqual(KL90010T.laser.minPowerPct)
  })

  it('adjusts focus and speed for surface condition', () => {
    const normal = suggestCut(6)
    const rust = suggestCut(6, 'rust')
    expect(rust.focusMm).toBeCloseTo(normal.focusMm + 1.5, 5)
    expect(rust.speedMinMmMin).toBeLessThan(normal.speedMinMmMin)
    expect(rust.notes.join(' ')).toContain('Rust')
  })

  it('honours a non-inverted controller sign', () => {
    const upright: MachineProfile = { ...KL90010T, focus: { sign: 1 } }
    const cut = suggestCut(10, 'normal', upright)
    expect(cut.camFocusMm).toBe(cut.focusMm)
  })
})

describe('shop nozzle and rotary-speed rules', () => {
  it('picks the open-section nozzle by thickness', () => {
    expect(suggestCut(5, 'rust', KL90010T, { kind: 'open' }).nozzle).toEqual({
      sizeMm: 1.5,
      type: 'single',
    })
    expect(suggestCut(15, 'rust', KL90010T, { kind: 'open' }).nozzle).toEqual({
      sizeMm: 1.5,
      type: 'single',
    })
    expect(suggestCut(16, 'rust', KL90010T, { kind: 'open' }).nozzle).toEqual({
      sizeMm: 2,
      type: 'single',
    })
  })

  it('picks the hollow-section nozzle', () => {
    expect(suggestCut(6, 'primed', KL90010T, { kind: 'hollow' }).nozzle).toEqual({
      sizeMm: 1.8,
      type: 'double',
    })
  })

  it('converts the speed range to r/min at the given radius', () => {
    const cut = suggestCut(5, 'rust', KL90010T, { kind: 'open', rotationRadiusMm: 75 })
    expect(cut.angularSpeedMinRpm).toBeCloseTo(5.5, 1)
    expect(cut.angularSpeedMaxRpm).toBeCloseTo(6.6, 1)
  })

  it('leaves nozzle and r/min unknown without context', () => {
    const cut = suggestCut(5)
    expect(cut.nozzle).toBeNull()
    expect(cut.angularSpeedMinRpm).toBeNull()
    expect(cut.angularSpeedMaxRpm).toBeNull()
  })
})

describe('one nozzle per section', () => {
  it('sizes the nozzle from the largest thickness, not the row', () => {
    const web = suggestCut(5, 'rust', KL90010T, { kind: 'open', governingThicknessMm: 16 })
    expect(web.nozzle).toEqual({ sizeMm: 2, type: 'single' })
    const flange = suggestCut(16, 'rust', KL90010T, { kind: 'open', governingThicknessMm: 16 })
    expect(flange.nozzle).toEqual({ sizeMm: 2, type: 'single' })
  })
})

describe('bevel thickness', () => {
  it('exposes square plus the weld-prep presets', () => {
    expect(BEVEL_PRESETS_DEG).toEqual([0, 15, 30, 45])
  })

  it('leaves a square cut at the nominal thickness', () => {
    expect(bevelThicknessMm(6, 0)).toBe(6)
  })

  it('follows the 1/cos path through the plate', () => {
    expect(bevelThicknessMm(6, 15)).toBeCloseTo(6.21, 2)
    expect(bevelThicknessMm(6, 30)).toBeCloseTo(6.93, 2)
    expect(bevelThicknessMm(6, 45)).toBeCloseTo(8.49, 2)
  })
})
