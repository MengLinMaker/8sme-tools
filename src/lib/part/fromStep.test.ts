import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { partIrFromNc } from './fromNc'
import { partIrFromStepMesh } from './fromStep'
import type { PartIr, UvPoint } from './ir'
import { partIrSvg } from './svg'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const m117 = {
  nc: nw31Top('NC files', 'm117.nc1'),
  stp: nw31Top('STP files', 'm117.stp'),
}

function pointSeg(point: UvPoint, a: UvPoint, b: UvPoint): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length2 = dx * dx + dy * dy
  let t = length2 > 0 ? ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))
}

function cutPoints(part: PartIr): UvPoint[] {
  return part.features.flatMap((feature) =>
    feature.kind === 'cut' && feature.shape.form === 'polyline' ? feature.shape.points : [],
  )
}

describe('STEP → PartIR', () => {
  it.skipIf(!existsSync(m117.nc) || !existsSync(m117.stp))(
    'develops STEP cut boundaries onto the same IR net as the NC',
    async () => {
      const ncText = readFileSync(m117.nc, 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const ncIr = partIrFromNc(ncText)
      if (!ncIr) throw new Error('no NC IR')
      const meshed = await meshStepFile('m117-part-ir', new Uint8Array(readFileSync(m117.stp)))
      const stepIr = partIrFromStepMesh(meshed, {
        mark: 'm117-step',
        profile: header.profile,
        dimensions: header.dimensions,
        length: header.length,
        section: section.points,
        innerSection: section.innerSection ?? section.holes?.[0],
        radius: header.dimensions[4] ?? 0,
      })
      expect(stepIr).not.toBeNull()
      if (!stepIr) return

      const stepPoints = cutPoints(stepIr)
      const ncCuts = ncIr.features
        .filter((feature) => feature.kind === 'cut' && feature.shape.form === 'polyline')
        .map((feature) => (feature.shape.form === 'polyline' ? feature.shape.points : []))
      expect(stepPoints.length).toBeGreaterThan(0)
      let sum = 0
      for (const point of stepPoints) {
        let best = Number.POSITIVE_INFINITY
        for (const cut of ncCuts)
          for (let index = 0; index + 1 < cut.length; index++)
            best = Math.min(best, pointSeg(point, cut[index] as UvPoint, cut[index + 1] as UvPoint))
        sum += best
      }
      expect(sum / stepPoints.length).toBeLessThan(2.5)

      const svg = partIrSvg(stepIr)
      expect(svg).toContain('data-layer="section"')
      expect(svg).toContain('data-layer="chart:front"')
    },
    120_000,
  )
})
