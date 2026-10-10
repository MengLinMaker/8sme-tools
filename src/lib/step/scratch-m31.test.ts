import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { measureStep } from './measure'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const NW31 = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-03-01 (NW31 Top frames) Shaft part drawings',
  'Shaft part drawings',
)

/** Scratch: m31 shape numbers. */
describe('m31 shape check', () => {
  it('reports bodies/size/volume vs STEP', async () => {
    for (const mark of ['m31', 'm41']) {
      const nc = readFileSync(join(NW31, 'NC files', `${mark}.nc1`), 'utf8')
      const stepBytes = new Uint8Array(readFileSync(join(NW31, 'STP files', `${mark}.stp`)))
      const real = await measureStep(stepBytes).catch(() => null)
      const straight = await reconstructStepFromNc(nc).catch(() => null)
      const bs = straight ? await measureStep(new TextEncoder().encode(straight)).catch(() => null) : null
      console.log(
        `${mark}: step bodies=${real?.bodies} vol=${((real?.volume ?? 0) / 1e6).toFixed(3)} size=${(real?.size ?? []).map((v) => v.toFixed(1)).join('x')}`,
      )
      console.log(
        `${mark}: built bodies=${bs?.bodies} vol=${((bs?.volume ?? 0) / 1e6).toFixed(3)} size=${(bs?.size ?? []).map((v) => v.toFixed(1)).join('x')}`,
      )
    }
    expect(true).toBe(true)
  }, 600000)
})
