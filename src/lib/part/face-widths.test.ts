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
      // Labels/debug are measured STEP face widths, not the catalogue spec. For these PFCs the
      // flange face is ~3.8 mm wider than the nominal 50 mm; lock the measured value.
      for (const face of ['u', 'o'] as const) {
        const measured = widths?.[face]
        expect(measured).toBeDefined()
        expect(Math.abs((measured as number) - 53.8)).toBeLessThan(0.5)
        expect(measured as number).toBeGreaterThan(50)
      }
    }, 120_000)
  }
})
