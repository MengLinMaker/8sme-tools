import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw31Top } from '@test/fixtures'
import { describe, it } from 'vitest'
import { ensureOc, setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

describe('scratch: OCC wire probe', () => {
  it('prints wire points for a planar face + cylinder axes', async () => {
    await import('replicad')
    await ensureOc()
    const { getOC, importSTEP, iterTopo, cast } = await import('replicad')
    const oc = getOC() as any
    const toBlob = (b: Uint8Array) => new Blob([new Uint8Array(b)], { type: 'model/step' })
    const shape = (await importSTEP(
      toBlob(new Uint8Array(readFileSync(join(nw31Top('STP files'), 'm143.stp')))),
    )) as any
    const faces = [...iterTopo(shape.wrapped as never, 'face')]

    // Face #16 in the earlier probe = plane normal (0,-1,0), flange face.
    const f = faces[16] as any
    console.log('meshEdges structure:', Object.keys((cast(f as never) as any).meshEdges({ tolerance: 1 })))
    const edges = (cast(f as never) as any).meshEdges({ tolerance: 1 })
    console.log('edges keys', Object.keys(edges))
    if (edges.lines) console.log('lines len', edges.lines.length, 'edgeGroups', edges.edgeGroups)

    // Iterate wires + edges via OCC.
    const exp = new oc.TopExp_Explorer(f, oc.TopAbs_ShapeEnum.TopAbs_WIRE)
    let wi = 0
    for (; exp.More(); exp.Next()) {
      const wire = exp.Current()
      const we = new oc.BRepTools_WireExplorer(wire)
      let ei = 0
      for (; we.More(); we.Next()) {
        const edge = we.Current()
        const curve = new oc.BRepAdaptor_Curve(edge)
        const p0 = curve.Value(curve.FirstParameter())
        const p1 = curve.Value(curve.LastParameter())
        const t = curve.GetType()
        console.log(
          `wire${wi} edge${ei} type=${t} from (${p0.X().toFixed(1)},${p0.Y().toFixed(1)},${p0.Z().toFixed(1)}) to (${p1.X().toFixed(1)},${p1.Y().toFixed(1)},${p1.Z().toFixed(1)})`,
        )
        ei++
      }
      wi++
    }

    // Cylinder axis for a hole (#18, r=7).
    const h = faces[18] as any
    const surf = new oc.BRepAdaptor_Surface(h, true)
    const cyl = surf.Cylinder()
    const ax = cyl.Axis()
    const loc = ax.Location()
    const dir = ax.Direction()
    console.log(
      `hole#18 axis loc=(${loc.X().toFixed(1)},${loc.Y().toFixed(1)},${loc.Z().toFixed(1)}) dir=(${dir.X().toFixed(2)},${dir.Y().toFixed(2)},${dir.Z().toFixed(2)}) r=${cyl.Radius().toFixed(2)}`,
    )
    shape.delete()
  }, 600000)
})
