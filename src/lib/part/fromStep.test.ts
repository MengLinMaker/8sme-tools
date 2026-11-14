import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fixture, nw30Bottom, nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { unrolledLayout } from '@/lib/wisecam/layout'
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
      // STEP also carries bevel root lines inside the end contour; the NC endCut does not.
      expect(stepToNc.max).toBeLessThan(20)
    },
    120_000,
  )
})

describe('m71 PFC end-cut continuity', () => {
  it.skipIf(!existsSync(m71.nc) || !existsSync(m71.stp))(
    'covers the full section perimeter at each cut end',
    async () => {
      const ncText = readFileSync(m71.nc, 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      const layout = unrolledLayout(header.profileType, header.dimensions)
      if (!section || !layout) throw new Error('no section/layout')
      const meshed = await meshStepFile('m71-continuity', new Uint8Array(readFileSync(m71.stp)))
      const stepIr = partIrFromStepMesh(meshed, {
        mark: 'm71-step',
        profile: header.profile,
        dimensions: header.dimensions,
        length: header.length,
        section: section.points,
        innerSection: section.holes?.[0],
        radius: header.dimensions[4] ?? 0,
      })
      if (!stepIr) throw new Error('no STEP IR')

      const near = stepIr.features.filter(
        (feature): feature is typeof feature & { shape: { form: 'polyline'; points: UvPoint[] } } =>
          feature.kind === 'cut' &&
          feature.shape.form === 'polyline' &&
          feature.shape.points.some((point) => point[1] < 80 || point[1] > header.length - 80),
      )
      for (const end of ['start', 'end'] as const) {
        const runs = near.filter((feature) =>
          feature.shape.points.some((point) =>
            end === 'start' ? point[1] < 80 : point[1] > header.length - 80,
          ),
        )
        if (runs.length === 0) continue
        const stations = sampleRuns(runs.map((run) => run.shape.points)).map((point) => point[0])
        const seam = layout.seam
        const step = 1
        let covered = 0
        let total = 0
        for (let station = -seam / 2; station <= seam / 2; station += step) {
          total++
          if (stations.some((value) => Math.abs(value - station) <= 1.5)) covered++
        }
        expect(covered / total).toBeGreaterThan(0.95)
      }
    },
    120_000,
  )
})

describe('m71 STEP holes and slots match NC', () => {
  it.skipIf(!existsSync(m71.nc) || !existsSync(m71.stp))(
    'collapses through rims and classifies holes/slots',
    async () => {
      const ncText = readFileSync(m71.nc, 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const ncIr = partIrFromNc(ncText)
      if (!ncIr) throw new Error('no NC IR')
      const meshed = await meshStepFile('m71-features', new Uint8Array(readFileSync(m71.stp)))
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

      const holes = (part: PartIr) =>
        part.features.flatMap((feature) =>
          feature.kind === 'hole' && feature.shape.form === 'circle'
            ? [{ center: feature.shape.center, radius: feature.shape.radius }]
            : [],
        )
      const slots = (part: PartIr) =>
        part.features.flatMap((feature) =>
          feature.kind === 'slot' && feature.shape.form === 'slot'
            ? [
                {
                  center: feature.shape.center,
                  far: feature.shape.far,
                  radius: feature.shape.radius,
                },
              ]
            : [],
        )
      const ncHoles = holes(ncIr)
      const stepHoles = holes(stepIr)
      expect(stepHoles).toHaveLength(ncHoles.length)
      for (const expected of ncHoles) {
        let best = Number.POSITIVE_INFINITY
        let bestRadius = Number.POSITIVE_INFINITY
        for (const actual of stepHoles) {
          const distance = Math.hypot(
            actual.center[0] - expected.center[0],
            actual.center[1] - expected.center[1],
          )
          if (distance < best) {
            best = distance
            bestRadius = Math.abs(actual.radius - expected.radius)
          }
        }
        expect(best).toBeLessThan(1)
        expect(bestRadius).toBeLessThan(0.5)
      }

      const ncSlots = slots(ncIr)
      const stepSlots = slots(stepIr)
      expect(stepSlots).toHaveLength(ncSlots.length)
      for (const expected of ncSlots) {
        let best = Number.POSITIVE_INFINITY
        let bestRadius = Number.POSITIVE_INFINITY
        for (const actual of stepSlots) {
          const distance = Math.hypot(
            actual.center[0] - expected.center[0],
            actual.center[1] - expected.center[1],
          )
          if (distance < best) {
            best = distance
            bestRadius = Math.abs(actual.radius - expected.radius)
          }
        }
        expect(best).toBeLessThan(1)
        expect(bestRadius).toBeLessThan(0.5)
      }

      // No leftover cut fragments on/inside a hole or slot.
      const shapes = [...holes(stepIr), ...slots(stepIr)]
      for (const feature of stepIr.features) {
        if (feature.kind !== 'cut' || feature.shape.form !== 'polyline') continue
        for (const point of feature.shape.points as UvPoint[]) {
          for (const shape of shapes) {
            const center = shape.center as UvPoint
            if ('far' in shape) {
              const far = shape.far as UvPoint
              expect(pointSeg(point, center, far)).toBeGreaterThan(shape.radius + 0.5)
            } else {
              expect(Math.hypot(point[0] - center[0], point[1] - center[1])).toBeGreaterThan(
                shape.radius + 0.5,
              )
            }
          }
        }
      }
    },
    120_000,
  )
})

describe('STEP IR UV containment', () => {
  for (const mark of ['m137', 'm176']) {
    const ncPath = fixture('part-ir', `${mark}.nc1`)
    const stpPath = fixture('part-ir', `${mark}.stp`)
    it.skipIf(!existsSync(ncPath) || !existsSync(stpPath))(
      `${mark}: every cut/slot/hole station stays inside the chart`,
      async () => {
        const header = parseDstv(readFileSync(ncPath, 'utf8')).header
        const section = partSectionForCode(header.profile, header.dimensions)
        const layout = unrolledLayout(header.profileType, header.dimensions)
        if (!section || !layout) throw new Error('no section/layout')
        const ir = partIrFromStepMesh(
          await meshStepFile(mark, new Uint8Array(readFileSync(stpPath))),
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
        if (!ir) throw new Error('no STEP IR')
        const half = layout.seam / 2
        const stationOf = (point: UvPoint): number => point[0]
        const seen = new Set<string>()
        for (const feature of ir.features) {
          if (feature.kind === 'cut' && feature.shape.form === 'polyline') {
            for (const point of feature.shape.points) {
              expect(Math.abs(stationOf(point))).toBeLessThanOrEqual(half + 0.01)
            }
            const key = feature.shape.points
              .map((point) => `${point[0].toFixed(1)},${point[1].toFixed(1)}`)
              .join('|')
            const reverse = [...feature.shape.points]
              .reverse()
              .map((point) => `${point[0].toFixed(1)},${point[1].toFixed(1)}`)
              .join('|')
            const signature = key < reverse ? key : reverse
            expect(seen.has(signature)).toBe(false)
            seen.add(signature)
          }
          if (feature.kind === 'hole' && feature.shape.form === 'circle') {
            expect(Math.abs(feature.shape.center[0] - feature.shape.radius)).toBeLessThanOrEqual(
              half + 0.01,
            )
            expect(Math.abs(feature.shape.center[0] + feature.shape.radius)).toBeLessThanOrEqual(
              half + 0.01,
            )
          }
          if (feature.kind === 'slot' && feature.shape.form === 'slot') {
            for (const point of [feature.shape.center, feature.shape.far]) {
              expect(Math.abs(point[0] - feature.shape.radius)).toBeLessThanOrEqual(half + 0.01)
              expect(Math.abs(point[0] + feature.shape.radius)).toBeLessThanOrEqual(half + 0.01)
            }
          }
        }
      },
      120_000,
    )
  }
})
