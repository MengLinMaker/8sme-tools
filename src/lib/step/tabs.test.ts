import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chsLeg, fixtureExists } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { ensureOc, setOcWasmUrl } from './occInit'
import { tabStep } from './tabs'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const CHS = chsLeg('7347-18m-Leg-Nest-11980.stp')
const HAVE_CHS = fixtureExists('chs', '7347-18m-Leg-Nest-11980.stp')

async function stepBytes(shapes: unknown[]): Promise<Uint8Array> {
  const { compoundShapes } = await import('replicad')
  const compound = compoundShapes(shapes as never)
  return new Uint8Array(
    await (compound as unknown as { blobSTEP: () => Blob }).blobSTEP().arrayBuffer(),
  )
}

async function bodyCount(bytes: Uint8Array): Promise<number> {
  const { importSTEP } = await import('replicad')
  const shape = await importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' }))
  const count = shape.solids?.length ?? 0
  shape.delete()
  return count
}

async function bounds(bytes: Uint8Array): Promise<[number[], number[]]> {
  const { importSTEP } = await import('replicad')
  const shape = await importSTEP(new Blob([new Uint8Array(bytes)], { type: 'model/step' }))
  const bounds = (shape as unknown as { boundingBox: { bounds: [number[], number[]] } }).boundingBox
    .bounds
  shape.delete()
  return [bounds[0], bounds[1]]
}

describe('tabStep', () => {
  it('returns null for a single-body STEP', async () => {
    await ensureOc()
    const { makeBox } = await import('replicad')
    const bytes = await stepBytes([makeBox([0, 0, 0], [100, 50, 100])])
    expect(await tabStep(bytes, { density: 2 })).toBeNull()
  }, 300000)

  it('joins end-to-end bodies into one solid', async () => {
    await ensureOc()
    const { makeBox } = await import('replicad')
    const bytes = await stepBytes([
      makeBox([0, 0, 0], [100, 50, 100]),
      makeBox([0, 0, 105], [100, 50, 205]),
    ])
    const result = await tabStep(bytes, { density: 2 })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.pieces).toBe(2)
    expect(result.tabs).toBeGreaterThanOrEqual(1)
    expect(await bodyCount(result.bytes)).toBe(1)
    const [beforeMin, beforeMax] = await bounds(bytes)
    const [afterMin, afterMax] = await bounds(result.bytes)
    for (let axis = 0; axis < 3; axis++) {
      expect(afterMin[axis]).toBeCloseTo(beforeMin[axis] as number, 2)
      expect(afterMax[axis]).toBeCloseTo(beforeMax[axis] as number, 2)
    }
  }, 300000)

  it('joins side-by-side rows at the requested density', async () => {
    await ensureOc()
    const { makeBox } = await import('replicad')
    const bytes = await stepBytes([
      makeBox([0, 0, 0], [100, 50, 1000]),
      makeBox([0, 55, 0], [100, 105, 1000]),
    ])
    const result = await tabStep(bytes, { density: 1 })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.pieces).toBe(2)
    expect(result.tabs).toBe(1)
    expect(await bodyCount(result.bytes)).toBe(1)
  }, 300000)

  it.skipIf(!HAVE_CHS)(
    'bridges the hollow seam of a real CHS pair',
    async () => {
      await ensureOc()
      const bytes = new Uint8Array(readFileSync(CHS))
      const result = await tabStep(bytes, { density: 2 })
      expect(result).not.toBeNull()
      if (!result) return
      expect(result.pieces).toBe(2)
      expect(result.tabs).toBeGreaterThanOrEqual(1)
      expect(await bodyCount(result.bytes)).toBe(1)
    },
    300000,
  )

  it('keeps every body when several pieces are nested in two rows', async () => {
    await ensureOc()
    const { makeBox } = await import('replicad')
    const bytes = await stepBytes([
      makeBox([0, 0, 0], [100, 50, 90]),
      makeBox([0, 0, 95], [100, 50, 185]),
      makeBox([0, 55, 0], [100, 105, 90]),
      makeBox([0, 55, 95], [100, 105, 185]),
    ])
    const result = await tabStep(bytes, { density: 2 })
    expect(result).not.toBeNull()
    if (!result) return
    expect(result.pieces).toBe(4)
    expect(result.tabs).toBeGreaterThanOrEqual(3)
    expect(await bodyCount(result.bytes)).toBe(1)
  }, 300000)
})
