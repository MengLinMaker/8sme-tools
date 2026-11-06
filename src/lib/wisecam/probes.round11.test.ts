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
 * Round 11: bar orientation vs LeadLine Segment, and the layer-4 exemplar form.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-round11 \
 *     pnpm exec vitest run src/lib/wisecam/probes.round11.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES
type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

function rootOf(files: Files): string {
  return strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
}
function svgName(files: Files): string {
  const root = rootOf(files)
  const tag = root.match(/<Part\b[^>]*\/>/)?.[0] ?? ''
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
function trims(part: string): { start: string; end: string } {
  return {
    start: part.match(/<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/)?.[0] ?? '',
    end: part.match(/<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/)?.[0] ?? '',
  }
}
function replaceTrims(svg: string, real: { start: string; end: string }): string {
  return svg
    .replace(/<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/, real.start)
    .replace(/<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/, real.end)
}
function holes(part: string): string {
  return (part.match(/<circle\b[^>]*\/>/g) ?? []).join('\n')
}
function replaceHoles(svg: string, value: string): string {
  let done = false
  return svg.replace(/<circle\b[^>]*\/>\s*/g, () => {
    if (done) return ''
    done = true
    return `${value}\n  `
  })
}
function bars(part: string): string[] {
  return part.match(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g) ?? []
}
function segment(tag: string, value: 1 | 3): string {
  return tag.replace(/Segment=\d/, `Segment=${value}`)
}
function layer(tag: string, value: 4 | 6): string {
  return tag
    .replace(/wh:layer="\d+"/, `wh:layer="${value}"`)
    .replace(/class="layer\d+"/, `class="layer${value}"`)
}
function params(tag: string): string {
  return /wh:params="/.test(tag)
    ? tag.replace(/wh:params="[^"]*"/, 'wh:params="needSetAdobe=true;"')
    : tag.replace(/ wh:technical=/, ' wh:params="needSetAdobe=true;" wh:technical=')
}
function noTransformNegative(tag: string): string {
  const x = Number(/ x="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const y = Number(/ y="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const w = Number(/ width="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const h = Number(/ height="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const transform = / transform="([^"]+)"/.exec(tag)?.[1] ?? ''
  const rotated = /rotate\(180/.test(transform)
  const nx = rotated ? x - w : x
  const ny = rotated ? y - h : y
  return tag
    .replace(/ x="[^"]+"/, ` x="${nx}"`)
    .replace(/ y="[^"]+"/, ` y="${ny}"`)
    .replace(/ width="[^"]+"/, ` width="${w}"`)
    .replace(/ height="[^"]+"/, ` height="${h}"`)
    .replace(/ transform="[^"]*"/, '')
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

describe.skipIf(!outDir)('round 11 bar orientation', () => {
  it('writes 2600-2607', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Record<string, unknown>[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }
    const real = new Uint8Array(readFileSync(fixture('ncep', 'M-3.ncep')))
    const realFiles = unzipSync(real) as Files
    const realPart = strFromU8(realFiles[`CAD/${svgName(realFiles)}`] as Uint8Array)
    const realBars = bars(realPart)
    const realTrims = trims(realPart)
    const realHoles = holes(realPart)

    write('2600 M-3 control.ncep', readZipRaw(real), 'M-3', 'real control')

    const probe = (code: number, label: string, transform: (bar: string) => string): void => {
      const unique = `${code} M-3 ${label}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-3.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build M-3')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files)}`
      const elements = realBars.map(transform).join('\n')
      const edits: Record<string, Edit> = {
        [partPath]: (text) => {
          const withGeometry = replaceHoles(
            replaceTrims(replaceLastGroup(text, lastGroup(realPart)), {
              start: realTrims.start.split('M-3').join(unique),
              end: realTrims.end.split('M-3').join(unique),
            }),
            realHoles,
          )
          return withGeometry
            .replace(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/, '')
            .replace(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g, '')
            .replace(/<line\b[^>]*wh:layer="4"[^>]*\/>/g, '')
            .replace(/<path\b[^>]*needSetAdobe=true;[^>]*\/>/g, '')
            .replace('</g>', `${elements}\n </g>`)
        },
      }
      write(`${code} M-3 ${label}.ncep`, editEntries(entries, files, edits), unique, label)
    }

    const neg1 = (bar: string): string => segment(noTransformNegative(bar), 1)
    const neg3 = (bar: string): string => segment(noTransformNegative(bar), 3)
    probe(2601, 'L6 neg seg1', (bar) => layer(neg1(bar), 6))
    probe(2602, 'L6 neg seg3', (bar) => layer(neg3(bar), 6))
    probe(2603, 'L4 neg seg1', (bar) => params(layer(neg1(bar), 4)))
    probe(2604, 'L4 neg seg3', (bar) => params(layer(neg3(bar), 4)))
    probe(2605, 'L4 pos seg3', (bar) => params(segment(bar, 3)))
    probe(2606, 'L4 pos seg1', (bar) => params(segment(bar, 1)))
    probe(2607, 'L6 pos seg3', (bar) => segment(bar, 3))

    expect(reports).toHaveLength(8)
    const readme = [
      'Round 11 probes (2600–2607): bar orientation vs LeadLine Segment',
      '',
      'Hypothesis: the exemplar uses Segment=1 for a negative-x bar with no 180° transform.',
      '- 2601/2602: layer-6 negative-x no-transform, Segment 1 vs 3',
      '- 2603/2604: layer-4 negative-x no-transform, Segment 1 vs 3',
      '- 2605/2606: layer-4 positive-x + rotate(180), Segment 3 vs 1',
      '- 2607: layer-6 positive-x + rotate(180), Segment 3 (real M-3 geometry)',
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
