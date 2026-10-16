import { describe, expect, it } from 'vitest'
import { inferSectionFromCross } from './detect'
import { partSectionForCode } from './stock'

/** Feeds a catalogue section's own outline back through the detector — a closed-loop check. */
function detect(code: string, dims: number[] = []) {
  const section = partSectionForCode(code, dims)
  expect(section, `no outline for ${code}`).not.toBeNull()
  if (!section) return null
  return inferSectionFromCross({ outer: section.points, holes: section.holes })
}

describe('inferSectionFromCross', () => {
  it('matches universal beams', () => {
    expect(detect('200UB29.8')?.code).toBe('200UB29.8')
    expect(detect('460UB82.1')?.code).toBe('460UB82.1')
  })

  it('matches universal columns', () => {
    expect(detect('310UC158')?.family).toBe('uc')
    expect(detect('310UC158')?.code).toBe('310UC158')
  })

  it('matches channels and taper flange beams as drawing callouts', () => {
    expect(detect('100 PFC')?.family).toBe('pfc')
    expect(detect('100 PFC')?.code).toBe('PFC100*50')
    expect(detect('300 PFC')?.code).toBe('PFC300*90')
    expect(detect('125 TFB')?.code).toBe('125TFB')
  })

  it('distinguishes an equal angle from the tee of the same bounding box', () => {
    const angle = detect('EA75*75*6')
    expect(angle?.family).toBe('angle')
    expect(angle?.code).toBe('EA75*75*6')
  })

  it('carries the real measured outline (for a flush STEP-only ghost)', () => {
    const guess = detect('EA75*75*6')
    expect(guess?.outline?.outer.length).toBeGreaterThan(2)
    const hollow = detect('SHS100*100*6.0')
    expect(hollow?.outline?.outer.length).toBeGreaterThan(2)
    expect(hollow?.outline?.holes?.length).toBe(1)
  })

  it('matches large equal angles', () => {
    expect(detect('EA200*200*20')?.family).toBe('angle')
    expect(detect('EA200*200*20')?.code).toBe('EA200*200*20')
  })

  it('resolves a T back to its parent UB', () => {
    const section = partSectionForCode('BT', [134, 103.5, 9.6, 6.3, 8.9])
    expect(section).not.toBeNull()
    if (!section) return
    const guess = inferSectionFromCross({ outer: section.points })
    expect(guess?.family).toBe('tee')
    expect(guess?.label).toContain('200UB29.8')
  })

  it('reconstructs square, rectangular and circular hollows as callouts', () => {
    expect(detect('SHS100*100*6.0')?.code).toBe('SHS100*100*6.0')
    expect(detect('RHS150*100*9.0')?.code).toBe('RHS150*100*9.0')
    expect(detect('CHS100*6')?.code).toBe('CHS100*6.0')
  })

  it('rounds a reconstructed hollow callout (no float noise)', () => {
    // A sampled 75 mm square carries ~1e-9 bbox noise — the callout must read clean.
    const noisy: [number, number][] = [
      [75.00000000000068, 74.99999999999909],
      [75.00000000000068, 0],
      [0, 0],
      [0, 74.99999999999909],
    ]
    const inner: [number, number][] = [
      [70, 5],
      [70, 70],
      [5, 70],
      [5, 5],
    ]
    const guess = inferSectionFromCross({ outer: noisy, holes: [inner] })
    expect(guess?.code).toBe('SHS75*75*5.0')
    expect(guess?.label).not.toMatch(/\d\.\d{6,}/)
  })
})
