import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const NC_DIR = process.env.OC_NC ?? ''
const STP_DIR = process.env.OC_STP ?? ''
const MARK = process.env.OC_MARK ?? 'm31'

describe('pfc orient repro', () => {
  it('one mark', async () => {
    const { importSTEP, measureVolume, measureShapeVolumeProperties } = await import('replicad')
    const reference = new Uint8Array(readFileSync(join(STP_DIR, `${MARK}.stp`)))
    const built = await reconstructStepFromNc(readFileSync(join(NC_DIR, `${MARK}.nc1`), 'utf8'), {
      reference,
    })
    // eslint-disable-next-line no-console
    console.log(`${MARK}: built?`, !!built)
    if (!built) return
    const b = (await importSTEP(new Blob([new TextEncoder().encode(built)]))) as never
    const r = (await importSTEP(new Blob([reference]))) as never
    const rv = measureVolume(r as never)
    const inter = (b as unknown as { intersect: (o: never) => never }).intersect(r)
    // eslint-disable-next-line no-console
    console.log(`${MARK}: overlap`, (measureVolume(inter as never) / rv).toFixed(3))
    const bp = (measureShapeVolumeProperties(b as never) as { centerOfMass: number[] }).centerOfMass
    const rp = (measureShapeVolumeProperties(r as never) as { centerOfMass: number[] }).centerOfMass
    // eslint-disable-next-line no-console
    console.log(`${MARK}: built com`, bp.map((v) => v.toFixed(1)).join(','))
    // eslint-disable-next-line no-console
    console.log(`${MARK}: ref   com`, rp.map((v) => v.toFixed(1)).join(','))
  }, 600000)
})
