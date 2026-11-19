import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hexModuleFrames } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { partSectionForCode } from '@/lib/sections/stock'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { detectStepSection } from '@/lib/step/readSection'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/** The ghost radius should follow the drawing: item35's SHS75*75*6 models a 10 mm outer corner. */
describe('measured hollow radius', () => {
  it('reads the radius back from the outline', async () => {
    const guess = await detectStepSection(
      new Uint8Array(readFileSync(hexModuleFrames('item35.stp'))),
    )
    console.log(`[hs] item35 ${guess?.code} dims ${JSON.stringify(guess?.dims)}`)
    expect(guess?.code).toBe('SHS75*75*6.0')
    // dims[4] is the corner radius; the part models 10 mm, not the standard 2.5t = 15.
    expect(guess?.dims?.[4] ?? 0).toBeCloseTo(10, 0)

    // The ghost's outline must use that radius, not the standard 2.5t.
    const section = partSectionForCode(guess?.code ?? '', guess?.dims ?? [])
    const points = section?.points ?? []
    const xs = points.map(([x]) => x)
    const ys = points.map(([, y]) => y)
    const width = Math.max(...xs) - Math.min(...xs)
    const height = Math.max(...ys) - Math.min(...ys)
    let twice = 0
    for (let i = 0; i < points.length; i++) {
      const a = points[i] as [number, number]
      const b = points[(i + 1) % points.length] as [number, number]
      twice += a[0] * b[1] - b[0] * a[1]
    }
    const area = Math.abs(twice) / 2
    const radius = Math.sqrt(Math.max(0, (width * height - area) / (4 - Math.PI)))
    console.log(`[hs] ghost radius ${radius.toFixed(2)} (standard 2.5t would be 15)`)
    expect(radius).toBeCloseTo(10, 0)
  }, 300_000)
})
