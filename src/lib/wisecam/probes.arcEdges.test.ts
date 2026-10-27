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
 * Arc-edge probes. Isolates curved developed edges vs hidden arcs, and extends the real-arc
 * section to full packages for UB and tubes.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-arc-edges \
 *     pnpm exec vitest run src/lib/wisecam/probes.arcEdges.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

interface Real {
  mark: string
  entries: RawZipEntry[]
  files: Files
  partPath: string
  adobePath: string
  partId: string
  part: string
  adobe: string
  section: string
  adobeSection: string
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

function sectionPaths(group: string): string[] {
  return group.match(/<path\b[^>]*\/>/g) ?? []
}

function composeSection(group: string, paths: string[]): string {
  const without = group.replace(/<path\b[^>]*\/>/g, '')
  return without.replace(/<\/g>$/, `${paths.join('\n  ')}</g>`)
}

/** Replace every SVG arc with a straight chord to the arc endpoint. */
function arcsToLines(d: string): string {
  return d.replace(/A([^MLAZ]*)/g, (_match, params: string) => {
    const numbers = params.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []
    const x = numbers.at(-2) ?? '0'
    const y = numbers.at(-1) ?? '0'
    return `L${x},${y}`
  })
}

function sharpSection(group: string): string {
  return group.replace(/<path\b[^>]*\/>/g, (tag) => {
    const match = /\bd="([^"]*)"/.exec(tag)
    if (!match) return tag
    return tag.replace(match[0], `d="${arcsToLines(match[1])}"`)
  })
}

