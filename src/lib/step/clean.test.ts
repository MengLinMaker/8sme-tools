import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanStep } from './clean'
import { setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const STP = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-03-01 (NW31 Top frames) Shaft part drawings',
  'Shaft part drawings',
  'STP files',
)
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
})
