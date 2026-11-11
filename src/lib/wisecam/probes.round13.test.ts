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

/** Round 13: which layer is corrected etching? L1–L7 sweep on identical M-3 bars. */
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
function trims(part: string): { start: string; end: string } {
  return {
    start: part.match(/<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/)?.[0] ?? '',
    end: part.match(/<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/)?.[0] ?? '',
  }
}
function holes(part: string): string {
  return (part.match(/<circle\b[^>]*\/>/g) ?? []).join('\n')
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
function withLayer(tag: string, layer: number): string {
  return tag
    .replace(/wh:layer="\d+"/, `wh:layer="${layer}"`)
    .replace(/class="layer\d+"/, `class="layer${layer}"`)
}
function withParams(tag: string): string {
  return /wh:params="/.test(tag)
    ? tag.replace(/wh:params="[^"]*"/, 'wh:params="needSetAdobe=true;"')
    : tag.replace(/ wh:technical=/, ' wh:params="needSetAdobe=true;" wh:technical=')
}
function negativeNoTransform(tag: string): string {
  const x = Number(/ x="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const y = Number(/ y="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const w = Number(/ width="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const h = Number(/ height="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const t = / transform="([^"]+)"/.exec(tag)?.[1] ?? ''
  const rotated = /rotate\(180/.test(t)
  return tag
    .replace(/ x="[^"]+"/, ` x="${rotated ? x - w : x}"`)
    .replace(/ y="[^"]+"/, ` y="${rotated ? y - h : y}"`)
    .replace(/ transform="[^"]*"/, '')
}

describe.skipIf(!outDir)('round 13 layer sweep', () => {
  it('writes 2800-2813', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Record<string, unknown>[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }
    const m3Raw = new Uint8Array(readFileSync(fixture('ncep', 'M-3.ncep')))
    const m3Files = unzipSync(m3Raw) as Files
    const m3Part = strFromU8(m3Files[`CAD/${svgName(m3Files)}`] as Uint8Array)
    const m3Bars = m3Part.match(/<rect\b[^>]*wh:layer="6"[^>]*\/>/g) ?? []
    const m3Text = m3Part.match(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/)?.[0] ?? ''
    const m3Trims = trims(m3Part)
    const m3Holes = holes(m3Part)

    write('2800 M-3 control.ncep', readZipRaw(m3Raw), 'M-3', 'real control')
    const layerCase = (
      layer: number,
      code: number,
      label: string,
      transform = (b: string) => withLayer(b, layer),
      addText = false,
    ): void => {
      const unique = `${code} M-3 ${label}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-3.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build M-3')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files)}`
      const elements = `${addText ? withLayer(rename(m3Text, 'M-3', unique), layer) : ''}\n${m3Bars.map(transform).join('\n')}`
      write(
        `${code} M-3 ${label}.ncep`,
        editEntries(entries, files, {
          [partPath]: (part) => {
            const base = part
              .replace(lastGroup(part), lastGroup(m3Part))
              .replace(/<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/, m3Trims.start)
              .replace(/<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/, m3Trims.end)
              .replace(/<circle\b[^>]*\/>\s*/g, () => `${m3Holes}\n  `)
            return base
              .replace(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/, '')
              .replace(/<rect\b[^>]*wh:layer="\d+"[^>]*\/>/g, '')
              .replace(/<line\b[^>]*wh:layer="\d+"[^>]*\/>/g, '')
              .replace(/<path\b[^>]*needSetAdobe=true;[^>]*\/>/g, '')
              .replace('</g>', `${elements}\n </g>`)
          },
        }),
        unique,
        label,
      )
    }
    for (let layer = 1; layer <= 7; layer++) {
      layerCase(layer, 2800 + layer, `L${layer} rect`)
    }
    layerCase(5, 2808, 'L5 rect needSetAdobe', (b) => withParams(withLayer(b, 5)))
    layerCase(5, 2809, 'L5 neg seg1', (b) => withLayer(negativeNoTransform(b), 5))
    layerCase(5, 2810, 'L5 rect text', (b) => withLayer(b, 5), true)
    layerCase(6, 2811, 'L6 rect needSetAdobe', (b) => withParams(withLayer(b, 6)))
    layerCase(6, 2812, 'L6 neg seg1', (b) => withLayer(negativeNoTransform(b), 6))
    layerCase(6, 2813, 'L6 rect text', (b) => withLayer(b, 6), true)

    // Arc-recovery confirmation after lowering the interior-angle threshold and bounding radius.
    const arcCase = (code: number, mark: string): void => {
      const unique = `${code} ${mark} standard`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error(`cannot build ${mark}`)
      write(`${code} ${mark} standard.ncep`, readZipRaw(built), unique, 'standard arc recovery')
    }
    arcCase(2814, 'M-43')
    arcCase(2815, 'M-51')
    arcCase(2816, 'M-39')
    for (const [code, mark] of [
      [2817, 'M-43'],
      [2818, 'M-51'],
      [2819, 'M-39'],
    ] as const) {
      write(
        `${code} ${mark} control.ncep`,
        readZipRaw(new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`)))),
        mark,
        'real control',
      )
    }

    expect(reports).toHaveLength(20)

    const readme = [
      'Round 13 (2800–2813): layer sweep for corrected etching',
      '',
      'Identical M-3 bar geometry moved to layers 1–7; then L5/L6 with needSetAdobe, negative',
      'no-transform, and text. Layer 6 is the current proven etch; test whether layer 5 is the',
      'corrected-etch layer. 2814–2819 confirm the new arc recovery on M-43/M-51/M-39.',
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
