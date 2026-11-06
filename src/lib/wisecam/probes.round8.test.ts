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
 * Round 8: corrected layer-4 etch polylines and the fixed M-34 notched end cut.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-round8 \
 *     pnpm exec vitest run src/lib/wisecam/probes.round8.test.ts
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
  marks: string
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

function markElements(partSvg: string): string {
  const text = partSvg.match(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/)?.[0] ?? ''
  const rects = partSvg.match(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g) ?? []
  return [text, ...rects].filter(Boolean).join('\n')
}

function replaceMark(svg: string, elements: string): string {
  const without = svg
    .replace(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/, '@@MARK@@')
    .replace(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g, '')
    .replace(/<line\b[^>]*wh:layer="4"[^>]*\/>/g, '')
    .replace(/<path\b[^>]*needSetAdobe=true;[^>]*\/>/g, '')
  return without.replace('@@MARK@@', elements)
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
    marks: markElements(part),
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

describe.skipIf(!outDir)('round 8 etch/end-cut probes', () => {
  it('writes 2300-2306', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Record<string, unknown>[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }

    for (const [code, mark] of [
      [2300, 'M-34'],
      [2302, 'M-3'],
      [2304, 'M-1'],
    ] as const) {
      const raw = new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`)))
      writeFileSync(join(out, `${code} ${mark} control.ncep`), raw)
      reports.push(
        report(`${code} ${mark} control.ncep`, mark, 'real control', parseNcepPackage(raw)),
      )
    }

    const improved = (code: number, mark: string): void => {
      const unique = `${code} ${mark} writer corrected etch`
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
        `${code} ${mark} writer corrected etch.ncep`,
        editEntries(entries, files, edits),
        unique,
        'writer corrected etch',
      )
    }
    improved(2303, 'M-3')
    improved(2305, 'M-1')
    improved(2306, 'M-34')

    {
      const unique = '2301 M-34 fixed our trims'
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-34.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build M-34')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files, 'Part')}`
      const base = real('M-34')
      const edits: Record<string, Edit> = {
        [partPath]: (text) =>
          replaceHoles(
            replaceMark(
              replaceLastGroup(text, base.section),
              rename(base.marks, base.internalMark, unique),
            ),
            base.holes,
          ),
      }
      write(
        '2301 M-34 fixed our trims.ncep',
        editEntries(entries, files, edits),
        unique,
        'fixed our M-34 trims',
      )
    }

    expect(reports).toHaveLength(7)
    const readme = [
      'Round 8 probes (2300–2306): corrected layer-4 etch + fixed M-34 notched end',
      '',
      'Scoreboard:',
      '- 2301 M-34 fixed our trims: lines along the zero end must match the control along the beam;',
      '  this is the regression from 2031.',
      '- 2303/2305/2306 writer corrected etch: layer-4 open polylines with T={} and',
      '  needSetAdobe should etch. If they become cuts, the correction form is still wrong.',
      '- 2300/2302/2304 are byte-identical controls.',
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
