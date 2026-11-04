import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { ensureOc, setOcWasmUrl } from './occInit'
import { repairStep } from './repair'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

describe('repairStep', () => {
  it('re-drills a feature hole that the clean base lacks', async () => {
    await ensureOc()
    const { makeBox, makeCylinder, importSTEP, measureVolume } = await import('replicad')
    const base = makeBox([0, 0, 0], [100, 50, 20])
    const feature = base.cut(makeCylinder(5, 40, [50, 25, -10], [0, 0, 1]))

    const bytesOf = async (shape: typeof base) =>
      new Uint8Array(await shape.blobSTEP().arrayBuffer())

    const result = await repairStep(await bytesOf(base), await bytesOf(feature))
    expect(result.redrilled).toBe(1)
    expect(result.valid).toBe(true)

    const repaired = await importSTEP(
      new Blob([new Uint8Array(result.bytes)], { type: 'model/step' }),
    )
    expect(measureVolume(repaired as never)).toBeCloseTo(100 * 50 * 20 - Math.PI * 25 * 20, 0)
    repaired.delete()
  }, 300000)
})
