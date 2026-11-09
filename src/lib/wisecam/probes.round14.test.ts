import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { fixture } from '@test/fixtures'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildNcepFromNc } from './fromNc'
import { parseNcepPackage } from './ncepParse'
import { crc32 } from './ncex'
import { type RawZipEntry, readZipRaw, writeZipRaw } from './probeZip'

/**
 * Round 14: tube mitre trims now follow the corner cylinder, and a square face that is short of
 * the mitre by wall·tan(bevel) is snapped onto the outer cut. One question per part: does that
 * trim, with the current section arcs, match the control?
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-round14 \
 *     pnpm exec vitest run src/lib/wisecam/probes.round14.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES
type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

function rootOf(files: Files): string {
  return strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
}
function svgName(files: Files): string {
  const tag = rootOf(files).match(/<Part\b[^>]*\/>/)?.[0] ?? ''
  return /svgname="([^"]+)"/.exec(tag)?.[1] ?? ''
}
function lastGroup(svg: string): string {
  const start = svg.lastIndexOf('<g ')
  const end = svg.indexOf('</g>', start)
  if (start < 0 || end < 0) throw new Error('no group')
  return svg.slice(start, end + 4)
}
function editEntries(
  entries: RawZipEntry[],
  files: Files,
  edits: Record<string, Edit>,
): RawZipEntry[] {
  return entries.map((entry) => {
    const edit = edits[entry.name]
    if (!edit) return entry
    const data = strToU8(edit(strFromU8(files[entry.name] as Uint8Array)))
    if (entry.method === 0) {
      return {
        ...entry,
        compressed: data,
        compressedSize: data.length,
        uncompressedSize: data.length,
        crc: crc32(data),
      }
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
}

describe.skipIf(!outDir)('round 14 tube corner trims', () => {
  it('writes 2900-2931', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Record<string, unknown>[] = []
    const write = (name: string, bytes: Uint8Array, mark: string, variant: string): void => {
      writeFileSync(join(out, name), bytes)
      reports.push({
        file: name,
        mark,
        variant,
        errors: parseNcepPackage(bytes)
          .issues.filter((issue) => issue.severity === 'error')
          .map((issue) => issue.code),
        warnings: parseNcepPackage(bytes)
          .issues.filter((issue) => issue.severity === 'warning')
          .map((issue) => issue.code),
      })
    }
    const control = (code: number, mark: string): void => {
      write(
        `${code} ${mark} control.ncep`,
        new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`))),
        mark,
        'real control',
      )
    }
    const built = (code: number, mark: string, label: string, edit?: Edit): void => {
      const unique = `${code} ${mark} ${label}`
      const bytes = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
        mark: unique,
      })
      if (!bytes) throw new Error(`cannot build ${mark}`)
      if (!edit) {
        write(`${unique}.ncep`, bytes, unique, label)
        return
      }
      const files = unzipSync(bytes) as Files
      const partPath = `CAD/${svgName(files)}`
      write(
        `${unique}.ncep`,
        writeZipRaw(editEntries(readZipRaw(bytes), files, { [partPath]: edit })),
        unique,
        label,
      )
    }
    const realSection = (mark: string): Edit => {
      const raw = new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`)))
      const files = unzipSync(raw) as Files
      const part = strFromU8(files[`CAD/${svgName(files)}`] as Uint8Array)
      const section = lastGroup(part)
      return (svg) => svg.replace(lastGroup(svg), section)
    }

    control(2900, 'M-43')
    built(2901, 'M-43', 'corner trims')
    built(2902, 'M-43', 'real section', realSection('M-43'))
    control(2910, 'M-51')
    built(2911, 'M-51', 'corner trims')
    built(2912, 'M-51', 'real section', realSection('M-51'))
    control(2920, 'M-42')
    built(2921, 'M-42', 'corner trims')
    built(2922, 'M-42', 'real section', realSection('M-42'))
    control(2930, 'M-39')
    built(2931, 'M-39', 'section arcs')

    expect(reports).toHaveLength(11)
    const readme = [
      'Round 14: tube mitre trims follow the corner cylinder.',
      '',
      'Compare each standard file to its control. `real section` keeps the new trims and swaps in',
      'the control section, so a remaining shift is the section stance, not the trim.',
      'M-39 checks the section-arc recovery (collision map), not the trim.',
      'Do not retest mark text, font, angle or size — WiseCAM overwrites Part.Name.',
      '',
      '## Matrix',
      '| File | CadRoot Name | Variant | Errors | Warnings |',
      '| --- | --- | --- | --- | --- |',
      ...reports.map((row) => {
        const errors = (row.errors as string[]).join(', ') || 'ok'
        const warnings = (row.warnings as string[]).join(', ') || 'ok'
        return `| ${row.file} | ${row.mark} | ${row.variant} | ${errors} | ${warnings} |`
      }),
      '',
    ].join('\n')
    writeFileSync(join(out, 'README.txt'), readme)
    const zipFiles: Record<string, Uint8Array> = { 'README.txt': strToU8(readme) }
    for (const row of reports) {
      zipFiles[row.file as string] = new Uint8Array(readFileSync(join(out, row.file as string)))
    }
    writeFileSync(`${out.replace(/\/+$/, '')}.zip`, zipSync(zipFiles, { level: 6 }))
  })
})
