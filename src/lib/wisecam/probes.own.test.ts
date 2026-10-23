import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { buildNcepFromNc, partFromNc } from './fromNc'
import { buildNcex } from './ncex'

/**
 * Full own-part probes from our writer: no real NCEP bytes, only the real NC geometry.
 * These test the package we now believe is correct — sibling `cadgroup`, a fresh
 * `technologyID`, and for PFC the second (inner) section path that real exports carry.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-own \
 *     pnpm exec vitest run src/lib/wisecam/probes.own.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES
function readNc(mark: string): string {
  return readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8')
}

function writeOwn(file: string, mark: string, name: string, dropInner = false): void {
  const nc = readNc(mark)
  let bytes: Uint8Array | null
  if (dropInner) {
    const part = partFromNc(nc, { mark: name })
    if (!part) throw new Error(`cannot develop ${mark}`)
    part.innerSection = undefined
    bytes = buildNcex([part])
  } else {
    bytes = buildNcepFromNc(nc, { mark: name })
  }
  if (!bytes) throw new Error(`cannot build ${mark}`)
  writeFileSync(join(outDir as string, file), bytes)
}

describe.skipIf(!outDir)('write full own-part probes', () => {
  it('writes 240-245', () => {
    mkdirSync(outDir as string, { recursive: true })

    // The decisive test: own PFC with the outer + inner section paths.
    writeOwn('240-M-1-own-2path.ncep', 'M-1', 'M-1-240')
    // Same part with the inner path removed: expected to reproduce the old failure.
    writeOwn('241-M-1-own-1path-control.ncep', 'M-1', 'M-1-241', true)
    // UB: real exports have only the outer section path.
    writeOwn('242-M-3-own-1path.ncep', 'M-3', 'M-3-242')
    // Hollow SHS: two section paths (outer + void).
    writeOwn('243-M-35-own-2path.ncep', 'M-35', 'M-35-243')
    // RHS and a second PFC, so a pass is not one lucky section.
    writeOwn('244-M-42-own-2path.ncep', 'M-42', 'M-42-244')
    writeOwn('245-M-34-own-2path.ncep', 'M-34', 'M-34-245')

    const part = partFromNc(readNc('M-1'), { mark: 'M-1-240' })
    expect(part?.innerSection?.length).toBeGreaterThan(4)

    writeFileSync(
      join(outDir as string, 'README.txt'),
      [
        'Full own-part NCEP probes — our writer, real NC geometry, no copied package bytes.',
        '',
        '240 M-1 PFC380  own, outer + inner section paths (the new fix; expected to load)',
        '241 M-1 PFC380  same, inner path removed (control; expected to fail like 226)',
        '242 M-3 UB310   own, outer section only (expected to load)',
        '243 M-35 SHS89  own, outer + void (expected to load)',
        '244 M-42 RHS100x50 own, outer + void',
        '245 M-34 PFC300 own, outer + inner section paths',
        '',
        'Names are unique (M-1-240 …) so WiseCAM cannot reuse a cached part.',
        'If 240/242/243/244/245 all load, the writer is cracked; 241 should still fail.',
        '',
      ].join('\n'),
    )
  }, 120_000)
})
