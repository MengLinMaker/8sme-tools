import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { partIrFromStepMesh } from './fromStep'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

describe('measured STEP face widths', () => {
  for (const mark of ['m137', 'm176']) {
    it(`${mark}: measured flange labels use the STEP width`, async () => {
      const ncText = readFileSync(fixture('part-ir', `${mark}.nc1`), 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const ir = partIrFromStepMesh(
        await meshStepFile(mark, new Uint8Array(readFileSync(fixture('part-ir', `${mark}.stp`)))),
        {
          mark,
          profile: header.profile,
          dimensions: header.dimensions,
          length: header.length,
          section: section.points,
          innerSection: section.holes?.[0],
          radius: header.dimensions[4] ?? 0,
        },
      )
      const widths = ir?.charts[0]?.faceWidths
      expect(widths).toBeTruthy()
      // The face fit removes the slanted-edge artifact; the measured flange is the spec 50 mm.
      for (const face of ['u', 'o'] as const) {
        const measured = widths?.[face]
        expect(measured).toBeDefined()
        expect(Math.abs((measured as number) - 50)).toBeLessThan(0.5)
      }
    }, 120_000)
  }
})
