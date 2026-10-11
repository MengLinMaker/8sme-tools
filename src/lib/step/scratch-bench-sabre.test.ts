import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assessCutReachGeometry } from '@/lib/audit/cutReach'
import { parseDstv } from '@/lib/parsers/dstv'
import { parseNcGeometry } from '@/lib/parsers/ncGeometry'
import { partSectionForCode } from '@/lib/sections/stock'
import { type MeasurableShape, measureShape } from './measure'
import { setOcWasmUrl } from './occInit'
import { type MeshableShape, sabreShape } from './sabre'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const DIR = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-02-01 NW31 BOTTOM & MIDDLE FRAMES - Shafts',
)

function marks(limit: number): string[] {
  return readdirSync(DIR)
    .filter((f) => /^m\d+\.stp$/.test(f))
    .map((f) => f.replace(/\.stp$/, ''))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    .slice(0, limit)
}

describe('sabre cost benchmark', () => {
  it('times import / measure / sabre / cutReach per part', async () => {
    const { ensureOc } = await import('./occInit')
    await ensureOc()
    const { importSTEP } = await import('replicad')
    const list = marks(Number(process.env.BENCH_PARTS ?? 12))

    let importMs = 0
    let measureMs = 0
    let sabreMs = 0
    let reachMs = 0
    const rows: string[][] = []
    for (const mark of list) {
      const stepBytes = new Uint8Array(readFileSync(join(DIR, `${mark}.stp`)))
      const ncText = readFileSync(join(DIR, `${mark}.nc1`), 'utf8')

      let t = performance.now()
      const shape = (await importSTEP(
        new Blob([stepBytes], { type: 'model/step' }),
      )) as unknown as MeasurableShape & MeshableShape & { delete: () => void }
      const iMs = performance.now() - t
      importMs += iMs

      t = performance.now()
      await measureShape(shape).catch(() => null)
      const mMs = performance.now() - t
      measureMs += mMs

      t = performance.now()
      sabreShape(shape)
      const sMs = performance.now() - t
      sabreMs += sMs
      shape.delete()

      t = performance.now()
      const header = parseDstv(ncText).header
      const section = partSectionForCode(header.profile, header.dimensions)
      if (section)
        assessCutReachGeometry(parseNcGeometry(ncText), section.points, section.holes ?? [])
      const rMs = performance.now() - t
      reachMs += rMs

      rows.push([mark, iMs.toFixed(0), mMs.toFixed(0), sMs.toFixed(0), rMs.toFixed(2)])
    }
    console.log(
      `\nper part (ms):\nmark    import  measure  sabre  cutReach\n${rows
        .map((r) => r.map((c, i) => c.padEnd(i === 0 ? 6 : 7)).join(' '))
        .join('\n')}`,
    )
    const n = list.length
    console.log(
      `\nTOTALS over ${n} parts (ms): import=${importMs.toFixed(0)} measure=${measureMs.toFixed(0)} sabre=${sabreMs.toFixed(0)} cutReach=${reachMs.toFixed(2)}`,
    )
    console.log(
      `avg/part: sabre=${(sabreMs / n).toFixed(1)}ms  cutReach=${(reachMs / n).toFixed(3)}ms  ratio=${(sabreMs / Math.max(reachMs, 0.001)).toFixed(0)}x`,
    )
    expect(n).toBeGreaterThan(0)
  }, 900000)
})
