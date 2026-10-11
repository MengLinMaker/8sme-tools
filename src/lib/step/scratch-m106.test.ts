import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { ensureOc, setOcWasmUrl } from './occInit'
import { sabreRegions, sabreShape, type MeshableShape } from './sabre'
import { locateSabreStations } from './sabreToNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const DIR = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  process.env.SABRE_DIR ?? '11601-02-01 NW30 BOTTOM FRAMES - SHAFTS',
)
const MARK = process.env.SABRE_MARK ?? 'm106'

describe('scratch m106 sabre', () => {
  it('dumps failures', async () => {
    await ensureOc()
    const { importSTEP } = await import('replicad')
    const bytes = new Uint8Array(readFileSync(join(DIR, `${MARK}.stp`)))
    const shape = (await importSTEP(
      new Blob([bytes], { type: 'model/step' }),
    )) as unknown as MeshableShape & { delete: () => void }
    const mesh = shape.mesh({ tolerance: 0.1, angularTolerance: 0.3 })
    const result = sabreShape(shape)
    shape.delete()

    let min = [Infinity, Infinity, Infinity]
    let max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i + 2 < mesh.vertices.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] ?? Infinity, mesh.vertices[i + k] ?? Infinity)
        max[k] = Math.max(max[k] ?? -Infinity, mesh.vertices[i + k] ?? -Infinity)
      }
    }
    console.log(`${MARK} bounds min=${min.map((v) => v.toFixed(1))} max=${max.map((v) => v.toFixed(1))}`)
    console.log(
      `${MARK} sizes=${[max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((v) => v.toFixed(1))}`,
    )
    console.log(`${MARK} ok=${result.ok} checked=${result.checked} failures=${result.failures.length}`)

    const regions = sabreRegions(result.failures)
    console.log(`${MARK} regions=${regions.length}`)
    for (const r of regions) {
      console.log(
        `  region pt=${r.point.map((v) => v.toFixed(1))} tris=${r.triangles} area=${r.area.toFixed(1)} depth=${r.depth.toFixed(1)} bores=${r.bores.length}`,
      )
    }
    for (const f of result.failures) {
      console.log(
        `  fail pt=${f.point.map((v) => v.toFixed(1))} n=${f.normal.map((v) => v.toFixed(2))} t=${f.thickness.toFixed(1)} area=${f.area.toFixed(1)} entry=${f.entry.map((v) => v.toFixed(1))} exit=${f.exit.map((v) => v.toFixed(1))}`
      )
      console.log(`    tri=${f.tri.map((t) => `(${t.map((v) => v.toFixed(1)).join(',')})`).join(' ')}`)
    }

    const nc = parseNcGeometry(readFileSync(join(DIR, `${MARK}.nc1`), 'utf8'))
    const stations = locateSabreStations(mesh.vertices, result.failures, nc)
    console.log(`${MARK} stations=${JSON.stringify(stations)}`)
    expect(true).toBe(true)
  }, 600000)
})
