import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { fixture } from '@test/fixtures'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildNcepFromNc } from './fromNc'
import { type NcepPackage, parseNcepPackage } from './ncepParse'
import { crc32 } from './ncex'
import { type RawZipEntry, readZipRaw, writeZipRaw } from './probeZip'

/**
 * Mark-writing confirmation: improved packages with the writer's NC marks and no real-mark
 * injection. If the bars/etchings appear, NC marks are being emitted correctly.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-markwrite \
 *     pnpm exec vitest run src/lib/wisecam/probes.markWrite.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

interface Real {
  internalMark: string
  entries: RawZipEntry[]
  files: Files
  partPath: string
  adobePath: string
  partId: string
  section: string
  trims: { start: string; end: string }
  holes: string
}

function rootOf(files: Files): string {
  return strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
}

function svgName(files: Files, kind: 'Adobe' | 'Part'): string {
  const root = rootOf(files)
  const tag = root.match(new RegExp(`<${kind}\\b[^>]*/>`))?.[0] ?? ''
  return /svgname="([^"]+)"/.exec(tag)?.[1] ?? ''
}

function lastGroup(svg: string): string {
  const start = svg.lastIndexOf('<g ')
  const end = svg.indexOf('</g>', start)
  if (start < 0 || end < 0) throw new Error('no group')
  return svg.slice(start, end + 4)
}

function replaceLastGroup(svg: string, group: string): string {
  return svg.replace(lastGroup(svg), group)
}

function trims(partSvg: string): { start: string; end: string } {
  return {
    start: partSvg.match(/<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/)?.[0] ?? '',
    end: partSvg.match(/<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/)?.[0] ?? '',
  }
}

function replaceTrims(svg: string, real: { start: string; end: string }): string {
  return svg
    .replace(/<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/, real.start)
    .replace(/<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/, real.end)
}

function holeBlock(partSvg: string): string {
  return (partSvg.match(/<circle\b[^>]*\/>/g) ?? []).join('\n')
}

function replaceHoles(svg: string, holes: string): string {
  let replaced = false
  return svg.replace(/<circle\b[^>]*\/>\s*/g, () => {
    if (replaced) return ''
    replaced = true
    return `${holes}\n  `
  })
}

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

function real(mark: string): Real {
  const raw = new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`)))
  const entries = readZipRaw(raw)
  const files = unzipSync(raw) as Files
  const root = rootOf(files)
  const internalMark = /<Part\b[^>]*Name=([^;"]+)/.exec(root)?.[1] ?? ''
  const partName = /<Part\b[^>]*svgname="([^"]+)"/.exec(root)?.[1] ?? ''
  const adobeName = /<Adobe\b[^>]*svgname="([^"]+)"/.exec(root)?.[1] ?? ''
  const partId = /<Part\b[^>]*idref="([^"]+)"/.exec(root)?.[1] ?? ''
  const part = strFromU8(files[`CAD/${partName}`] as Uint8Array)
  return {
    internalMark,
    entries,
    files,
    partPath: `CAD/${partName}`,
    adobePath: `CAD/${adobeName}`,
    partId,
    section: lastGroup(part),
    trims: trims(part),
    holes: holeBlock(part),
  }
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

describe.skipIf(!outDir)('mark-writing probes', () => {
  it('writes 2200-2206', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Record<string, unknown>[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }

    for (const [code, mark] of [
      [2200, 'M-3'],
      [2203, 'M-1'],
      [2205, 'M-34'],
    ] as const) {
      const raw = new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`)))
      writeFileSync(join(out, `${code} ${mark} control.ncep`), raw)
      reports.push(
        report(`${code} ${mark} control.ncep`, mark, 'real control', parseNcepPackage(raw)),
      )
    }

    const improved = (code: number, mark: string): void => {
      const unique = `${code} ${mark} improved NC marks`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error(`cannot build ${mark}`)
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files, 'Part')}`
      const base = real(mark)
      const edits: Record<string, Edit> = {
        [partPath]: (text) =>
          replaceHoles(
            replaceTrims(replaceLastGroup(text, base.section), {
              start: rename(base.trims.start, base.internalMark, unique),
              end: rename(base.trims.end, base.internalMark, unique),
            }),
            base.holes,
          ),
      }
      write(
        `${code} ${mark} improved NC marks.ncep`,
        editEntries(entries, files, edits),
        unique,
        'improved NC marks',
      )
    }
    improved(2201, 'M-3')
    improved(2204, 'M-1')
    improved(2206, 'M-34')

    const standard = (code: number, mark: string): void => {
      const unique = `${code} ${mark} standard NC marks`
      const bytes = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
        mark: unique,
      })
      if (!bytes) throw new Error(`cannot build ${mark}`)
      write(
        `${code} ${mark} standard NC marks.ncep`,
        readZipRaw(bytes),
        unique,
        'standard NC marks',
      )
    }
    standard(2202, 'M-3')

    expect(reports).toHaveLength(7)
    const readme = [
      'Mark-writing probes (2200–2206)',
      '',
      '2201/2204/2206 are improved packages (real section/trims/holes) but the marks come from the',
      "writer's NC mark emission, not real-mark injection. 2202 is the standard M-3 NCEP.",
      'If the bars/etchings appear, NC marks are being emitted correctly.',
      '',
      'Groups:',
      '- 2200 M-3 control; 2201 M-3 improved NC marks; 2202 M-3 standard NC marks',
      '- 2203 M-1 control; 2204 M-1 improved NC marks',
      '- 2205 M-34 control; 2206 M-34 improved NC marks',
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
  }, 120_000)
})
