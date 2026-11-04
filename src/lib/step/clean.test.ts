import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { cleanStep } from './clean'
import { ensureOc, setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const STP = nw31Top('STP files')
const HAVE = existsSync(join(STP, 'm118.stp'))

async function size(bytes: Uint8Array): Promise<number[]> {
  const { importSTEP } = await import('replicad')
  const shape = await importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' }))
  const [min, max] = (shape as { boundingBox: { bounds: [number[], number[]] } }).boundingBox.bounds
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
}

describe.skipIf(!HAVE)('cleanStep', () => {
  it('drops a floating sliver and keeps the real body', async () => {
    const result = await cleanStep(new Uint8Array(readFileSync(join(STP, 'm118.stp'))))
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.removed).toBe(1)
    expect(result.kept).toBe(1)
    // cleaned model is just the real body (the sliver inflated the bbox by ~19 mm)
    const [x] = await size(result.bytes)
    expect(x).toBeCloseTo(2590.66, 0)
  }, 300000)

  it('returns null when a part has no stray bodies', async () => {
    // m143 is a clean single-body T
    const result = await cleanStep(new Uint8Array(readFileSync(join(STP, 'm143.stp'))))
    expect(result).toBeNull()
  }, 300000)

  it('does not wipe a model that only contains a degenerate body', async () => {
    const result = await cleanStep(new Uint8Array(readFileSync(join(STP, 'm170.stp'))))
    // m170 has a single sliver: nothing to remove, and nothing should be lost silently
    expect(result).toBeNull()
  }, 300000)

  it('drops a large stray body, keeping only the main solid', async () => {
    await ensureOc()
    const { makeBox, compoundShapes } = await import('replicad')
    const main = makeBox([0, 0, 0], [100, 50, 20])
    const stray = makeBox([0, 0, 0], [10, 10, 10]).translate(200, 0, 0)
    const compound = compoundShapes([main, stray])
    const bytes = new Uint8Array(
      await (compound as unknown as { blobSTEP: () => Blob }).blobSTEP().arrayBuffer(),
    )

    const result = await cleanStep(bytes)
    expect(result?.kept).toBe(1)
    expect(result?.removed).toBe(1)
    const [x] = await size(result?.bytes ?? new Uint8Array())
    expect(x).toBeCloseTo(100, 0)
  }, 300000)

  it('punches a hole capped by a thin skin', async () => {
    await ensureOc()
    const { makeBox, makeCylinder, importSTEP, measureVolume } = await import('replicad')
    const plate = makeBox([0, 0, 0], [100, 50, 10])
    const blind = makeCylinder(5, 9, [50, 25, 0], [0, 0, 1])
    const part = plate.cut(blind)
    const bytes = new Uint8Array(await part.blobSTEP().arrayBuffer())

    const result = await cleanStep(bytes)
    expect(result?.opened).toBe(1)
    if (!result) return

    const cleaned = await importSTEP(
      new Blob([new Uint8Array(result.bytes)], { type: 'model/step' }),
    )
    // The punch cuts slightly oversize (0.1 mm radius) to avoid a coincident bore wall, so the
    // hole is the nominal through-hole within a few mm³.
    expect(measureVolume(cleaned as never)).toBeCloseTo(100 * 50 * 10 - Math.PI * 25 * 10, -1)
    cleaned.delete()
  }, 300000)
})