function replaceMark(partSvg: string, elements: string): string {
  const without = partSvg
    .replace(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/, '@@MARK@@')
    .replace(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g, '')
  return without.replace('@@MARK@@', elements)
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
  const adobe = strFromU8(files[`CAD/${adobeName}`] as Uint8Array)
  return {
    mark,
    entries,
    files,
    partPath: `CAD/${partName}`,
    adobePath: `CAD/${adobeName}`,
    partId,
    part,
    adobe,
    section: lastGroup(part),
    adobeSection: lastGroup(adobe),
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

function editEntries(
  entries: RawZipEntry[],
  files: Files,
  edits: Record<string, Edit>,
): RawZipEntry[] {
  return entries.map((entry) => {
    const edit = edits[entry.name]
    if (!edit) return entry
    const data = strToU8(edit(strFromU8(files[entry.name] as Uint8Array)))
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

describe.skipIf(!outDir)('arc-edge probes', () => {
  it('writes 1400-1417 and the transfer ZIP', () => {
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
      [1400, m1],
      [1406, m3],
      [1411, m35],
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

    const inReal = (
      base: Real,
      code: number,
      transform: (svg: string) => string,
      variant: string,
    ): void => {
      const unique = `${base.mark}-${code}`
      const ownFiles = own(base.mark, unique)
      const ownPart = strFromU8(ownFiles['CAD/part1000.svg'] as Uint8Array)
      const part = setPartRef(transform(ownPart), base.partId)
      write(
        `${code}-${base.mark}-${variant}.ncep`,
        editEntries(base.entries, base.files, {
          'CAD/CadRoot.xml': (text) => rename(text, base.mark, unique),
          [base.adobePath]: (text) => rename(text, base.mark, unique),
          [base.partPath]: () => part,
        }),
        unique,
        variant,
      )
    }

    const full = (
      base: Real,
      code: number,
      partTransform: (svg: string) => string,
      adobeArc: string | null,
      variant: string,
    ): void => {
      const unique = `${base.mark}-${code}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', `${base.mark}.nc1`), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build full')
      const files = unzipSync(built) as Files
      const partPath = `CAD/${svgName(files, 'Part')}`
      const adobePath = `CAD/${svgName(files, 'Adobe')}`
      const edits: Record<string, Edit> = {
        [partPath]: partTransform,
      }
      if (adobeArc) edits[adobePath] = (text) => replaceLastGroup(text, adobeArc)
      write(
        `${code}-${base.mark}-${variant}.ncep`,
        editEntries(readZipRaw(built), files, edits),
        unique,
        variant,
      )
    }

    const ourSection = (base: Real, unique: string): string =>
      lastGroup(strFromU8(own(base.mark, unique)['CAD/part1000.svg'] as Uint8Array))
    const realPaths = (base: Real): string[] => sectionPaths(base.section)
    const ourPaths = (base: Real, unique: string): string[] =>
      sectionPaths(ourSection(base, unique))

    // 1401-1405 PFC: real arcs, sampled, sharp cavity, and outer/inner path mixes.
    inReal(m1, 1401, (svg) => replaceLastGroup(svg, m1.section), 'real-section')
    inReal(m1, 1402, (svg) => svg, 'sampled-section')
    inReal(m1, 1403, (svg) => replaceLastGroup(svg, sharpSection(m1.section)), 'sharp-cavity')
    {
      const unique = 'M-1-1404'
      const paths = [realPaths(m1)[0], ourPaths(m1, unique)[1]]
      inReal(
        m1,
        1404,
        (svg) => replaceLastGroup(svg, composeSection(m1.section, paths)),
        'real-outer-sampled-inner',
      )
    }
    {
      const unique = 'M-1-1405'
      const paths = [ourPaths(m1, unique)[0], realPaths(m1)[1]]
      inReal(
        m1,
        1405,
        (svg) => replaceLastGroup(svg, composeSection(m1.section, paths)),
        'sampled-outer-real-inner',
      )
    }

    // 1407-1410 UB: real arcs, sharp root, full package part/Adobe arcs.
    inReal(m3, 1407, (svg) => replaceLastGroup(svg, m3.section), 'real-section')
    inReal(m3, 1408, (svg) => replaceLastGroup(svg, sharpSection(m3.section)), 'sharp-root')
    full(m3, 1409, (svg) => replaceLastGroup(svg, m3.section), null, 'full-real-section')
    full(
      m3,
      1410,
      (svg) => replaceLastGroup(svg, m3.section),
      m3.adobeSection,
      'full-real-section-adobe',
    )

    // 1412-1415 tube: real arcs, outer/inner mixes, full package arcs.
    inReal(m35, 1412, (svg) => replaceLastGroup(svg, m35.section), 'real-section')
    {
      const unique = 'M-35-1413'
      const paths = [realPaths(m35)[0], ourPaths(m35, unique)[1]]
      inReal(
        m35,
        1413,
        (svg) => replaceLastGroup(svg, composeSection(m35.section, paths)),
        'real-outer-sampled-inner',
      )
    }
    {
      const unique = 'M-35-1414'
      const paths = [ourPaths(m35, unique)[0], realPaths(m35)[1]]
      inReal(
        m35,
        1414,
        (svg) => replaceLastGroup(svg, composeSection(m35.section, paths)),
        'sampled-outer-real-inner',
      )
    }
    full(
      m35,
      1415,
      (svg) => replaceLastGroup(svg, m35.section),
      m35.adobeSection,
      'full-real-section-adobe',
    )

    // 1416-1417 M-42 short tube: real arcs/no mark, full package arcs/no mark.
    inReal(
      m42,
      1416,
      (svg) => replaceMark(replaceLastGroup(svg, m42.section), ''),
      'real-section-no-mark',
    )
    full(
      m42,
      1417,
      (svg) => replaceMark(replaceLastGroup(svg, m42.section), ''),
      m42.adobeSection,
      'full-real-section-no-mark-adobe',
    )

    expect(reports).toHaveLength(18)
    const readme = [
      'Arc-edge probes (1400–1417)',
      '',
      'Isolates curved developed edges vs hidden arcs, and extends the real-arc section to full',
      'packages for UB and tubes. Known-good baseline: 1203/1301 (our part + real arc section).',
      '',
      '## Test order',
      '1. 1400 M-1 control; 1401 real arcs; 1402 sampled; 1403 sharp cavity;',
      '   1404 real outer + sampled inner; 1405 sampled outer + real inner.',
      '2. 1406 M-3 control; 1407 real arcs; 1408 sharp root;',
      '   1409 full package + real arcs; 1410 full package + real arcs in Adobe too.',
      '3. 1411 M-35 control; 1412 real arcs; 1413 real outer + sampled inner;',
      '   1414 sampled outer + real inner; 1415 full package + real arcs in part + Adobe.',
      '4. 1416 M-42 real arcs/no mark; 1417 full package real arcs/no mark + Adobe.',
      '',
      'PFC: arcs live in the cavity. If 1403 (sharp cavity) loads, the arcs themselves matter;',
      'if it fails, the sampled vertex mismatch is the issue. 1404/1405 say which path matters.',
      'UB: 1407 vs 1408 separates real root fillets from a sharp root.',
      'Tubes: 1413/1414 separate outer-skin corner radii from the hidden inner void.',
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
