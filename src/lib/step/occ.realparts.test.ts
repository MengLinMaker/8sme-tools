import { createRequire } from 'node:module'
import { importSTEP } from 'replicad'
import { describe, expect, it } from 'vitest'
import { getUb } from '@/lib/sections/ub'
import { type BarPiece, buildUbBarStep } from './occ'
import { ensureOc, setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * Exercises the real-part path (imported STEP bytes, orientation, tight packing) and checks the
 * parts keep their correct size/position in the beam.
 */
describe('generated UB STEP from real part files', () => {
  it('places real STEP parts at the right size', async () => {
    await ensureOc()
    const { draw } = await import('replicad')
    const section = getUb('200UB29.8')
    expect(section).toBeDefined()
    if (!section) return
    const hd = section.d / 2
    const hw = section.tw / 2

    const makeTee = async (sign: number, length: number): Promise<Uint8Array> => {
      const profile: [number, number][] = [
        [-hw, 0],
        [hw, 0],
        [hw, sign * (hd - section.tf)],
        [section.b / 2, sign * (hd - section.tf)],
        [section.b / 2, sign * hd],
        [-section.b / 2, sign * hd],
        [-section.b / 2, sign * (hd - section.tf)],
        [-hw, sign * (hd - section.tf)],
      ]
      let pen = draw(profile[0])
      for (let i = 1; i < profile.length; i++) pen = pen.lineTo(profile[i])
      const solid = pen.close().sketchOnPlane('XY').extrude(length)
      const blob = (solid as unknown as { blobSTEP: () => Blob }).blobSTEP()
      return new Uint8Array(await blob.arrayBuffer())
    }

    const left: BarPiece[] = [
      { mark: 'T1', length: 3000, bytes: await makeTee(1, 3000) },
      { mark: 'T2', length: 2000, bytes: await makeTee(1, 2000) },
      { mark: 'T3', length: 1000, bytes: await makeTee(1, 1000) },
    ]
    const right: BarPiece[] = [
      { mark: 'T4', length: 2500, bytes: await makeTee(-1, 2500) },
      { mark: 'T5', length: 1500, bytes: await makeTee(-1, 1500) },
    ]
    const step = await buildUbBarStep({ section, name: 'real', left, right, kerf: 3 })

    const bodies = (step.match(/MANIFOLD_SOLID_BREP/g) ?? []).length
    // eslint-disable-next-line no-console
    console.log(`\nreal-parts bodies=${bodies}`)
    expect(bodies).toBe(left.length + right.length)

    const shape = await importSTEP(new Blob([step], { type: 'model/step' }))
    const [min, max] = shape.boundingBox.bounds
    expect(max[0] - min[0]).toBeCloseTo(section.b, 0)
    expect(max[1] - min[1]).toBeCloseTo(section.d, 0)
  }, 180000)
})
