import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { parseDstv } from '@/lib/parsers/dstv'
import { partSectionForCode } from '@/lib/sections/stock'
import { ensureOc, setOcWasmUrl } from './occInit'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const BASE = join(
  process.env.USERPROFILE ?? '',
  'Downloads',
  'Failed tests',
  '11602-03-01 (NW31 Top frames) Shaft part drawings',
  'Shaft part drawings',
)

describe('scratch', () => {
  it('draws real sections', async () => {
    await ensureOc()
    const { draw } = await import('replicad')
    for (const mark of ['m41', 'm31', 'm124', 'm117', 'a1', 'm143']) {
      const header = parseDstv(readFileSync(join(BASE, 'NC files', `${mark}.nc1`), 'utf8')).header
      const s = partSectionForCode(header.profile, header.dimensions)
      // eslint-disable-next-line no-console
      console.log(
        mark,
        'profile',
        header.profile,
        'dims',
        JSON.stringify(header.dimensions),
        'pts',
        s?.points.length,
      )
      if (!s) continue
      const bad = s.points.filter((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      if (bad.length) {
        // eslint-disable-next-line no-console
        console.log(mark, 'NON-FINITE', JSON.stringify(bad))
        continue
      }
      let pen = draw(s.points[0])
      for (let i = 1; i < s.points.length; i++) pen = pen.lineTo(s.points[i])
      const shape = pen.close().sketchOnPlane('YZ').extrude(100)
      // eslint-disable-next-line no-console
      console.log(mark, 'draw ok', !!shape)
    }
  }, 120000)
})
