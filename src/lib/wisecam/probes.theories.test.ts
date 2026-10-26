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
 * Theory probes. Real sample = container/docs/Adobe control; one theory per file. Also stretches
 * our generated parts into the real M-1/M-3/M-35/M-42 containers and tests the combo forms.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-theories \
 *     pnpm exec vitest run src/lib/wisecam/probes.theories.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

interface Report {
  file: string
  mark: string
  variant: string
  errors: string[]
  warnings: string[]
  groups: number
  userPaths: number
  sectionGroups: number
}

interface Real {
  mark: string
  raw: Uint8Array
  entries: RawZipEntry[]
  files: Files
  partPath: string
  adobePath: string
  partId: string
  part: string
  adobe: string
}

function real(mark: string): Real {
  const raw = new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`)))
  const entries = readZipRaw(raw)
  const files = unzipSync(raw) as Files
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const partName = /<Part\b[^>]*svgname="([^"]+)"/.exec(root)?.[1] ?? ''
  const adobeName = /<Adobe\b[^>]*svgname="([^"]+)"/.exec(root)?.[1] ?? ''
  const partId = /<Part\b[^>]*idref="([^"]+)"/.exec(root)?.[1] ?? ''
  return {
    mark,
    raw,
    entries,
    files,
    partPath: `CAD/${partName}`,
    adobePath: `CAD/${adobeName}`,
    partId,
    part: strFromU8(files[`CAD/${partName}`] as Uint8Array),
    adobe: strFromU8(files[`CAD/${adobeName}`] as Uint8Array),
  }
}

function own(mark: string, unique: string): Files {
  const bytes = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
    mark: unique,
  })
  if (!bytes) throw new Error(`cannot build own ${mark}`)
  return unzipSync(bytes) as Files
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

function setPartRef(svg: string, id: string): string {
  return svg.replace(/wh:refid="[^"]*"/, `wh:refid="${id}"`)
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

function nestSection(svg: string): string {
  const part = svg.match(/<g\b[^>]*wh:class="cadpart"[^>]*>[\s\S]*?<\/g>/)?.[0] ?? ''
  const section = svg.match(/<g\b[^>]*wh:class="cadgroup"[^>]*>[\s\S]*?<\/g>/)?.[0] ?? ''
  if (!part || !section) throw new Error('part/section not found')
  return svg.replace(section, '').replace(part, part.replace(/<\/g>$/, `${section}</g>`))
}

function edited(base: Real, edits: Record<string, Edit>): RawZipEntry[] {
  return base.entries.map((entry) => {
    const edit = edits[entry.name]
    if (!edit) return entry
    const data = strToU8(edit(strFromU8(base.files[entry.name] as Uint8Array)))
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

function report(file: string, mark: string, variant: string, pkg: NcepPackage): Report {
  return {
    file,
    mark,
    variant,
    errors: pkg.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code),
    warnings: pkg.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.code),
    groups: pkg.partSvg?.groups.length ?? 0,
    userPaths: pkg.adobeSvg?.userPaths.length ?? 0,
    sectionGroups: pkg.partSvg?.sections.length ?? 0,
  }
}

function lineFor(entry: Report): string {
  const parser = [
    ...entry.errors.map((code) => `error:${code}`),
    ...entry.warnings.map((code) => `warn:${code}`),
  ]
  return `| ${entry.file} | ${entry.mark} | ${entry.variant} | ${entry.groups} | ${entry.sectionGroups} | ${entry.userPaths} | ${parser.join(', ') || 'ok'} |`
}

describe.skipIf(!outDir)('theory probes', () => {
  it('writes 1200-1215 and the transfer ZIP', () => {
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
    const realSection = lastGroup(m1.part)

    // 1200: real M-1 control.
    writeFileSync(join(out, '1200-real-M-1-control.ncep'), m1.raw)
    reports.push(
      report('1200-real-M-1-control.ncep', 'M-1', 'real control', parseNcepPackage(m1.raw)),
    )

    const ourM1 = (unique: string): string =>
      strFromU8(own('M-1', unique)['CAD/part1000.svg'] as Uint8Array)
    const ourAdobeM1 = (unique: string): string =>
      strFromU8(own('M-1', unique)['CAD/adobe500.svg'] as Uint8Array)

    const m1Case = (
      code: number,
      variant: string,
      partTransform: (svg: string) => string,
      adobe?: 'ours',
    ): void => {
      const unique = `M-1-${code}`
      const part = partTransform(ourM1(unique))
      const edits: Record<string, Edit> = {
        'CAD/CadRoot.xml': (text) => rename(text, 'M-1', unique),
        [m1.adobePath]: (text) => rename(text, 'M-1', unique),
        [m1.partPath]: () => setPartRef(part, m1.partId),
      }
      if (adobe === 'ours') edits[m1.adobePath] = () => ourAdobeM1(unique)
      write(`${code}-M-1-${variant}.ncep`, edited(m1, edits), unique, variant)
    }

    // 1201/1202: section sibling vs nested.
    m1Case(1201, 'our-part-sibling', (svg) => svg)
    m1Case(1202, 'our-part-nested', nestSection)
    // 1203: our part with the real arc section group.
    m1Case(1203, 'our-part-real-section', (svg) => replaceLastGroup(svg, realSection))
    // 1204/1205: stretch = our part + our Adobe, sibling vs nested.
    m1Case(1204, 'stretch-part-adobe', (svg) => svg, 'ours')
    m1Case(1205, 'stretch-part-adobe-nested', nestSection, 'ours')

    // 1206-1208: UB control, our part, our part nested.
    writeFileSync(join(out, '1206-real-M-3-control.ncep'), m3.raw)
    reports.push(
      report('1206-real-M-3-control.ncep', 'M-3', 'real control', parseNcepPackage(m3.raw)),
    )
    const m3Case = (code: number, variant: string, transform: (svg: string) => string): void => {
      const unique = `M-3-${code}`
      const ownPart = setPartRef(
        transform(strFromU8(own('M-3', unique)['CAD/part1000.svg'] as Uint8Array)),
        m3.partId,
      )
      write(
        `${code}-M-3-${variant}.ncep`,
        edited(m3, {
          'CAD/CadRoot.xml': (text) => rename(text, 'M-3', unique),
          [m3.adobePath]: (text) => rename(text, 'M-3', unique),
          [m3.partPath]: () => ownPart,
        }),
        unique,
        variant,
      )
    }
    m3Case(1207, 'our-part-sibling', (svg) => svg)
    m3Case(1208, 'our-part-nested', nestSection)

    // 1209-1212: tube controls and stretch parts.
    for (const section of [m35, m42] as const) {
      const controlCode = section === m35 ? 1209 : 1211
      const stretchCode = controlCode + 1
      writeFileSync(join(out, `${controlCode}-real-${section.mark}-control.ncep`), section.raw)
      reports.push(
        report(
          `${controlCode}-real-${section.mark}-control.ncep`,
          section.mark,
          'real control',
          parseNcepPackage(section.raw),
        ),
      )
      const unique = `${section.mark}-${stretchCode}`
      const ownPart = setPartRef(
        strFromU8(own(section.mark, unique)['CAD/part1000.svg'] as Uint8Array),
        section.partId,
      )
      write(
        `${stretchCode}-${section.mark}-our-part.ncep`,
        edited(section, {
          'CAD/CadRoot.xml': (text) => rename(text, section.mark, unique),
          [section.adobePath]: (text) => rename(text, section.mark, unique),
          [section.partPath]: () => ownPart,
        }),
        unique,
        'our part in real container',
      )
    }

    // 1213: our full production combo.
    const full = buildNcepFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'), {
      mark: 'M-1-1213',
    })
    if (!full) throw new Error('cannot build full')
    write('1213-our-M-1-full.ncep', readZipRaw(full), 'M-1-1213', 'production combo')

    // 1214: our full production with the section nested.
    const full1214 = buildNcepFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'), {
      mark: 'M-1-1214',
    })
    if (!full1214) throw new Error('cannot build 1214')
    const files1214 = unzipSync(full1214) as Files
    const entries1214 = readZipRaw(full1214).map((entry) => {
      if (!entry.name.includes('/part')) return entry
      const data = strToU8(nestSection(strFromU8(files1214[entry.name] as Uint8Array)))
      const compressed = new Uint8Array(deflateRawSync(data))
      return {
        ...entry,
        compressed,
        compressedSize: compressed.length,
        uncompressedSize: data.length,
        crc: crc32(data),
      }
    })
    const bytes1214 = writeZipRaw(entries1214)
    writeFileSync(join(out, '1214-our-M-1-full-nested.ncep'), bytes1214)
    reports.push(
      report(
        '1214-our-M-1-full-nested.ncep',
        'M-1-1214',
        'production combo nested',
        parseNcepPackage(bytes1214),
      ),
    )

    // 1215: real docs + our nested part + our synthesized-USERPATH Adobe.
    const own1215 = own('M-1', 'M-1-1215')
    const part1215 = setPartRef(
      nestSection(strFromU8(own1215['CAD/part1000.svg'] as Uint8Array)),
      m1.partId,
    )
    const adobe1215 = strFromU8(own1215['CAD/adobe500.svg'] as Uint8Array)
    write(
      '1215-real-M-1-our-nested-part-adobe.ncep',
      edited(m1, {
        'CAD/CadRoot.xml': (text) => rename(text, 'M-1', 'M-1-1215'),
        [m1.partPath]: () => part1215,
        [m1.adobePath]: () => adobe1215,
      }),
      'M-1-1215',
      'real docs + our nested part + our Adobe',
    )

    expect(reports).toHaveLength(16)
    const readme = [
      'Theory probes (1200–1215)',
      '',
      'Real sample = container/docs/Adobe control. One theory per file. Nested-section variants are',
      'intentional: the parser rejects them, but the docs record probe 77 importing with the section',
      'nested, so they test that contradiction on WiseCAM.',
      '',
      '## Test order',
      '1. 1200 real control. If it fails, stop — transfer/cache/machine.',
      '2. 1201 sibling vs 1202 nested (our part in the real M-1).',
      '3. 1203 our part with the real arc section.',
      '4. 1204/1205 stretch: our part + our Adobe, sibling vs nested.',
      '5. 1206–1208 UB controls/stretch.',
      '6. 1209–1212 tube controls/stretch.',
      '7. 1213 production combo; 1214 production combo with nested section.',
      '8. 1215 real docs + our nested part + our Adobe (maximum-fidelity combo).',
      '',
      '## Matrix',
      '| File | CadRoot Name | Variant | Part groups | Section groups | Adobe USERPATH | Parser |',
      '| --- | --- | --- | --- | --- | --- | --- |',
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
