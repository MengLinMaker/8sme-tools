import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw30Bottom, nw31Bottom, nw31Top } from '@test/fixtures'
import { describe, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { resolveNcFaceFrame } from '@/lib/parsers/ncFaces'
import { type NcGeometry, parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { projectNc, type Vec3 } from '@/lib/parsers/ncProject'
import { partSectionForCode } from '@/lib/sections/stock'
import { meshStepFile } from './mesh'
import { setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const MARKS: [string, string][] = [
  ['m89', join(nw30Bottom(), 'm89.nc1')],
  ['m71', join(nw30Bottom(), 'm71.nc1')],
  ['m87', join(nw30Bottom(), 'm87.nc1')],
  ['m12', join(nw31Bottom(), 'm12.nc1')],
  ['m116', join(nw31Bottom(), 'm116.nc1')],
  ['m222', join(nw31Top('NC files'), 'm222.nc1')],
]

function segPointDist(
  p: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0
  return Math.hypot(p[0] - (a[0] + t * ab[0]), p[1] - (a[1] + t * ab[1]), p[2] - (a[2] + t * ab[2]))
}

describe('edge diag', () => {
  for (const [mark, ncPath] of MARKS) {
    it(`${mark}, projected cuts vs manufactured edges`, async () => {
      const ncText = readFileSync(ncPath, 'utf8')
      const header = parseDstv(ncText).header
      const geoRaw = parseNcGeometry(ncText)
      const geo: NcGeometry = {
        ...geoRaw,
        contours: geoRaw.contours.map((c) => ({
          ...c,
          bevels: c.points.map(() => [0, 0, 0, 0]),
        })),
      }
      const section = partSectionForCode(header.profile, header.dimensions)
      if (!section) throw new Error('no section')
      const frame = resolveNcFaceFrame(section.points, geo, header.profile)

      const step = await reconstructStepFromNc(ncText)
      if (!step) throw new Error('no build')
      const meshed = await meshStepFile(mark, new TextEncoder().encode(step))
      const verts: number[] = []
      const edges: [number, number, number][][] = []
      for (const body of meshed.bodies) {
        const fv = body.mesh.faces.vertices
        const ft = body.mesh.faces.triangles
        const base = verts.length / 3
        for (const v of fv) verts.push(v)
        const seen = new Set<string>()
        const edge = (i: number, j: number) => {
          const a = i + base
          const b = j + base
          const key = a < b ? `${a}_${b}` : `${b}_${a}`
          if (seen.has(key)) return
          seen.add(key)
          edges.push([
            [verts[a * 3] as number, verts[a * 3 + 1] as number, verts[a * 3 + 2] as number],
            [verts[b * 3] as number, verts[b * 3 + 1] as number, verts[b * 3 + 2] as number],
          ])
        }
        for (let t = 0; t + 2 < ft.length; t += 3) {
          edge(ft[t] as number, ft[t + 1] as number)
          edge(ft[t + 1] as number, ft[t + 2] as number)
          edge(ft[t + 2] as number, ft[t] as number)
        }
      }

      const toScene = (along: number, cross: [number, number]): Vec3 => [along, cross[0], cross[1]]
      const normal = (): Vec3 => [0, 1, 0]

      for (const face of ['v', 'o', 'u', 'h'] as const) {
        const single = projectNc(
          {
            contours: geo.contours.filter((c) => c.face === face),
            holes: [],
            notches: [],
            marks: [],
          },
          { frame, section: section.points, toScene, normal },
        )
        const pts: number[] = []
        for (const cut of single.cuts) pts.push(...cut.points)
        let worst = 0
        let sample = ''
        let n = 0
        for (let i = 0; i + 5 < pts.length; i += 6) {
          const p0: [number, number, number] = [
            pts[i] as number,
            pts[i + 1] as number,
            pts[i + 2] as number,
          ]
          const p1: [number, number, number] = [
            pts[i + 3] as number,
            pts[i + 4] as number,
            pts[i + 5] as number,
          ]
          const mid: [number, number, number] = [
            (p0[0] + p1[0]) / 2,
            (p0[1] + p1[1]) / 2,
            (p0[2] + p1[2]) / 2,
          ]
          // Nearest edge by midpoint, then require *both endpoints* to lie on that same edge —
          // a mirrored segment sits near a mirrored edge at the midpoint but its ends run off it.
          let best = Infinity
          let near: [number, number, number][] = [
            [0, 0, 0],
            [0, 0, 0],
          ]
          for (const [a, b] of edges) {
            const d = segPointDist(mid, a, b)
            if (d < best) {
              best = d
              near = [a, b]
            }
          }
          const on = Math.max(
            segPointDist(p0, near[0], near[1]),
            segPointDist(p1, near[0], near[1]),
          )
          n++
          if (on > worst) {
            worst = on
            sample = `${p0.map((v) => v.toFixed(1)).join(',')}→${p1.map((v) => v.toFixed(1)).join(',')}`
          }
        }
        if (n > 0)
          console.log(
            `  ${mark} ${header.profile} face ${face}: ${n} seg, worst ${worst.toFixed(2)}mm at [${sample}]`,
          )
      }
    }, 300000)
  }
})
