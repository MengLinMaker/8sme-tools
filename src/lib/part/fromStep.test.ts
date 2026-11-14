import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw30Bottom, nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { frameForProfile } from '@/lib/parsers/ncFaces'
import { partSectionForCode } from '@/lib/sections/stock'
import { projectCutEdgesToFaces } from '@/lib/step/cutProjection'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { seatedStepGeometry } from '@/lib/wisecam/fromStep'
import { centeredStationFor, unrolledLayout } from '@/lib/wisecam/layout'
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

const m71 = {
  nc: nw30Bottom('m71.nc1'),
  stp: nw30Bottom('m71.stp'),
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

function sampleRuns(runs: UvPoint[][]): UvPoint[] {
  const out: UvPoint[] = []
  for (const run of runs) {
    for (let index = 0; index + 1 < run.length; index++) {
      const a = run[index] as UvPoint
      const b = run[index + 1] as UvPoint
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])))
      for (let step = 0; step < steps; step++) {
        const t = step / steps
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      }
    }
  }
  return out
}

function deviation(from: UvPoint[], to: UvPoint[]): { mean: number; max: number } {
  let sum = 0
  let max = 0
  for (const point of from) {
    let best = Number.POSITIVE_INFINITY
    for (let index = 0; index + 1 < to.length; index++)
      best = Math.min(best, pointSeg(point, to[index] as UvPoint, to[index + 1] as UvPoint))
    sum += best
    max = Math.max(max, best)
  }
  return { mean: from.length ? sum / from.length : 0, max }
}

describe('m71 strict STEP↔NC IR', () => {
  it.skipIf(!existsSync(m71.nc) || !existsSync(m71.stp))(
    'develops the same end cuts as the NC (bevel is identical)',
    async () => {
      const ncText = readFileSync(m71.nc, 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const ncIr = partIrFromNc(ncText)
      if (!ncIr) throw new Error('no NC IR')
      const meshed = await meshStepFile('m71-part-ir', new Uint8Array(readFileSync(m71.stp)))
      const stepIr = partIrFromStepMesh(meshed, {
        mark: 'm71-step',
        profile: header.profile,
        dimensions: header.dimensions,
        length: header.length,
        section: section.points,
        innerSection: section.innerSection ?? section.holes?.[0],
        radius: header.dimensions[4] ?? 0,
      })
      if (!stepIr) throw new Error('no STEP IR')

      const nearEnd = (point: UvPoint): boolean => point[1] < 80 || point[1] > header.length - 80
      const ncEnds = [...(ncIr.startCut ?? []), ...(ncIr.endCut ?? [])]
      const stepEndRuns = stepIr.features.flatMap((feature) =>
        feature.kind === 'cut' &&
        feature.shape.form === 'polyline' &&
        feature.shape.points.some(nearEnd)
          ? [feature.shape.points]
          : [],
      )
      const stepEnds = sampleRuns(stepEndRuns)
      expect(ncEnds.length).toBeGreaterThan(2)
      expect(stepEnds.length).toBeGreaterThan(0)

      const ncToStep = deviation(ncEnds, stepEnds)
      const stepToNc = deviation(stepEnds, ncEnds)
      expect(ncToStep.mean).toBeLessThan(1)
      expect(ncToStep.max).toBeLessThan(4)
      expect(stepToNc.mean).toBeLessThan(1)
      expect(stepToNc.max).toBeLessThan(4)
    },
    120_000,
  )
})

describe('m71 STEP cut-line round trip', () => {
  it.skipIf(!existsSync(m71.nc) || !existsSync(m71.stp))(
    'projects STEP cuts into IR and back onto the same face lines',
    async () => {
      const ncText = readFileSync(m71.nc, 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const layout = unrolledLayout(header.profileType, header.dimensions)
      if (!layout) throw new Error('no layout')
      const meshed = await meshStepFile('m71-cut-round-trip', new Uint8Array(readFileSync(m71.stp)))
      const seated = seatedStepGeometry(meshed, section.points)
      const stepIr = partIrFromStepMesh(meshed, {
        mark: 'm71-step',
        profile: header.profile,
        dimensions: header.dimensions,
        length: header.length,
        section: section.points,
        innerSection: section.innerSection ?? section.holes?.[0],
        radius: header.dimensions[4] ?? 0,
      })
      if (!stepIr) throw new Error('no STEP IR')

      const frame = frameForProfile(header.profile, section.points)
      const projected = projectCutEdgesToFaces(
        seated.faces,
        section.points,
        frame,
        seated.xAxis,
        seated.yAxis,
        seated.memberAxis,
        { radius: header.dimensions[4] ?? 0 },
      )
      const expected: UvPoint[] = []
      for (const face of ['v', 'o', 'u', 'h'] as const) {
        for (const segment of projected[face]) {
          const aStation = centeredStationFor(layout, face, segment.a.Y)
          const bStation = centeredStationFor(layout, face, segment.b.Y)
          if (aStation == null || bStation == null) continue
          const a: UvPoint = [aStation, segment.a.X + seated.alongOffset]
          const b: UvPoint = [bStation, segment.b.X + seated.alongOffset]
          const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])))
          for (let step = 0; step < steps; step++) {
            const t = step / steps
            expected.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
          }
        }
      }
      const actual = sampleRuns(
        stepIr.features.flatMap((feature) =>
          feature.kind === 'cut' && feature.shape.form === 'polyline' ? [feature.shape.points] : [],
        ),
      )
      expect(expected.length).toBeGreaterThan(0)
      expect(actual.length).toBeGreaterThan(0)
      const expectedToActual = deviation(expected, actual)
      const actualToExpected = deviation(actual, expected)
      console.log('m71 cut-line round trip', { expectedToActual, actualToExpected })
      expect(expectedToActual.mean).toBeLessThan(0.05)
      expect(expectedToActual.max).toBeLessThan(0.5)
      expect(actualToExpected.mean).toBeLessThan(0.05)
      expect(actualToExpected.max).toBeLessThan(0.5)
    },
    120_000,
  )
})
