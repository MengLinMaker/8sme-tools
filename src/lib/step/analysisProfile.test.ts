import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { nw30Bottom } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { type MeasurableShape, measureShape } from '@/lib/step/measure'
import { meshStepFile } from '@/lib/step/mesh'
import { ensureOc, setOcWasmUrl } from '@/lib/step/occInit'
import { reconstructSolidFromNc } from '@/lib/step/reconstructFromNc'
import { type MeshableShape, sabreShape } from '@/lib/step/sabre'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

const DIR = nw30Bottom()
const MARKS = ['m105', 'm106', 'm107', 'm108', 'a2']
const HAVE = MARKS.every(
  (m) => existsSync(join(DIR, `${m}.nc1`)) && existsSync(join(DIR, `${m}.stp`)),
)

/**
 * Bottleneck profile for the preflight analysis pipeline: per-part OCC costs
 * (STEP import, measure + light-sabre, tessellation, NC rebuild with and
 * without reference orientation). Analysis fans these across 3 workers, so
 * divide wall time by ~3 — but every part still pays each column, which is
 * what hurts 350-part jobs.
 */
describe.skipIf(!HAVE)('analysis pipeline profile', () => {
  it('times each OCC stage across parts', async () => {
    await ensureOc()
    const { importSTEP } = await import('replicad')
    const rows: string[][] = []
    for (const mark of MARKS) {
      const ncText = readFileSync(join(DIR, `${mark}.nc1`), 'utf8')
      const stepBytes = new Uint8Array(readFileSync(join(DIR, `${mark}.stp`)))

      let start = performance.now()
      const shape = (await importSTEP(
        new Blob([new Uint8Array(stepBytes)], { type: 'model/step' }),
      )) as unknown as MeasurableShape & MeshableShape & { delete: () => void }
      const importMs = performance.now() - start

      start = performance.now()
      const measure = await measureShape(shape).catch(() => null)
      const sabre = (() => {
        try {
          return sabreShape(shape)
        } catch {
          return null
        }
      })()
      const inspectMs = performance.now() - start
      shape.delete()

      start = performance.now()
      await meshStepFile(`${mark}·mesh`, stepBytes)
      const meshMs = performance.now() - start

      start = performance.now()
      const full = await reconstructSolidFromNc(ncText, { reference: stepBytes })
      const rebuildFullMs = performance.now() - start

      start = performance.now()
      const plain = await reconstructSolidFromNc(ncText)
      const rebuildPlainMs = performance.now() - start

      start = performance.now()
      const lean = await reconstructSolidFromNc(ncText, { reference: stepBytes, measureOnly: true })
      const rebuildLeanMs = performance.now() - start

      expect(measure).not.toBeNull()
      expect(sabre).not.toBeNull()
      expect(full).not.toBeNull()
      expect(plain).not.toBeNull()
      expect(lean).not.toBeNull()
      // Orientation must not change the measured solid (frame only): the
      // no-reference fast path has to agree with the full rebuild.
      if (full && plain) {
        const [a, b] = await Promise.all([
          measureShape(full.solid).catch(() => null),
          measureShape(plain.solid).catch(() => null),
        ])
        expect(a).not.toBeNull()
        expect(b).not.toBeNull()
        if (a && b) {
          expect(Math.abs(a.volume - b.volume) / Math.max(a.volume, 1)).toBeLessThan(0.01)
        }
      }
      // The measure-only fast path skips orientation: same solid, less work.
      if (full && lean) {
        const [a, c] = await Promise.all([
          measureShape(full.solid).catch(() => null),
          measureShape(lean.solid).catch(() => null),
        ])
        expect(c).not.toBeNull()
        if (a && c) {
          expect(c.bodies).toBe(a.bodies)
          expect(Math.abs(a.volume - c.volume) / Math.max(a.volume, 1)).toBeLessThan(0.01)
        }
      }
      rows.push([
        mark,
        importMs.toFixed(0),
        inspectMs.toFixed(0),
        meshMs.toFixed(0),
        rebuildFullMs.toFixed(0),
        rebuildPlainMs.toFixed(0),
        rebuildLeanMs.toFixed(0),
      ])
    }
    const head = [
      'part',
      'import',
      'measure+sabre',
      'mesh',
      'rebuild+orient',
      'rebuild plain',
      'rebuild lean',
    ]
    const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
    const line = (cells: string[]) => `  ${cells.map((c, i) => c.padEnd(width[i] ?? 0)).join('  ')}`
    console.log(
      `\nanalysis pipeline profile (ms per part):\n${line(head)}\n${rows.map(line).join('\n')}`,
    )
  }, 600000)
})
