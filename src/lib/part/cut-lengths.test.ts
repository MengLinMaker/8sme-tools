import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { frameForProfile } from '@/lib/parsers/ncFaces'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { seatedStepGeometry } from '@/lib/wisecam/fromStep'
import { unrolledLayout } from '@/lib/wisecam/layout'
import { partIrFromStepMesh, projectStepCutRuns } from './fromStep'
import type { PartIr, UvPoint } from './ir'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

function length(points: UvPoint[]): number {
  let total = 0
  for (let index = 0; index + 1 < points.length; index++)
    total += Math.hypot(
      (points[index + 1] as UvPoint)[0] - (points[index] as UvPoint)[0],
      (points[index + 1] as UvPoint)[1] - (points[index] as UvPoint)[1],
    )
  return total
}
function inside(point: UvPoint, features: PartIr['features']): boolean {
  return features.some((feature) => {
    if (feature.kind === 'hole' && feature.shape.form === 'circle') {
      const { center, radius } = feature.shape
      return Math.hypot(point[0] - center[0], point[1] - center[1]) <= radius + 0.5
    }
    if (feature.kind === 'slot' && feature.shape.form === 'slot') {
      const { center, far, radius } = feature.shape
      const dx = far[0] - center[0]
      const dy = far[1] - center[1]
      const l2 = dx * dx + dy * dy
      let t = l2 > 0 ? ((point[0] - center[0]) * dx + (point[1] - center[1]) * dy) / l2 : 0
      t = Math.max(0, Math.min(1, t))
      return (
        Math.hypot(point[0] - (center[0] + t * dx), point[1] - (center[1] + t * dy)) <= radius + 0.5
      )
    }
    return false
  })
}

describe('STEP IR cut length preservation', () => {
  for (const mark of ['m137', 'm176']) {
    it(`${mark}: IR cut length equals the projection length`, async () => {
      const ncText = readFileSync(fixture('part-ir', `${mark}.nc1`), 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      const layout = unrolledLayout(header.profileType, header.dimensions)
      if (!section || !layout) throw new Error('no section/layout')
      const meshed = await meshStepFile(
        mark,
        new Uint8Array(readFileSync(fixture('part-ir', `${mark}.stp`))),
      )
      const seated = seatedStepGeometry(meshed, section.points)
      const frame = frameForProfile(header.profile, section.points)
      const ir = partIrFromStepMesh(meshed, {
        mark,
        profile: header.profile,
        dimensions: header.dimensions,
        length: header.length,
        section: section.points,
        innerSection: section.holes?.[0],
        radius: header.dimensions[4] ?? 0,
      })
      if (!ir) throw new Error('no IR')
      const raw = projectStepCutRuns(
        seated,
        layout,
        frame,
        section.points,
        section.holes?.[0],
        seated.alongOffset,
        false,
        header.profile,
      ).filter((run) => {
        const mid: UvPoint = [
          run.reduce((sum, p) => sum + p[0], 0) / run.length,
          run.reduce((sum, p) => sum + p[1], 0) / run.length,
        ]
        return !inside(mid, ir.features)
      })
      const projected = raw.reduce((sum, run) => sum + length(run), 0)
      const actual = ir.features
        .filter(
          (
            feature,
          ): feature is typeof feature & { shape: { form: 'polyline'; points: UvPoint[] } } =>
            feature.kind === 'cut' && feature.shape.form === 'polyline',
        )
        .reduce((sum, feature) => sum + length(feature.shape.points), 0)
      expect(Math.abs(actual - projected)).toBeLessThan(0.1)
    }, 120_000)
  }
})
