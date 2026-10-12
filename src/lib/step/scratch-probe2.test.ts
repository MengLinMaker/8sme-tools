import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw31Top } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const NW31 = nw31Top()
const HAVE = existsSync(join(NW31, 'NC files', 'm31.nc1'))

type Pt = [number, number]

function dedupe(pts: Pt[]): Pt[] {
  const out = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1])
  if (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  )
    out.pop()
  return out
}

/** Scratch: is the band fuse lossy for m31's axis-0 inputs? Compares prism volumes. */
describe.skipIf(!HAVE)('fuse probe', () => {
  it('measures fused vs separate prism volumes', async () => {
    await setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))
    const { ensureOc } = await import('./occInit')
    await ensureOc()
    const { draw, measureVolume } = await import('replicad')
    const nc = readFileSync(join(NW31, 'NC files', 'm31.nc1'), 'utf8')
    const geo = parseNcGeometry(nc)
    // axis-0 = o/u faces for PFC (mirror the pipeline's local choices minimally):
    // here we just fuse the o outline + u outline + start band and compare volumes.
    const o = geo.contours.find((c) => c.face === 'o' && c.kind === 'outer')
    const u = geo.contours.find((c) => c.face === 'u' && c.kind === 'outer')
    if (!o || !u) throw new Error('no o/u')
    const half = 25
    const oPts = dedupe(o.points).map(([x, y]) => [x, y - half] as Pt)
    const uPts = dedupe(u.points).map(([x, y]) => [x, y - half] as Pt)
    const poly = (pts: Pt[]) => {
      let pen = draw(pts[0])
      for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i])
      return pen.close()
    }
    const asPrism = (d: unknown) =>
      (d as { sketchOnPlane: (p: string) => { extrude: (h: number) => unknown } })
        .sketchOnPlane('XY')
        .extrude(10) as { clone: () => never }
    const vPrism = (d: unknown) => measureVolume(asPrism(d) as never)
    const oP = poly(oPts)
    const uP = poly(uPts)
    const bandP = poly([
      [0 - 2, -half - 2],
      [25.52, -half - 2],
      [25.52, half + 2],
      [0 - 2, half + 2],
    ])
    console.log(
      `o=${vPrism(oP).toFixed(0)} u=${vPrism(uP).toFixed(0)} band=${vPrism(bandP).toFixed(0)}`,
    )
    const fusedOU = (oP as unknown as { fuse: (o: unknown) => unknown }).fuse(uP)
    console.log(`fused(o,u)=${fusedOU ? vPrism(fusedOU).toFixed(0) : 'null'}`)
    if (fusedOU) {
      const fusedOUB = (fusedOU as unknown as { fuse: (o: unknown) => unknown }).fuse(bandP)
      console.log(`fused(o,u,band)=${fusedOUB ? vPrism(fusedOUB).toFixed(0) : 'null'}`)
      // union bound: fused <= o+u+band, and >= max(o+u, band)
      const ou = fusedOU ? vPrism(fusedOU) : 0
      console.log(
        `o+u+band=${(vPrism(oP) + vPrism(uP) + vPrism(bandP)).toFixed(0)} ou=${ou.toFixed(0)}`,
      )
    }
    expect(true).toBe(true)
  }, 300000)
})
