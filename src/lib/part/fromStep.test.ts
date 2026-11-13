import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fixture, nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { frameForProfile } from '@/lib/parsers/ncFaces'
import { partSectionForCode } from '@/lib/sections/stock'
import { distanceToOutline } from '@/lib/step/cutEdges'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { seatedStepGeometry } from '@/lib/wisecam/fromStep'
import { unrolledLayout } from '@/lib/wisecam/layout'
import { partIrFromNc } from './fromNc'
import { partIrFromStepMesh, tubeArcMapper } from './fromStep'
import type { FeatureShape, PartIr, UvPoint } from './ir'
import { partIrSvg } from './svg'
import { partIrToNcGeometry } from './toNcGeometry'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const m117 = {
  nc: nw31Top('NC files', 'm117.nc1'),
  stp: nw31Top('STP files', 'm117.stp'),
}

const m65 = {
  nc: fixture('part-ir', 'm65.nc1'),
  stp: fixture('part-ir', 'm65.stp'),
}

const m211 = {
  nc: nw31Top('NC files', 'm211.nc1'),
  stp: nw31Top('STP files', 'm211.stp'),
}

function pointSeg(point: UvPoint, a: UvPoint, b: UvPoint): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const length2 = dx * dx + dy * dy
  let t = length2 > 0 ? ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))
}

