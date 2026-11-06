import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { type NcepPackage, parseNcepPackage } from './ncepParse'
import { crc32 } from './ncex'
import { type RawZipEntry, readZipRaw, writeZipRaw } from './probeZip'

/**
 * Round 10: are the provided "corrected marking" exemplars themselves etch or cut?
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-round10 \
 *     pnpm exec vitest run src/lib/wisecam/probes.round10.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES
type Files = Record<string, Uint8Array>

function rename(text: string, from: string, to: string): string {
  return text
    .split(`Name=${from}`)
    .join(`Name=${to}`)
    .split(`Part=${from}`)
    .join(`Part=${to}`)
    .split(`LabelContent=${from}`)
    .join(`LabelContent=${to}`)
    .split(`>${from}</text>`)
    .join(`>${to}</text>`)
}

function report(
  file: string,
  mark: string,
  variant: string,
  pkg: NcepPackage,
): Record<string, unknown> {
  return {
    file,
    mark,
    variant,
    errors: pkg.issues.filter((i) => i.severity === 'error').map((i) => i.code),
    warnings: pkg.issues.filter((i) => i.severity === 'warning').map((i) => i.code),
  }
}

function make(
  name: string,
  path: string,
  from: string,
  to: string,
  write: (name: string, entries: RawZipEntry[], mark: string, variant: string) => void,
): void {
  const raw = new Uint8Array(readFileSync(path))
  const entries = readZipRaw(raw)
  const files = unzipSync(raw) as Files
  const edited = entries.map((entry) => {
    const text = strFromU8(files[entry.name] as Uint8Array)
    if (!text.includes(from)) return entry
    const data = strToU8(rename(text, from, to))
    if (entry.method === 0)
      return {
        ...entry,
        compressed: data,
        compressedSize: data.length,
        uncompressedSize: data.length,
        crc: crc32(data),
      }
    const compressed = new Uint8Array(deflateRawSync(data))
    return {
      ...entry,
      compressed,
      compressedSize: compressed.length,
      uncompressedSize: data.length,
      crc: crc32(data),
    }
  })
  write(name, edited, to, 'renamed real control')
}

describe.skipIf(!outDir)('round 10 exemplar controls', () => {
  it('writes 2500-2503', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Record<string, unknown>[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }

    const pfc = 'test/fixtures/ncep/reference-variations/PFC corrected marking.ncep'
    const ub = 'test/fixtures/ncep/reference-variations/UB corrected marking.ncep'
    const pfcControl = 'test/fixtures/ncep/reference-variations/PFC.ncep'
    const ubControl = 'test/fixtures/ncep/reference-variations/UB.ncep'
    make(
      '2500 PFC corrected exemplar.ncep',
      pfc,
      'PFC corrected marking',
      '2500 PFC corrected exemplar',
      write,
    )
    make(
      '2501 UB corrected exemplar.ncep',
      ub,
      'UB corrected marking',
      '2501 UB corrected exemplar',
      write,
    )
    make('2502 PFC layer6 control.ncep', pfcControl, 'PFC', '2502 PFC layer6 control', write)
    make('2503 UB layer6 control.ncep', ubControl, 'UB', '2503 UB layer6 control', write)

    expect(reports).toHaveLength(4)
    const readme = [
      'Round 10 exemplar controls (2500–2503)',
      '',
      'Question: do the provided corrected-marking exemplars etch, or do they become cuts?',
      '- 2500 PFC corrected marking (layer-4) renamed only',
      '- 2501 UB corrected marking (layer-4) renamed only',
      '- 2502 PFC layer-6 control (known etch)',
      '- 2503 UB layer-6 control (known etch)',
      '',
      'If 2500/2501 etch, the exemplar layer-4 form is valid and our generated package is missing context.',
      'If 2500/2501 cut, the exemplar itself does not etch under this WiseCAM setup.',
      '',
      '## Matrix',
      '| File | CadRoot Name | Variant | Errors | Warnings |',
      '| --- | --- | --- | --- | --- |',
      ...reports.map(
        (r) =>
          `| ${r.file} | ${r.mark} | ${r.variant} | ${(r.errors as string[]).join(', ') || 'ok'} | ${(r.warnings as string[]).join(', ') || 'ok'} |`,
      ),
      '',
    ].join('\n')
    writeFileSync(join(out, 'README.txt'), readme)
    const zipFiles: Record<string, Uint8Array> = {}
    for (const file of reports)
      zipFiles[file.file as string] = new Uint8Array(readFileSync(join(out, file.file as string)))
    zipFiles['README.txt'] = strToU8(readme)
    writeFileSync(`${out.replace(/\/+$/, '')}.zip`, zipSync(zipFiles, { level: 6 }))
  })
})
