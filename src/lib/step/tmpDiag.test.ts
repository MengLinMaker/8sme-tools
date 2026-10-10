import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureOc, setOcWasmUrl } from './occInit'
import { reconstructStepFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const BASE = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-03-01 (NW31 Top frames) Shaft part drawings',
  'Shaft part drawings',
)
const HAVE = existsSync(join(BASE, 'NC files', 'm164.nc1'))

interface Box {
  bounds: [number[], number[]]
}
type Shape = {
  boundingBox: Box
  intersect: (o: unknown) => Shape
}
type Volume = (s: never) => number

describe.skipIf(!HAVE)('diag m164', () => {
  it('slices built vs real', async () => {
    await ensureOc()
    const { importSTEP, measureVolume, makeBox } = await import('replicad')

    const builtStep = await reconstructStepFromNc(
      readFileSync(join(BASE, 'NC files', 'm164.nc1'), 'utf8'),
    )
    if (!builtStep) throw new Error('no step')
    const built = (await importSTEP(
      new Blob([new TextEncoder().encode(builtStep)]),
    )) as unknown as Shape
    const real = (await importSTEP(
      new Blob([new Uint8Array(readFileSync(join(BASE, 'STP files', 'm164.stp')))]),
    )) as unknown as Shape
    const vol = measureVolume as unknown as Volume

    const info = (s: Shape) => {
      const bb = s.boundingBox.bounds
      return { min: bb[0], max: bb[1], vol: vol(s as never) }
    }
    const bi = info(built)
    const ri = info(real)
    const fmt = (v: number[]) => v.map((x) => x.toFixed(1)).join(',')
    console.log('built', fmt(bi.min), '|', fmt(bi.max), (bi.vol / 1e6).toFixed(4))
    console.log('real ', fmt(ri.min), '|', fmt(ri.max), (ri.vol / 1e6).toFixed(4))

    const ext = (i: ReturnType<typeof info>) => i.max.map((v, k) => v - i.min[k])
    const axisOf = (e: number[]) => e.indexOf(Math.max(...e))
    const bAxis = axisOf(ext(bi))
    const rAxis = axisOf(ext(ri))

    const slice = (s: Shape, min: number[], axis: number, x: number, thick = 1) => {
      const c1 = [...min]
      const c2 = [...min]
      for (let k = 0; k < 3; k++) {
        if (k === axis) {
          c1[k] = x
          c2[k] = x + thick
        } else {
          c1[k] = min[k] - 100
          c2[k] = min[k] + 300
        }
      }
      const box = makeBox(c1 as never, c2 as never)
      return (s as unknown as { intersect: (o: never) => Shape }).intersect(box as never)
    }
    const areaAt = (s: Shape, min: number[], axis: number, x: number) => vol(slice(s, min, axis, x) as never)

    const stations: number[] = []
    for (let x = 0; x <= 60; x += 4) stations.push(x)
    for (let x = 1830; x <= 1880; x += 1) stations.push(x)

    for (const st of stations) {
      const ba = areaAt(built, bi.min, bAxis, bi.min[bAxis] + st)
      const ra = areaAt(real, ri.min, rAxis, ri.min[rAxis] + st)
      let extra = ''
      if (st >= 1862) {
        const bb = slice(built, bi.min, bAxis, bi.min[bAxis] + st).boundingBox.bounds
        extra = `\tbuilt[y ${bb[0][1].toFixed(1)}..${bb[1][1].toFixed(1)} z ${bb[0][2].toFixed(1)}..${bb[1][2].toFixed(1)}]`
      }
      console.log(`x=${st}\tbuilt ${ba.toFixed(1)}\treal ${ra.toFixed(1)}\tdiff ${(ba - ra).toFixed(1)}${extra}`)
    }
    expect(true).toBe(true)
  }, 300000)
})
