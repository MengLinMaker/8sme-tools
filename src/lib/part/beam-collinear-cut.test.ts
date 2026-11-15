import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { partIrFromStepMesh } from './fromStep'
import type { UvPoint } from './ir'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

describe('beam-collinear STEP cuts', () => {
  for (const mark of ['m137', 'm176']) {
    it(`${mark}: short edge collinear with the beam is present`, async () => {
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
      if (!ir) throw new Error('no IR')
      const found = ir.features.some((feature) => {
        if (feature.kind !== 'cut' || feature.shape.form !== 'polyline') return false
        const points = feature.shape.points as UvPoint[]
        for (let index = 0; index + 1 < points.length; index++) {
          const a = points[index] as UvPoint
          const b = points[index + 1] as UvPoint
          const length = Math.hypot(b[0] - a[0], b[1] - a[1])
          if (length < 0.2 || length > 100) continue
          if (Math.abs(b[1] - a[1]) > length * 0.8) return true
        }
        return false
      })
      expect(found).toBe(true)
    }, 120_000)
  }
})
