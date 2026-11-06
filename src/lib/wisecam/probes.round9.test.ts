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
 * Round 9: corrected-etch forms, bevel nesting, and new section shapes/sizes.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-round9 \
 *     pnpm exec vitest run src/lib/wisecam/probes.round9.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

interface Real {
  internalMark: string
  entries: RawZipEntry[]
  files: Files
  partPath: string
  part: string
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

function markElements(partSvg: string): string {
  const text = partSvg.match(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/)?.[0] ?? ''
  const rects = partSvg.match(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g) ?? []
  const lines = partSvg.match(/<line\b[^>]*wh:layer="4"[^>]*\/>/g) ?? []
  return [text, ...rects, ...lines].filter(Boolean).join('\n')
}

function replaceMark(svg: string, elements: string): string {
  const without = svg
    .replace(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/, '@@MARK@@')
    .replace(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g, '')
    .replace(/<line\b[^>]*wh:layer="4"[^>]*\/>/g, '')
    .replace(/<path\b[^>]*needSetAdobe=true;[^>]*\/>/g, '')
  return without.replace('@@MARK@@', elements)
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

function real(mark: string, path = fixture('ncep', `${mark}.ncep`)): Real {
  const raw = new Uint8Array(readFileSync(path))
  const entries = readZipRaw(raw)
  const files = unzipSync(raw) as Files
  const root = rootOf(files)
  const internalMark = /<Part\b[^>]*Name=([^;"]+)/.exec(root)?.[1] ?? ''
  const partName = svgName(files, 'Part')
  const part = strFromU8(files[`CAD/${partName}`] as Uint8Array)
  return {
    internalMark,
    entries,
    files,
    partPath: `CAD/${partName}`,
    part,
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

function bars(mark: Real): string[] {
  return mark.marks.match(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g) ?? []
}

function text(mark: Real): string {
  return mark.marks.match(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/)?.[0] ?? ''
}

function withLayer(tag: string, layer: 4 | 6): string {
  return tag
    .replace(/wh:layer="\d+"/, `wh:layer="${layer}"`)
    .replace(/class="layer\d+"/, `class="layer${layer}"`)
}

function withParams(tag: string, params: string): string {
  return /wh:params="/.test(tag)
    ? tag.replace(/wh:params="[^"]*"/, `wh:params="${params}"`)
    : tag.replace(/ wh:technical=/, ` wh:params="${params}" wh:technical=`)
}

function withTechnical(tag: string, technical: string): string {
  return tag.replace(/wh:technical="[^"]*"/, `wh:technical="${technical}"`)
}

function toOutline(tag: string): string {
  const x = Number(/ x="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const y = Number(/ y="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const w = Number(/ width="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const h = Number(/ height="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const transform = / transform="([^"]+)"/.exec(tag)?.[1]
  return `<path wh:id="${/wh:id="(\d+)"/.exec(tag)?.[1] ?? '0'}" wh:class="cadpolyline" wh:layer="4" wh:isfill="0" wh:machining="1" d="M${x},${y} L${x + w},${y} L${x + w},${y + h} L${x},${y + h}" wh:params="needSetAdobe=true;" wh:technical="T={};" class="layer4"${transform ? ` transform="${transform}"` : ''}/>`
}

function toLine(tag: string): string {
  const x = Number(/ x="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const y = Number(/ y="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const w = Number(/ width="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const h = Number(/ height="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const transform = / transform="([^"]+)"/.exec(tag)?.[1]
  const horizontal = w >= h
  const x1 = horizontal ? x : x + w / 2
  const y1 = horizontal ? y + h / 2 : y
  const x2 = horizontal ? x + w : x + w / 2
  const y2 = horizontal ? y + h / 2 : y + h
  return `<line wh:id="${/wh:id="(\d+)"/.exec(tag)?.[1] ?? '0'}" wh:class="cadline" wh:layer="4" wh:isfill="0" wh:machining="1" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" wh:params="needSetAdobe=true;" wh:technical="T={};" class="layer4"${transform ? ` transform="${transform}"` : ''}/>`
}

function shapeProbe(
  code: number,
  mark: string,
  write: (name: string, entries: RawZipEntry[], mark: string, variant: string) => void,
): void {
  const base = real(mark)
  const unique = `${code} ${mark} standard`
  const built = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
    mark: unique,
  })
  if (!built) throw new Error(`cannot build ${mark}`)
  write(`${code} ${mark} standard.ncep`, readZipRaw(built), unique, 'standard NC→NCEP')

  const improvedMark = `${code} ${mark} improved`
  const improved = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
    mark: improvedMark,
  })
  if (!improved) throw new Error(`cannot build ${mark}`)
  const files = unzipSync(improved) as Files
  const entries = readZipRaw(improved)
  const partPath = `CAD/${svgName(files, 'Part')}`
  const edits: Record<string, Edit> = {
    [partPath]: (textValue) =>
      replaceHoles(
        replaceTrims(replaceLastGroup(textValue, base.section), {
          start: rename(base.trims.start, base.internalMark, improvedMark),
          end: rename(base.trims.end, base.internalMark, improvedMark),
        }),
        base.holes,
      ),
  }
  write(
    `${code} ${mark} improved.ncep`,
    editEntries(entries, files, edits),
    improvedMark,
    'real section/trims/holes',
  )
}

describe.skipIf(!outDir)('round 9 etch/bevel/shapes', () => {
  it('writes 2400-2452', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Record<string, unknown>[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }
    const writeReal = (name: string, path: string, mark: string, variant: string): void => {
      const bytes = new Uint8Array(readFileSync(path))
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }

    // A. End section confirmation (M-34).
    writeReal('2400 M-34 control.ncep', fixture('ncep', 'M-34.ncep'), 'M-34', 'real control')
    {
      const base = real('M-34')
      const unique = '2401 M-34 fixed trims'
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-34.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build M-34')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files, 'Part')}`
      const edits: Record<string, Edit> = {
        [partPath]: (textValue) =>
          replaceHoles(
            replaceMark(
              replaceLastGroup(textValue, base.section),
              rename(base.marks, base.internalMark, unique),
            ),
            base.holes,
          ),
      }
      write(
        '2401 M-34 fixed trims.ncep',
        editEntries(entries, files, edits),
        unique,
        'our fixed trims',
      )
    }

    // B. Corrected-etch form matrix on M-3 (same bar geometry).
    const m3 = real('M-3')
    const m3Bars = bars(m3)
    const m3Text = text(m3)
    writeReal('2410 M-3 control.ncep', fixture('ncep', 'M-3.ncep'), 'M-3', 'real control')
    const etchCase = (
      code: number,
      label: string,
      transform: (bar: string) => string,
      addText: boolean,
    ): void => {
      const unique = `${code} M-3 ${label}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-3.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build M-3')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files, 'Part')}`
      const elements = `${addText ? rename(m3Text, m3.internalMark, unique) : ''}\n${m3Bars.map(transform).join('\n')}`
      const edits: Record<string, Edit> = {
        [partPath]: (textValue) =>
          replaceHoles(
            replaceTrims(replaceLastGroup(textValue, m3.section), {
              start: rename(m3.trims.start, m3.internalMark, unique),
              end: rename(m3.trims.end, m3.internalMark, unique),
            }),
            m3.holes,
          )
            .replace(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/, '')
            .replace(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g, '')
            .replace(/<line\b[^>]*wh:layer="4"[^>]*\/>/g, '')
            .replace(/<path\b[^>]*needSetAdobe=true;[^>]*\/>/g, '')
            .replace('</g>', `${elements}\n </g>`),
      }
      write(`${code} M-3 ${label}.ncep`, editEntries(entries, files, edits), unique, label)
    }
    etchCase(
      2411,
      'L4 rect T',
      (bar) => withTechnical(withParams(withLayer(bar, 4), 'needSetAdobe=true;'), 'T={};'),
      false,
    )
    etchCase(
      2412,
      'L4 rect lead',
      (bar) => withParams(withLayer(bar, 4), 'needSetAdobe=true;'),
      false,
    )
    etchCase(2413, 'L4 outline T', (bar) => toOutline(bar), false)
    etchCase(2414, 'L6 rect', (bar) => withLayer(bar, 6), false)
    etchCase(2415, 'L6 rect text', (bar) => withLayer(bar, 6), true)
    etchCase(2416, 'L4 line T', (bar) => toLine(bar), false)

    // C. Bevel cluster (real Beveled PFC reference).
    const bevelPath = fixture('ncep', 'reference-variations', 'Beveled PFC.ncep')
    const bevel = real('Beveled PFC', bevelPath)
    const endTrim = (part: string): string =>
      part.match(/<path\b[^>]*IsTrucate=1;TrucateType=1;[\s\S]*?<\/path>/)?.[0] ?? ''
    const children = (part: string): string[] => endTrim(part).match(/<path\b[^>]*\/>/g) ?? []
    writeReal('2420 Beveled PFC control.ncep', bevelPath, 'Beveled PFC', 'real bevel control')
    writeReal(
      '2421 Beveled PFC no bevel.ncep',
      fixture('ncep', 'reference-variations', 'Beveled PFC remove bevel.ncep'),
      'Beveled PFC remove bevel',
      'no-bevel control',
    )
    const bevelCase = (code: number, label: string, edit: (part: string) => string): void => {
      const unique = `${code} Beveled PFC ${label}`
      const edits: Record<string, Edit> = {
        [bevel.partPath]: (textValue) =>
          edit(textValue)
            .split(`Name=${bevel.internalMark}`)
            .join(`Name=${unique}`)
            .split(`Part=${bevel.internalMark}`)
            .join(`Part=${unique}`)
            .replace(/LabelContent=Beveled PFC/g, `LabelContent=${unique}`)
            .replace(/>Beveled PFC<\/text>/g, `>${unique}</text>`),
      }
      write(
        `${code} Beveled PFC ${label}.ncep`,
        editEntries(bevel.entries, bevel.files, edits),
        unique,
        label,
      )
    }
    bevelCase(2422, 'children hoisted', (part) => {
      const end = endTrim(part)
      const outer = end.replace(/<path\b[^>]*\/>/g, '')
      return part.replace(end, `${outer}\n${children(part).join('\n')}`)
    })
    bevelCase(2423, 'outer trim removed', (part) =>
      part.replace(endTrim(part), children(part).join('\n')),
    )
    bevelCase(2424, 'first child only', (part) => {
      const end = endTrim(part)
      const outer = end.replace(/<path\b[^>]*\/>/g, '')
      return part.replace(end, outer.replace('</path>', `${children(part)[0] ?? ''}</path>`))
    })

    // D. New shapes / sizes with real NCs.
    for (const [code, mark] of [
      [2430, 'M-39'],
      [2440, 'M-43'],
      [2450, 'M-51'],
    ] as const) {
      writeReal(
        `${code} ${mark} control.ncep`,
        fixture('ncep', `${mark}.ncep`),
        mark,
        'real control',
      )
      shapeProbe(code + 1, mark, write)
    }

    expect(reports).toHaveLength(23)
    const readme = [
      'Round 9 probes (2400–2452): corrected-etch forms, bevels, new shapes',
      '',
      'Groups:',
      '- 2400 M-34 control; 2401 fixed our trims',
      '- 2410 M-3 control; 2411 L4 rect T={}; 2412 L4 rect lead-line; 2413 L4 outline T={};',
      '  2414 L6 rect; 2415 L6 rect + text; 2416 L4 line T={}',
      '- 2420 Beveled PFC control; 2421 no-bevel control; 2422 children hoisted;',
      '  2423 outer trim removed; 2424 first child only',
      '- 2430/2440/2450 controls for UB410*60 / RHS100*50*5 / SHS89*3.5;',
      '  2431/2432, 2441/2442, 2451/2452 are standard and improved NC→NCEP packages',
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
    for (const file of reports) {
      zipFiles[file.file as string] = new Uint8Array(readFileSync(join(out, file.file as string)))
    }
    zipFiles['README.txt'] = strToU8(readme)
    writeFileSync(`${out.replace(/\/+$/, '')}.zip`, zipSync(zipFiles, { level: 6 }))
  }, 180_000)
})
