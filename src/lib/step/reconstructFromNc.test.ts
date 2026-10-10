import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * Demonstration / regression for the standalone NC → STEP reconstruction, run against the
 * real NW31 Top job when the fixtures happen to be on this machine. Skipped otherwise.
 */

const BASE = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-03-01 (NW31 Top frames) Shaft part drawings',
  'Shaft part drawings',
)
const ncPath = (m: string) => join(BASE, 'NC files', `${m}.nc1`)
const stpPath = (m: string) => join(BASE, 'STP files', `${m}.stp`)

async function measure(bytes: string | Buffer): Promise<{ size: number[]; vol: number }> {
  const { importSTEP, measureVolume } = await import('replicad')
  const u8 = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes)
  const shape = await importSTEP(new Blob([u8], { type: 'model/step' }))
  const [min, max] = (shape as { boundingBox: { bounds: [number[], number[]] } }).boundingBox.bounds
  return {
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    vol: measureVolume(shape as never),
  }
}

const HAVE = existsSync(ncPath('m199')) && existsSync(stpPath('m199'))

describe.skipIf(!HAVE)('reconstruct T solid from NC (experimental)', () => {
  it('matches healthy sibling parts within tolerance', async () => {
    for (const mark of ['m199', 'm143']) {
      const step = await reconstructStepFromNc(readFileSync(ncPath(mark), 'utf8'))
      expect(step).toBeTruthy()
      if (!step) continue
      const built = await measure(step)
      const real = await measure(readFileSync(stpPath(mark)))
      const builtSorted = [...built.size].sort((a, b) => b - a)
      const realSorted = [...real.size].sort((a, b) => b - a)
      for (let i = 0; i < 3; i++) expect(Math.abs(builtSorted[i] - realSorted[i])).toBeLessThan(6)
      // volume within 5% (end-arc radii are drawn straight)
      expect(Math.abs(built.vol - real.vol) / real.vol).toBeLessThan(0.05)
    }
  }, 300000)

  it('produces usable geometry for the corrupted parts', async () => {
    for (const mark of ['m170', 'm198', 'm217']) {
      const step = await reconstructStepFromNc(readFileSync(ncPath(mark), 'utf8'))
      expect(step).toBeTruthy()
      if (!step) continue
      const built = await measure(step)
      // a real T part, not the 0.07 mm sheet the STEP held
      expect(Math.min(...built.size)).toBeGreaterThan(50)
      expect(Math.max(...built.size)).toBeGreaterThan(1500)
      writeFileSync(join(process.env.TEMP ?? '.', `nc-${mark}.stp`), step)
    }
  }, 300000)
})
