import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { outlinePoints } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { detectStepSection } from '@/lib/step/readSection'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

function extents(points: [number, number][]): number[] {
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)].sort(
    (a, b) => b - a,
  )
}

function area(points: [number, number][]): number {
  return (
    Math.abs(
      points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length] as [number, number]
        return sum + point[0] * next[1] - next[0] * point[1]
      }, 0),
    ) / 2
  )
}

describe('detected STEP section matches the theoretical spec', () => {
  for (const mark of ['m137', 'm176']) {
    it(`${mark}: flange/web extents and arc-inclusive area`, async () => {
      const bytes = new Uint8Array(readFileSync(fixture('part-ir', `${mark}.stp`)))
      const guess = await detectStepSection(bytes)
      if (!guess?.outline) throw new Error('no detected section')
      const spec = partSectionForCode(guess.code, guess.dims ?? [])
      if (!spec) throw new Error('no spec section')
      const measuredExtents = extents(guess.outline.outer)
      const specExtents = extents(outlinePoints(spec?.outline))
      for (let index = 0; index < 2; index++) {
        expect(
          Math.abs((measuredExtents[index] as number) - (specExtents[index] as number)),
        ).toBeLessThan(0.5)
      }
      // Area includes the root/toe arc lengths, so it catches a wrong radius even when the
      // flange/web extents are nominal.
      const measuredArea = area(guess.outline.outer)
      const specArea = area(outlinePoints(spec?.outline))
      expect(Math.abs(measuredArea - specArea) / specArea).toBeLessThan(0.01)
    }, 120_000)
  }
})
