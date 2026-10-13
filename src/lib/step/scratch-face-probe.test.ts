import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw31Top } from '@test/fixtures'
import { describe, it } from 'vitest'
import { ensureOc, setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const FILES: [string, string][] = [
  ['m143 T', join(nw31Top('STP files'), 'm143.stp')],
  ['m31 PFC', join(nw31Top('STP files'), 'm31.stp')],
]

describe('scratch: OCC face probe', () => {
  it('lists faces with surface type + normal', async () => {
    await import('replicad')
    await ensureOc()
    const { getOC, importSTEP, iterTopo, cast } = await import('replicad')
    const oc = getOC() as any
    const toBlob = (b: Uint8Array) => new Blob([new Uint8Array(b)], { type: 'model/step' })

    for (const [label, path] of FILES) {
      const shape = (await importSTEP(toBlob(new Uint8Array(readFileSync(path))))) as any
      const wrapped = shape.wrapped
      const faces = [...iterTopo(wrapped as never, 'face')]
      console.log(`\n=== ${label}: ${faces.length} faces ===`)
      let i = 0
      for (const f of faces) {
        const c = cast(f as never) as any
        const bb = c.boundingBox.bounds as [number[], number[]]
        let info = ''
        try {
          const surf = new oc.BRepAdaptor_Surface(f, true)
          const type = surf.GetType()
          info = `type=${type}`
          if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
            const pln = surf.Plane()
            const ax = pln.Axis().Direction()
            info += ` n=(${ax.X().toFixed(2)},${ax.Y().toFixed(2)},${ax.Z().toFixed(2)})`
          } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
            const cyl = surf.Cylinder()
            info += ` r=${cyl.Radius().toFixed(2)}`
          }
        } catch (e) {
          info = `ERR ${e}`
        }
        if (i < 40)
          console.log(
            `#${i} ${info} area? bb=[${bb[0].map((v) => v.toFixed(0)).join(',')}]..[${bb[1].map((v) => v.toFixed(0)).join(',')}]`,
          )
        i++
      }
      shape.delete()
    }
  }, 600000)
})
