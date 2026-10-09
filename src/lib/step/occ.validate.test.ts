import { createRequire } from 'node:module'
import { importSTEP } from 'replicad'
import { describe, expect, it } from 'vitest'
import { getUb } from '@/lib/sections/ub'
import { buildUbBarStep } from './occ'
import { setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * Internal validator: generate a nested-UB STEP, load it back through OpenCASCADE,
 * and check it is a UB with the expected width, depth and length.
 */
describe('generated UB STEP', () => {
  it('measures as a UB with the right dimensions', async () => {
    const section = getUb('200UB29.8')
    expect(section).toBeDefined()
    if (!section) return

    const left = [3000, 2000, 1000]
    const right = [3000]
    const kerf = 3
    const step = await buildUbBarStep({ section, name: 'validate', left, right, kerf })

    const shape = await importSTEP(new Blob([step], { type: 'model/step' }))
    const [min, max] = shape.boundingBox.bounds
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    const total = (lengths: number[]) =>
      lengths.reduce((sum, l, i) => sum + l + (i > 0 ? kerf : 0), 0)

    const meshed = (shape as unknown as { mesh: () => { triangles: number[] } }).mesh()
    // eslint-disable-next-line no-console
    console.log(`\ntriangles=${meshed.triangles.length / 9}`)
    expect(meshed.triangles.length).toBeGreaterThan(0)

    // eslint-disable-next-line no-console
    console.log(`\nbbox size [x,y,z] = ${size.map((v) => v.toFixed(1)).join(' x ')}`)
    // eslint-disable-next-line no-console
    console.log(
      `expected width=${section.b} depth=${section.d} length=${Math.max(total(left), total(right))}`,
    )

    expect(step).toContain('AUTOMOTIVE_DESIGN')
    expect(size[0]).toBeCloseTo(section.b, 0) // width across (X)
    expect(size[1]).toBeCloseTo(section.d, 0) // depth (Y)
    expect(size[2]).toBeCloseTo(Math.max(total(left), total(right)), 0) // length (Z)
  }, 180000)
})
