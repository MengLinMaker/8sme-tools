import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { partSectionForCode } from '@/lib/sections/stock'

const NW31 = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-03-01 (NW31 Top frames) Shaft part drawings',
  'Shaft part drawings',
)

type Axis = 0 | 1

/** Scratch: replicate the pipeline's axis assignment + trim ranges for m31/m41. */
describe('axis assignment probe', () => {
  it('prints per-axis faces, loop ranges, bands, rect', () => {
    for (const mark of ['m31', 'm41', 'm71', 'm143']) {
      const dir =
        mark === 'm71'
          ? join(
              process.env.USERPROFILE ?? '',
              'Downloads',
              'Failed tests',
              '11601-02-01 NW30 BOTTOM FRAMES - SHAFTS',
            )
          : join(NW31, 'NC files')
      const nc = readFileSync(join(dir, `${mark}.nc1`), 'utf8')
      const header = parseDstv(nc).header
      const geo = parseNcGeometry(nc)
      const section = partSectionForCode(header.profile, header.dimensions)
      const ex =
        Math.max(...(section?.points.map((p) => p[0]) ?? [0])) -
        Math.min(...(section?.points.map((p) => p[0]) ?? [0]))
      const ey =
        Math.max(...(section?.points.map((p) => p[1]) ?? [0])) -
        Math.min(...(section?.points.map((p) => p[1]) ?? [0]))
      const outer = geo.contours.filter((c) => c.kind === 'outer')
      const maxCoord = (c: (typeof outer)[number]) => Math.max(...c.points.map((p) => p[1]))
      const matchAxis = (yMax: number): Axis => (Math.abs(yMax - ex) <= Math.abs(yMax - ey) ? 0 : 1)
      const vh = outer.find((c) => c.face === 'v' || c.face === 'h')
      const ou = outer.find((c) => c.face === 'o' || c.face === 'u')
      const axisVH: Axis = vh
        ? matchAxis(maxCoord(vh))
        : ou
          ? ((1 - matchAxis(maxCoord(ou))) as Axis)
          : 0
      const axisOU = (1 - axisVH) as Axis
      console.log(
        `${mark} profile=${header.profile} ex=${ex.toFixed(1)} ey=${ey.toFixed(1)} axisVH=${axisVH} axisOU=${axisOU}`,
      )
      const allX = outer.flatMap((c) => c.points.map((p) => p[0]))
      console.log(`  globalX=[${Math.min(...allX).toFixed(2)}..${Math.max(...allX).toFixed(2)}]`)
      for (const axis of [0, 1] as Axis[]) {
        const faces = outer.filter((c) =>
          axis === axisVH ? c.face === 'v' || c.face === 'h' : c.face === 'o' || c.face === 'u',
        )
        for (const c of faces) {
          const xs = c.points.map((p) => p[0])
          console.log(
            `  axis${axis} face=${c.face} x=[${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)}] n=${c.points.length}`,
          )
        }
      }
    }
    expect(true).toBe(true)
  }, 120000)
})
