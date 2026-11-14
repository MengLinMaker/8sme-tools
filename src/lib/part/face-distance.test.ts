import { describe, expect, it } from 'vitest'
import { faceHalf, faceSpanAxis, frameForProfile } from '@/lib/parsers/ncFaces'
import { partSectionForCode } from '@/lib/sections/stock'
import { centeredStationFor, unrolledLayout } from '@/lib/wisecam/layout'

const CASES = [
  ['PFC100*50', [100, 50, 6.7, 4.2, 8], 'U'],
  ['RHS150*100*9.0', [150, 100, 9, 9, 22.5], 'M'],
  ['SHS100*100*6.0', [100, 100, 6, 6, 15], 'M'],
  ['200UB29.8', [207, 134, 9.6, 6.3, 8.9], 'I'],
] as const

describe('per-face distance invariant', () => {
  for (const [profile, dimensions, type] of CASES) {
    it(`${profile}: mapped face span equals the spec developed length`, () => {
      const section = partSectionForCode(profile, [...dimensions])
      const layout = unrolledLayout(type, [...dimensions])
      if (!section || !layout) throw new Error('no section/layout')
      const frame = frameForProfile(profile, section.points)
      for (const face of ['v', 'o', 'u', 'h'] as const) {
        const region = layout.faces[face]
        if (!region) continue
        const spanAxis = faceSpanAxis(frame, face)
        const width = faceHalf(frame, spanAxis) * 2
        // The frame's face width and the layout region width are the same section distance.
        expect(Math.abs(width - (region.width ?? region.length))).toBeLessThan(0.01)
        const start = centeredStationFor(layout, face, 0)
        const end = centeredStationFor(layout, face, region.width ?? region.length)
        if (start == null || end == null) continue
        // Flat: scale 1. Rounded: the arc-unrolled developed length.
        expect(Math.abs(Math.abs(end - start) - region.length)).toBeLessThan(0.01)
      }
    })
  }
})
