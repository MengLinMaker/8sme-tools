import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setOcWasmUrl } from './occInit'
import { reconstructSolidFromNc } from './reconstructFromNc'

const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))

/**
 * Sabre tessellation benchmark (opt-in so the normal suite stays fast):
 *
 *   SME_BENCH=1 pnpm vitest run src/lib/step/sabre.bench.test.ts
 *
 * Uses `SME_BENCH_DIR` when set, else the real Luenard job if it is on this machine. Every
 * resolution must produce the *same* cut-line failures as the finest baseline — this is the
 * guard that lets us coarsen the probe without changing what gets flagged.
 */
const DIR =
  process.env.SME_BENCH_DIR ?? join(homedir(), 'Downloads/selected-26-Luenard-Balwyn-North.zip')
const RUN = process.env.SME_BENCH === '1' && existsSync(DIR)

const COMBOS = [
  { label: 'old 0.1 / 0.3rad', mesh: { tolerance: 0.1, angularTolerance: 0.3 } },
  { label: 'viewer 0.3 / 20', mesh: { tolerance: 0.3, angularTolerance: 20 } },
  { label: '0.5 / 20', mesh: { tolerance: 0.5, angularTolerance: 20 } },
  { label: '1.0 / 20', mesh: { tolerance: 1.0, angularTolerance: 20 } },
] as const

const signature = (failures: { point: number[] }[]): string =>
  failures.map((failure) => failure.point.map((v) => v.toFixed(1)).join(',')).join('|')

describe.runIf(RUN)('sabre tessellation benchmark', () => {
  it('keeps the same failures while the probe mesh gets coarser', async () => {
    const files = readdirSync(DIR)
      .filter((file) => file.endsWith('.nc1'))
      .sort()
    const texts = files.map((file) => readFileSync(join(DIR, file), 'utf8'))

    // Warm the OCC kernel so the first timed combo is not paying for the WASM boot.
    await reconstructSolidFromNc(texts[0] as string, { measureOnly: true, sabre: false })

    let baseline: string | null = null
    for (const combo of COMBOS) {
      const started = performance.now()
      const outcomes: string[] = []
      for (let i = 0; i < files.length; i++) {
        const built = await reconstructSolidFromNc(texts[i] as string, {
          measureOnly: true,
          sabreMesh: combo.mesh,
        })
        outcomes.push(`${files[i]}:${signature(built?.sabre ?? [])}`)
      }
      const elapsed = performance.now() - started
      const joined = outcomes.join('\n')
      baseline ??= joined
      expect(joined, `${combo.label} changed the CUT_DEPTH failures`).toBe(baseline)
      console.log(`BENCH ${combo.label.padEnd(18)} ${elapsed.toFixed(0)} ms`)
    }
  }, 900_000)
})
