import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw31Top } from '@test/fixtures'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { outlinePoints } from '@/lib/sections/outline'
import { partSectionForCode } from '@/lib/sections/stock'
import type { SeatedBrepFace } from '@/lib/step/cutEdges'
import { meshStepFile } from '@/lib/step/mesh'
import { setOcWasmUrl } from '@/lib/step/occInit'
import { seatedStepProfile, transformVertices } from '@/lib/step/seat'
import { buildNcepFromStepSurface, partFromStepMesh, partFromStepSurface } from './fromStep'
import { stationFor, unrolledLayout } from './layout'
import {
  developFaceSegments,
  developNcGeometry,
  developStepCutEdges,
  type SurfacePoint,
} from './surface'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

function pointSeg(p: SurfacePoint, a: SurfacePoint, b: SurfacePoint): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

function meanToCuts(points: SurfacePoint[], cuts: SurfacePoint[][]): number {
  if (points.length === 0 || cuts.length === 0) return Number.POSITIVE_INFINITY
  let sum = 0
  for (const point of points) {
    let best = Number.POSITIVE_INFINITY
    for (const cut of cuts)
      for (let i = 0; i + 1 < cut.length; i++)
        best = Math.min(best, pointSeg(point, cut[i] as SurfacePoint, cut[i + 1] as SurfacePoint))
    sum += best
  }
  return sum / points.length
}

const m117 = {
  nc: nw31Top('NC files', 'm117.nc1'),
  stp: nw31Top('STP files', 'm117.stp'),
}

describe('surface development', () => {
  it('develops a face segment by mapping across → station only', () => {
    const layout = unrolledLayout('M', [150, 100, 9, 9, 12.5])
    if (!layout) throw new Error('no layout')
    const region = layout.faces.v
    if (!region) throw new Error('no v region')
    // Two contiguous segments form one developed cut; X (along) is unchanged.
    const cuts = developFaceSegments(layout, 'v', [
      { a: { X: 10, Y: 2 }, b: { X: 20, Y: 2 }, bevel: 0, dir: null },
      { a: { X: 20, Y: 2 }, b: { X: 30, Y: 2 }, bevel: 0, dir: null },
    ])
    expect(cuts).toHaveLength(1)
    const station = stationFor(layout, 'v', 2)
    expect(cuts[0]?.points).toEqual([
      [station, 10],
      [station, 20],
      [station, 30],
    ])
  })

  it('splits a developed cut where it crosses a zero-origin seam', () => {
    const layout = unrolledLayout('M', [150, 100, 9, 9, 12.5])
    if (!layout) throw new Error('no layout')
    const region = layout.faces.v
    if (!region) throw new Error('no v region')
    const width = region.width ?? region.length
    // `v` straddles the seam, so just below and above the mid-width land on opposite seam sides.
    const cuts = developFaceSegments(layout, 'v', [
      {
        a: { X: 0, Y: width / 2 - 1 },
        b: { X: 10, Y: width / 2 + 1 },
        bevel: 0,
        dir: null,
      },
    ])
    expect(cuts.length).toBe(2)
  })

  it.skipIf(!existsSync(m117.nc) || !existsSync(m117.stp))(
    'STEP cut edges develop to the same NCEP surface as the NC',
    async () => {
      const ncText = readFileSync(m117.nc, 'utf8')
      const header = parseDstv(ncText).header
      const geometry = parseNcGeometry(ncText)
      const layout = unrolledLayout(header.profileType, header.dimensions)
      if (!layout) throw new Error('no layout')
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const frame = resolveNcFaceFrame(outlinePoints(section?.outline), geometry, header.profile)

      const meshed = await meshStepFile('m117-surface', new Uint8Array(readFileSync(m117.stp)))
      const seated = seatedStepProfile(meshed.vertices, outlinePoints(section?.outline))
      const quaternion = new Quaternion()
      const position = new Vector3()
      const scale = new Vector3()
      seated.primary.decompose(position, quaternion, scale)
      const rotation = new Matrix4().makeRotationFromQuaternion(quaternion)
      const transformed = transformVertices(meshed.vertices, seated.primary)
      let minX = Number.POSITIVE_INFINITY
      for (let i = 0; i + 2 < transformed.length; i += 3)
        minX = Math.min(minX, transformed[i] as number)

      const faces: SeatedBrepFace[] = meshed.bodies.flatMap((body) =>
        (body.brep ?? []).map((face) => {
          const normal = new Vector3(...face.normal).applyQuaternion(quaternion)
          const center = new Vector3(...face.center).applyMatrix4(seated.primary)
          return {
            normal: [normal.x, normal.y, normal.z],
            center: [center.x, center.y, center.z],
            planar: face.planar,
            samples: transformVertices(face.samples, seated.primary),
            wires: face.wires.map((wire) => ({
              enclosed: wire.enclosed,
              edges: wire.edges.map((edge) => ({
                points: transformVertices(edge.points, seated.primary),
                neighbours: edge.neighbours,
                neighbourNormals: edge.neighbourNormals?.map((normals) =>
                  normals ? transformVertices(normals, rotation) : undefined,
                ),
              })),
            })),
          }
        }),
      )

      const nc = developNcGeometry(geometry, layout, { length: header.length })
      const ncCuts = nc.cuts.map((cut) => cut.points)
      const stepCuts = developStepCutEdges(
        {
          faces,
          section: outlinePoints(section?.outline),
          frame,
          layout,
          xAxis: [seated.xAxis.x, seated.xAxis.y, seated.xAxis.z],
          yAxis: [seated.yAxis.x, seated.yAxis.y, seated.yAxis.z],
          memberAxis: [1, 0, 0],
        },
        { radius: header.dimensions[4] ?? 0, alongOffset: -minX },
      ).map((cut) => cut.points)

      const ncPoints = ncCuts.flat()
      expect(stepCuts.length).toBeGreaterThan(0)
      expect(meanToCuts(ncPoints, stepCuts)).toBeLessThan(2.5)

      // Scaffold STEP→NCEP path consumes the same surface development.
      const input = {
        faces,
        section: outlinePoints(section?.outline),
        frame,
        layout,
        xAxis: [seated.xAxis.x, seated.xAxis.y, seated.xAxis.z] as [number, number, number],
        yAxis: [seated.yAxis.x, seated.yAxis.y, seated.yAxis.z] as [number, number, number],
        memberAxis: [1, 0, 0] as [number, number, number],
      }
      const options = {
        mark: 'm117-step',
        profile: header.profile,
        dimensions: header.dimensions,
        length: header.length,
        section: outlinePoints(section?.outline),
        radius: header.dimensions[4] ?? 0,
        alongOffset: -minX,
      }
      const part = partFromStepSurface(input, options)
      expect(part?.cuts?.length ?? 0).toBeGreaterThan(0)
      expect(part?.unrolledPerimeter).toBeCloseTo(layout.seam, 6)
      expect(buildNcepFromStepSurface(input, options)).not.toBeNull()

      // The viewer/UI path: seat straight from the meshed STEP.
      const meshPart = partFromStepMesh(meshed, options)
      expect(meshPart?.cuts?.length ?? 0).toBeGreaterThan(0)
    },
    120_000,
  )
})
