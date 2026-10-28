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
 * Bolder NC→NCEP probes: improved part features + ZIP compression variants (fflate / Node zlib /
 * stored). The full-package matrix showed our docs/SVGs reject in our container but load in a real
 * one, so this pack isolates compression/container as the remaining blocker.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-nc2ncep \
 *     pnpm exec vitest run src/lib/wisecam/probes.nc2ncep.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string
type Mode = 'fflate' | 'zlib' | 'stored'

interface Real {
  mark: string
  entries: RawZipEntry[]
  files: Files
  partPath: string
  adobePath: string
  partId: string
  part: string
  section: string
  trims: { start: string; end: string }
  holes: string
  marks: string
}

interface Report {
  file: string
  mark: string
  variant: string
  errors: string[]
  warnings: string[]
  sectionGroups: number
  userPaths: number
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
  return partSvg.match(/(?:<circle\b[^>]*\/>\s*)+/)?.[0] ?? ''
}

function replaceHoles(svg: string, holes: string): string {
  return svg.replace(/(?:<circle\b[^>]*\/>\s*)+/, holes)
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

function real(mark: string): Real {
  const raw = new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`)))
  const entries = readZipRaw(raw)
  const files = unzipSync(raw) as Files
  const root = rootOf(files)
  const partName = /<Part\b[^>]*svgname="([^"]+)"/.exec(root)?.[1] ?? ''
  const adobeName = /<Adobe\b[^>]*svgname="([^"]+)"/.exec(root)?.[1] ?? ''
  const partId = /<Part\b[^>]*idref="([^"]+)"/.exec(root)?.[1] ?? ''
  const part = strFromU8(files[`CAD/${partName}`] as Uint8Array)
  return {
    mark,
    entries,
    files,
    partPath: `CAD/${partName}`,
    adobePath: `CAD/${adobeName}`,
    partId,
    part,
    section: lastGroup(part),
    trims: trims(part),
    holes: holeBlock(part),
    marks: markElements(part),
  }
}

function buildFull(base: Real, unique: string): { files: Files; entries: RawZipEntry[] } {
  const built = buildNcepFromNc(readFileSync(fixture('ncep', `${base.mark}.nc1`), 'utf8'), {
    mark: unique,
  })
  if (!built) throw new Error(`cannot build own ${base.mark}`)
  return { files: unzipSync(built) as Files, entries: readZipRaw(built) }
}

function editedFiles(files: Files, edits: Record<string, Edit>): Files {
  const out = { ...files }
  for (const [path, edit] of Object.entries(edits)) {
    out[path] = strToU8(edit(strFromU8(files[path] as Uint8Array)))
  }
  return out
}

function withContent(entry: RawZipEntry, data: Uint8Array): RawZipEntry {
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
}

function recompressZlib(entries: RawZipEntry[], files: Files): RawZipEntry[] {
  return entries.map((entry) => {
    const data = files[entry.name] as Uint8Array
    if (entry.method === 0) return withContent(entry, data)
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

function storeAll(entries: RawZipEntry[], files: Files): RawZipEntry[] {
  return entries.map((entry) => {
    const data = files[entry.name] as Uint8Array
    return {
      ...entry,
      method: 0,
      flags: 0,
      internalAttr: 0,
      compressed: data,
      compressedSize: data.length,
      uncompressedSize: data.length,
      crc: crc32(data),
    }
  })
}

function fflateEntries(entries: RawZipEntry[], files: Files): RawZipEntry[] {
  return entries.map((entry) => withContent(entry, files[entry.name] as Uint8Array))
}

function report(file: string, mark: string, variant: string, pkg: NcepPackage): Report {
  return {
    file,
    mark,
    variant,
    errors: pkg.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code),
    warnings: pkg.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.code),
    sectionGroups: pkg.partSvg?.sections.length ?? 0,
    userPaths: pkg.adobeSvg?.userPaths.length ?? 0,
  }
}

function lineFor(entry: Report): string {
  const parser = [
    ...entry.errors.map((code) => `error:${code}`),
    ...entry.warnings.map((code) => `warn:${code}`),
  ]
  return `| ${entry.file} | ${entry.mark} | ${entry.variant} | ${entry.sectionGroups} | ${entry.userPaths} | ${parser.join(', ') || 'ok'} |`
}

describe.skipIf(!outDir)('NC→NCEP compression probes', () => {
  it('writes 1600-1617 and the transfer ZIP', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Report[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }

    const m1 = real('M-1')
    const m3 = real('M-3')
    const m35 = real('M-35')
    const m42 = real('M-42')

    // Controls.
    for (const [code, base] of [
      [1600, m1],
      [1615, m3],
      [1616, m35],
      [1617, m42],
    ] as const) {
      const raw = new Uint8Array(readFileSync(fixture('ncep', `${base.mark}.ncep`)))
      writeFileSync(join(out, `${code}-real-${base.mark}-control.ncep`), raw)
      reports.push(
        report(
          `${code}-real-${base.mark}-control.ncep`,
          base.mark,
          'real control',
          parseNcepPackage(raw),
        ),
      )
    }

    const improved = (
      base: Real,
      code: number,
      mode: Mode,
      variant: string,
      partTransform: (svg: string, unique: string) => string,
      containerMode: 'ours' | 'real' | 'old',
    ): void => {
      const unique = `${base.mark}-${code}`
      const { files, entries } = buildFull(base, unique)
      const partPath = `CAD/${svgName(files, 'Part')}`
      const edits: Record<string, Edit> = {
        [partPath]: (text) => partTransform(text, unique),
      }
      if (containerMode === 'real') {
        edits['META-INF/container.xml'] = () =>
          strFromU8(m1.files['META-INF/container.xml'] as Uint8Array)
      } else if (containerMode === 'old') {
        edits['META-INF/container.xml'] = (text) => `${text}\n`
      }
      const files2 = editedFiles(files, edits)
      const outEntries =
        mode === 'zlib'
          ? recompressZlib(entries, files2)
          : mode === 'stored'
            ? storeAll(entries, files2)
            : fflateEntries(entries, files2)
      write(`${code}-${base.mark}-${variant}.ncep`, outEntries, unique, variant)
    }

    const m1Improved = (svg: string, unique: string): string =>
      replaceMark(
        replaceHoles(
          replaceTrims(replaceLastGroup(svg, m1.section), {
            start: rename(m1.trims.start, m1.mark, unique),
            end: rename(m1.trims.end, m1.mark, unique),
          }),
          m1.holes,
        ),
        rename(m1.marks, m1.mark, unique),
      )
    const m3Improved = (svg: string, unique: string): string =>
      replaceMark(
        replaceHoles(
          replaceTrims(replaceLastGroup(svg, m3.section), {
            start: rename(m3.trims.start, m3.mark, unique),
            end: rename(m3.trims.end, m3.mark, unique),
          }),
          m3.holes,
        ),
        rename(m3.marks, m3.mark, unique),
      )
    const m35Improved = (svg: string, unique: string): string =>
      replaceMark(replaceLastGroup(svg, m35.section), rename(m35.marks, m35.mark, unique))
    const m42Improved = (svg: string, unique: string): string =>
      replaceMark(
        replaceTrims(replaceLastGroup(svg, m42.section), {
          start: rename(m42.trims.start, m42.mark, unique),
          end: rename(m42.trims.end, m42.mark, unique),
        }),
        '',
      )

    // M-1 compression/container matrix.
    improved(m1, 1601, 'fflate', 'improved-fflate', m1Improved, 'ours')
    improved(m1, 1602, 'zlib', 'improved-zlib', m1Improved, 'ours')
    improved(m1, 1603, 'stored', 'improved-stored', m1Improved, 'ours')
    improved(m1, 1604, 'fflate', 'improved-fflate-real-container', m1Improved, 'real')
    improved(m1, 1605, 'zlib', 'improved-zlib-real-container', m1Improved, 'real')

    improved(m1, 1618, 'fflate', 'improved-fflate-old-container', m1Improved, 'old')

    // Per-family improved samples: fflate vs zlib vs stored.
    improved(m3, 1606, 'fflate', 'improved-fflate', m3Improved, 'ours')
    improved(m3, 1607, 'zlib', 'improved-zlib', m3Improved, 'ours')
    improved(m3, 1608, 'stored', 'improved-stored', m3Improved, 'ours')
    improved(m35, 1609, 'fflate', 'improved-fflate', m35Improved, 'ours')
    improved(m35, 1610, 'zlib', 'improved-zlib', m35Improved, 'ours')
    improved(m35, 1611, 'stored', 'improved-stored', m35Improved, 'ours')
    improved(m42, 1612, 'fflate', 'improved-fflate', m42Improved, 'ours')
    improved(m42, 1613, 'zlib', 'improved-zlib', m42Improved, 'ours')
    improved(m42, 1614, 'stored', 'improved-stored', m42Improved, 'ours')

    expect(reports).toHaveLength(19)
    const readme = [
      'NC→NCEP compression probes (1600–1617)',
      '',
      'Improved part features: real section + real trims/holes/marks where the front/full probes',
      'showed they are required. The only variable left in the full package is the ZIP compression',
      'and container.',
      '',
      '## Test order',
      '1. 1600 real M-1 control.',
      '2. 1601 improved M-1 with fflate; 1602 with Node zlib; 1603 stored.',
      '3. 1604 fflate + real container.xml; 1605 zlib + real container.xml.',
      '4. 1606–1608 M-3 fflate/zlib/stored.',
      '5. 1609–1611 M-35 fflate/zlib/stored.',
      '6. 1612–1614 M-42 fflate/zlib/stored.',
      '7. 1615–1617 real M-3/M-35/M-42 controls.',
      '8. 1618 improved M-1 with the OLD container.xml (trailing newline) — negative control.',
      '',
      'If zlib or stored loads but fflate rejects, the fix is the compressor, not the NCEP geometry.',
      'If all modes reject, the remaining difference is package content/container metadata.',
      '',
      '## Matrix',
      '| File | CadRoot Name | Variant | Section groups | Adobe USERPATH | Parser |',
      '| --- | --- | --- | --- | --- | --- |',
      ...reports.map(lineFor),
      '',
      'Parser pass is necessary but not sufficient. Record the WiseCAM result per file.',
      '',
    ].join('\n')
    writeFileSync(join(out, 'README.txt'), readme)

    const zipFiles: Record<string, Uint8Array> = {}
    for (const entry of reports) {
      zipFiles[entry.file] = new Uint8Array(readFileSync(join(out, entry.file)))
    }
    zipFiles['README.txt'] = strToU8(readme)
    writeFileSync(`${out.replace(/\/+$/, '')}.zip`, zipSync(zipFiles, { level: 6 }))
  }, 120_000)
})
