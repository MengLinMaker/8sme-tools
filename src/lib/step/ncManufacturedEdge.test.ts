import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import {
  faceHalf,
  faceSpanAxis,
  ncAuthoredStancePoints,
  placeNcFace,
  resolveNcFaceFrame,
} from '@/lib/parsers/ncFaces'
import { arcSamples, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { profileFamily } from '@/lib/sections/canonical'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

type Vec3 = [number, number, number]

/**
 * Every NC cut line must exist as an edge on the **manufactured NC** solid. This is the direct
 * reconstruction check: the solid is built from the NC, so a cut line with no matching edge means a
 * face's cut was dropped or displaced. The NC is projected in the reconstruction's own build frame
 * (authored stance + the same 90° rollback), never through the STEP-seating heuristic. Tubes
 * (SHS/RHS) are excluded: their cut lines go through rounded-corner projection, which is validated
 * separately.
 */
const MARKS = ['a1', 'm31', 'm124', 'm127', 'm130', 'm30'] as const

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function pointSeg(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
  let t = l2 > 0 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return dist(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]])
}

describe('manufactured NC edge agreement', () => {
  for (const mark of MARKS) {
    const ncPath = nw31Top('NC files', `${mark}.nc1`)
    it.skipIf(!existsSync(ncPath))(
      `${mark} NC cut lines land on the manufactured edges`,
      async () => {
        const nc = readFileSync(ncPath, 'utf8')
        const header = parseDstv(nc).header
        const family = profileFamily(header.profile)
        if (family === 'tube') return
        const geo = parseNcGeometry(nc)
        const raw = partSectionForCode(header.profile, header.dimensions)
        if (!raw) return
        const authored = ncAuthoredStancePoints(header.profile, raw.points)
        const section = { ...raw, points: authored }
        const frame = resolveNcFaceFrame(section.points, geo, header.profile)
        const roll = family === 'channel' ? -90 : family === 'i' ? 90 : 0
        const rollPt = ([x, y, z]: Vec3): Vec3 =>
          roll === -90 ? [x, z, -y] : roll === 90 ? [x, -z, y] : [x, y, z]

        const segments: { a: Vec3; b: Vec3; tag: string }[] = []
        for (const contour of geo.contours.filter((c) => c.kind === 'outer')) {
          const span = faceSpanAxis(frame, contour.face)
          const half = faceHalf(frame, span)
          for (let i = 0; i < contour.points.length; i++) {
            const p = contour.points[i]
            const q = contour.points[(i + 1) % contour.points.length]
            if (!p || !q || Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6) continue
            const pa = placeNcFace(frame, contour.face, p[0], p[1], section.points)
            const pb = placeNcFace(frame, contour.face, q[0], q[1], section.points)
            const ca = pa.cross[span]
            const cb = pb.cross[span]
            // A segment along the stock outline is not a cut.
            if (
              Math.sign(ca) === Math.sign(cb) &&
              Math.abs(Math.abs(ca) - half) < 0.5 &&
              Math.abs(Math.abs(cb) - half) < 0.5
            )
              continue
            // Follow the DSTV arc radius so the expected line matches the solid's notch/arc.
            const samples = arcSamples(p, q, contour.radii?.[i] ?? 0)
            for (let j = 0; j < samples.length - 1; j++) {
              const s0 = samples[j] as [number, number]
              const s1 = samples[j + 1] as [number, number]
              const sa = placeNcFace(frame, contour.face, s0[0], s0[1], section.points)
              const sb = placeNcFace(frame, contour.face, s1[0], s1[1], section.points)
              segments.push({
                a: rollPt([sa.along, sa.cross[0], sa.cross[1]]),
                b: rollPt([sb.along, sb.cross[0], sb.cross[1]]),
                tag: `${contour.face}[${i}]`,
              })
            }
          }
        }

        const step = await reconstructStepFromNc(nc)
        expect(step).toBeTruthy()
        if (!step) return
        const meshed = await meshStepFile(mark, new TextEncoder().encode(step))
        const edges: Vec3[] = []
        for (const body of meshed.bodies)
          for (const face of body.brep ?? [])
            for (const wire of face.wires)
              for (const edge of wire.edges)
                for (let k = 0; k + 2 < edge.points.length; k += 3)
                  edges.push([
                    edge.points[k] as number,
                    edge.points[k + 1] as number,
                    edge.points[k + 2] as number,
                  ])

        let sum = 0
        let max = 0
        let worst = ''
        for (const { a, b, tag } of segments) {
          const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
          let gap = Number.POSITIVE_INFINITY
          for (let i = 0; i + 1 < edges.length; i++)
            gap = Math.min(gap, pointSeg(mid, edges[i] as Vec3, edges[i + 1] as Vec3))
          sum += gap
          if (gap > max) {
            max = gap
            worst = tag
          }
        }
        const mean = segments.length ? sum / segments.length : 0
        console.log(`${mark}: edge gap mean ${mean.toFixed(2)} max ${max.toFixed(2)} (${worst})`)
        expect(mean).toBeLessThan(0.6)
        // The `v` cut lines are the beveled ones; with the bevel off, a ~20° × wall offset remains.
        expect(max).toBeLessThan(2.5)
      },
      300000,
    )
  }
})
