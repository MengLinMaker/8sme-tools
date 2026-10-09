import { createRequire } from 'node:module'
import { importSTEP } from 'replicad'
import { describe, expect, it } from 'vitest'
import { getUb } from '@/lib/sections/ub'
import { type BarPiece, buildUbBarStep, inspectStepBodies } from './occ'
import { setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * Internal validator: generate a nested-UB STEP, load it back through OpenCASCADE, and check it
 * is a UB with the expected width, depth and length. Tabs are off for now, so each part is written
 * as its own solid body.
 */
describe('generated UB STEP', () => {
  it('measures as a UB with the right dimensions', async () => {
    const section = getUb('200UB29.8')
    expect(section).toBeDefined()
    if (!section) return

    const left: BarPiece[] = [
      { mark: 'm1', length: 3000 },
      { mark: 'm2', length: 2000 },
      { mark: 'm3', length: 1000 },
    ]
    const right: BarPiece[] = [{ mark: 'm4', length: 3000 }]
    const kerf = 3
    const step = await buildUbBarStep({ section, name: 'validate', left, right, kerf })

    const shape = await importSTEP(new Blob([step], { type: 'model/step' }))
    const [min, max] = shape.boundingBox.bounds
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    const total = (pieces: BarPiece[]) =>
      pieces.reduce((sum, p, i) => sum + p.length + (i > 0 ? kerf : 0), 0)

    const meshed = (shape as unknown as { mesh: () => { triangles: number[] } }).mesh()
    expect(meshed.triangles.length).toBeGreaterThan(0)

    const solids = (step.match(/MANIFOLD_SOLID_BREP/g) ?? []).length
    // eslint-disable-next-line no-console
    console.log(`\nsolids=${solids} bbox=${size.map((v) => v.toFixed(1)).join('x')}`)
    expect(solids).toBe(left.length + right.length)

    // One product (no assembly).
    expect(step.match(/PRODUCT\(/g) ?? []).toHaveLength(1)
    expect(step).not.toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE')

    expect(step).toContain('AUTOMOTIVE_DESIGN')
    expect(size[0]).toBeCloseTo(section.b, 0) // width across (X)
    expect(size[1]).toBeCloseTo(section.d, 0) // depth (Y)
    expect(size[2]).toBeCloseTo(Math.max(total(left), total(right)), 0) // length (Z)
  }, 180000)

  it('lists each part body for debugging', async () => {
    const section = getUb('200UB29.8')
    if (!section) return
    const left: BarPiece[] = [
      { mark: 'm1', length: 3000 },
      { mark: 'm2', length: 2000 },
    ]
    const right: BarPiece[] = [{ mark: 'm3', length: 4000 }]
    const step = await buildUbBarStep({ section, name: 'touch', left, right, kerf: 0 })
    expect(step.match(/MANIFOLD_SOLID_BREP/g) ?? []).toHaveLength(3)

    const bodies = await inspectStepBodies(new TextEncoder().encode(step))
    expect(bodies).toHaveLength(3)
    expect(bodies[0]?.size[0]).toBeCloseTo(section.b, 0)
  }, 180000)
})