function shapePoints(shape: FeatureShape): UvPoint[] {
  if (shape.form === 'circle') {
    const points: UvPoint[] = []
    for (let index = 0; index <= 24; index++) {
      const angle = (index / 24) * Math.PI * 2
      points.push([
        shape.center[0] + Math.cos(angle) * shape.radius,
        shape.center[1] + Math.sin(angle) * shape.radius,
      ])
    }
    return points
  }
  if (shape.form === 'slot') {
    const dx = shape.far[0] - shape.center[0]
    const dy = shape.far[1] - shape.center[1]
    const base = Math.atan2(dy, dx)
    const points: UvPoint[] = []
    for (let index = 0; index <= 12; index++) {
      const angle = base - Math.PI / 2 + (index / 12) * Math.PI
      points.push([
        shape.far[0] + Math.cos(angle) * shape.radius,
        shape.far[1] + Math.sin(angle) * shape.radius,
      ])
    }
    for (let index = 0; index <= 12; index++) {
      const angle = base + Math.PI / 2 + (index / 12) * Math.PI
      points.push([
        shape.center[0] + Math.cos(angle) * shape.radius,
        shape.center[1] + Math.sin(angle) * shape.radius,
      ])
    }
    return points
  }
  return shape.points
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

      const bevelled = stepIr.features.filter((feature) =>
        (feature.bevels ?? []).some((value) => Math.abs(value[0] ?? 0) > 0.1),
      )
      expect(bevelled.length).toBeGreaterThan(0)
      const geometry = partIrToNcGeometry(stepIr)
      expect(
        geometry.contours.some((contour) =>
          contour.bevels.some((value) => Math.abs(value[0] ?? 0) > 0.1),
        ),
      ).toBe(true)

      const svg = partIrSvg(stepIr)
      expect(svg).toContain('data-layer="section"')
      expect(svg).toContain('data-layer="chart:front"')
    },
    120_000,
  )
  it.skipIf(!existsSync(m65.nc) || !existsSync(m65.stp))(
    'm65: STEP wire cuts match the NC net (stock edges are reference only)',
    async () => {
      const ncText = readFileSync(m65.nc, 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const ncIr = partIrFromNc(ncText)
      if (!ncIr) throw new Error('no NC IR')
      const meshed = await meshStepFile('m65-part-ir', new Uint8Array(readFileSync(m65.stp)))
      const stepIr = partIrFromStepMesh(meshed, {
        mark: 'm65-step',
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
        .filter(
          (feature) => feature.kind === 'cut' || feature.kind === 'hole' || feature.kind === 'slot',
        )
        .map((feature) => shapePoints(feature.shape))
      expect(stepPoints.length).toBeGreaterThan(0)
      let sum = 0
      for (const point of stepPoints) {
        let best = Number.POSITIVE_INFINITY
        for (const cut of ncCuts)
          for (let index = 0; index + 1 < cut.length; index++)
            best = Math.min(best, pointSeg(point, cut[index] as UvPoint, cut[index + 1] as UvPoint))
        sum += best
      }
      expect(sum / stepPoints.length).toBeLessThan(1)

      expect(ncIr.features.some((feature) => feature.stock?.some(Boolean))).toBe(true)
      expect(stepIr.features.some((feature) => feature.stock?.some(Boolean))).toBe(false)
      const svg = partIrSvg(stepIr)
      expect(svg).toContain('stroke="#334155"')
    },
    120_000,
  )
  it.skipIf(!existsSync(m211.nc) || !existsSync(m211.stp))(
    'm211: beveled RHS STEP cuts follow the NC surface lines',
    async () => {
      const ncText = readFileSync(m211.nc, 'utf8')
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const ncIr = partIrFromNc(ncText)
      if (!ncIr) throw new Error('no NC IR')
      const meshed = await meshStepFile('m211-part-ir', new Uint8Array(readFileSync(m211.stp)))
      const stepIr = partIrFromStepMesh(meshed, {
        mark: 'm211-step',
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
      let sum = 0
      for (const point of stepPoints) {
        let best = Number.POSITIVE_INFINITY
        for (const cut of ncCuts)
          for (let index = 0; index + 1 < cut.length; index++)
            best = Math.min(best, pointSeg(point, cut[index] as UvPoint, cut[index + 1] as UvPoint))
        sum += best
      }
      expect(sum / stepPoints.length).toBeLessThan(2)
    },
    120_000,
  )
  // Known gap: the STEP's measured corner radius differs from the catalogue section, so a
  // catalogue-based IR cannot yet hit the 0.1 mm manufacturing bar. This must fail until the
  // STEP path uses a measured section/layout.
  // Known modelling gap: the B-rep surface is still approximated by a fitted rounded rectangle.
  // Must fail until corner points are mapped from their own fitted cylinders.
  it.fails('m211: tube corner 3D → IR → 3D round-trips numerically', async () => {
    const ncText = readFileSync(m211.nc, 'utf8')
    const header = parseDstv(ncText).header
    const section = partSectionForCode(header.profile, header.dimensions)
    if (!section) throw new Error('no section')
    const layout = unrolledLayout(header.profileType, header.dimensions)
    if (!layout) throw new Error('no layout')
    const frame = frameForProfile(header.profile, section.points)
    const seated = seatedStepGeometry(
      await meshStepFile('m211-roundtrip', new Uint8Array(readFileSync(m211.stp))),
      section.points,
    )
    const mapper = tubeArcMapper(layout, section.points, frame)
    expect(mapper).not.toBeNull()
    if (!mapper) return

    const dot3 = (a: [number, number, number], b: [number, number, number]): number =>
      a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    let worst = 0
    let samples = 0
    for (const face of seated.faces) {
      if (face.planar) continue
      for (const edge of face.wires.flatMap((wire) => wire.edges)) {
        for (let index = 0; index + 2 < edge.points.length; index += 3) {
          const raw: [number, number, number] = [
            edge.points[index] as number,
            edge.points[index + 1] as number,
            edge.points[index + 2] as number,
          ]
          const q: [number, number] = [dot3(seated.xAxis, raw), dot3(seated.yAxis, raw)]
          if (distanceToOutline(section.points, q) > 2) continue
          const station = mapper.station(q)
          const back = mapper.crossAt(station)
          worst = Math.max(worst, Math.hypot(back[0] - q[0], back[1] - q[1]))
          samples++
        }
      }
    }
    expect(samples).toBeGreaterThan(20)
    expect(worst).toBeLessThan(0.1)
  }, 120_000)
})
