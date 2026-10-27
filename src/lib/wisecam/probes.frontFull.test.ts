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
 * Round 3 probes: UB front trims/holes/marks, M-42 mitre, full-package docs/container combos,
 * and sharp-chord outer sections (production alternative to true arcs).
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-front-full \
 *     pnpm exec vitest run src/lib/wisecam/probes.frontFull.test.ts
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

function sectionPaths(group: string): string[] {
  return group.match(/<path\b[^>]*\/>/g) ?? []
}

function composeSection(group: string, paths: string[]): string {
  const without = group.replace(/<path\b[^>]*\/>/g, '')
  return without.replace(/<\/g>$/, `${paths.join('\n  ')}</g>`)
}

function arcsToLines(d: string): string {
  return d.replace(/A([^MLAZ]*)/g, (_match, params: string) => {
    const numbers = params.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []
    return `L${numbers.at(-2) ?? '0'},${numbers.at(-1) ?? '0'}`
  })
}

function sharpPath(path: string): string {
  const match = /\bd="([^"]*)"/.exec(path)
  return match ? path.replace(match[0], `d="${arcsToLines(match[1])}"`) : path
}

function sharpSection(group: string): string {
  return composeSection(
    group,
    sectionPaths(group).map((path) => sharpPath(path)),
  )
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

function setPartRef(svg: string, id: string): string {
  return svg.replace(/wh:refid="[^"]*"/, `wh:refid="${id}"`)
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
    trims: trims(part),
    holes: holeBlock(part),
    marks: markElements(part),
  }
}

function own(mark: string, unique: string): Files {
  const bytes = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
    mark: unique,
  })
  if (!bytes) throw new Error(`cannot build own ${mark}`)
  return unzipSync(bytes) as Files
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

function withContent(entry: RawZipEntry, text: string): RawZipEntry {
  const data = strToU8(text)
  const compressed = new Uint8Array(deflateRawSync(data))
  return {
    ...entry,
    compressed,
    compressedSize: compressed.length,
    uncompressedSize: data.length,
    crc: crc32(data),
  }
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

describe.skipIf(!outDir)('round 3 front/full probes', () => {
  it('writes 1500-1531 and the transfer ZIP', () => {
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

    const controls: [number, Real][] = [
      [1500, m3],
      [1505, m1],
      [1507, m35],
      [1510, m42],
    ]
    for (const [code, base] of controls) {
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
      transform: (svg: string, unique: string) => string,
      variant: string,
    ): void => {
      const unique = `${base.mark}-${code}`
      const ownFiles = own(base.mark, unique)
      const ownPart = strFromU8(ownFiles['CAD/part1000.svg'] as Uint8Array)
      const part = setPartRef(transform(ownPart, unique), base.partId)
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

    // Known-good baselines: our part + real arc section.
    inReal(m1, 1506, (svg) => replaceLastGroup(svg, m1.section), 'our-part-real-section')
    inReal(m35, 1508, (svg) => replaceLastGroup(svg, m35.section), 'our-part-real-section')

    // 1501-1504 UB front features: real section, then trims/holes/marks; sharp root at the end.
    inReal(
      m3,
      1501,
      (svg, unique) =>
        replaceTrims(replaceLastGroup(svg, m3.section), renameTrims(m3.trims, m3.mark, unique)),
      'real-section-real-trims',
    )
    inReal(
      m3,
      1502,
      (svg, unique) =>
        replaceHoles(
          replaceTrims(replaceLastGroup(svg, m3.section), renameTrims(m3.trims, m3.mark, unique)),
          m3.holes,
        ),
      'real-section-trims-holes',
    )
    inReal(
      m3,
      1503,
      (svg, unique) =>
        replaceMark(
          replaceHoles(
            replaceTrims(replaceLastGroup(svg, m3.section), renameTrims(m3.trims, m3.mark, unique)),
            m3.holes,
          ),
          rename(m3.marks, m3.mark, unique),
        ),
      'real-section-trims-holes-marks',
    )
    inReal(
      m3,
      1504,
      (svg, unique) =>
        replaceMark(
          replaceHoles(
            replaceTrims(
              replaceLastGroup(svg, sharpSection(m3.section)),
              renameTrims(m3.trims, m3.mark, unique),
            ),
            m3.holes,
          ),
          rename(m3.marks, m3.mark, unique),
        ),
      'sharp-root-trims-holes-marks',
    )

    // 1511-1513 M-42 mitre: real section + real trims, our section + real trims, default mark.
    inReal(
      m42,
      1511,
      (svg, unique) =>
        replaceMark(
          replaceTrims(
            replaceLastGroup(svg, m42.section),
            renameTrims(m42.trims, m42.mark, unique),
          ),
          '',
        ),
      'real-section-real-trims-no-mark',
    )
    inReal(
      m42,
      1512,
      (svg, unique) => replaceMark(replaceTrims(svg, renameTrims(m42.trims, m42.mark, unique)), ''),
      'our-section-real-trims-no-mark',
    )
    inReal(
      m42,
      1513,
      (svg, unique) =>
        replaceMark(
          replaceTrims(
            replaceLastGroup(svg, m42.section),
            renameTrims(m42.trims, m42.mark, unique),
          ),
          strFromU8(own('M-42', unique)['CAD/part1000.svg'] as Uint8Array).match(
            /<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/,
          )?.[0] ?? '',
        ),
      'real-section-real-trims-default-mark',
    )

    const full = (
      base: Real,
      code: number,
      variant: string,
      mutate: (state: {
        unique: string
        files: Files
        entries: RawZipEntry[]
        partPath: string
        adobePath: string
        edits: Record<string, Edit>
      }) => void,
    ): void => {
      const unique = `${base.mark}-${code}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', `${base.mark}.nc1`), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build full')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const state = {
        unique,
        files,
        entries,
        partPath: `CAD/${svgName(files, 'Part')}`,
        adobePath: `CAD/${svgName(files, 'Adobe')}`,
        edits: {} as Record<string, Edit>,
      }
      mutate(state)
      write(
        `${code}-${base.mark}-${variant}.ncep`,
        editEntries(state.entries, state.files, state.edits),
        unique,
        variant,
      )
    }

    // 1520-1523 full-package matrix: docs/container vs part/Adobe.
    full(m1, 1520, 'our-docs-real-svgs', ({ unique, files, partPath, adobePath, edits }) => {
      const ourPartId = /<Part\b[^>]*idref="([^"]+)"/.exec(rootOf(files))?.[1] ?? ''
      edits[partPath] = () => setPartRef(rename(m1.part, m1.mark, unique), ourPartId)
      edits[adobePath] = () => rename(m1.adobe, m1.mark, unique)
    })
    full(m1, 1521, 'real-docs-our-svgs', ({ unique, files, entries, partPath, adobePath }) => {
      const root = rootOf(m1.files)
      const realPartName = /<Part\b[^>]*svgname="([^"]+)"/.exec(root)?.[1] ?? ''
      const realAdobeName = /<Adobe\b[^>]*svgname="([^"]+)"/.exec(root)?.[1] ?? ''
      const realPartId = /<Part\b[^>]*idref="([^"]+)"/.exec(root)?.[1] ?? ''
      const partText = setPartRef(strFromU8(files[partPath] as Uint8Array), realPartId)
      const adobeText = strFromU8(files[adobePath] as Uint8Array)
      const docs = new Set([
        'CAD/CadRoot.xml',
        'CAD/cad.opf',
        'CAD/Technology.xml',
        'CAD/CustomizeData.xml',
        'ncex.opf',
      ])
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index] as RawZipEntry
        if (entry.name === partPath) {
          entries[index] = { ...withContent(entry, partText), name: `CAD/${realPartName}` }
        } else if (entry.name === adobePath) {
          entries[index] = { ...withContent(entry, adobeText), name: `CAD/${realAdobeName}` }
        } else if (docs.has(entry.name)) {
          const realText = strFromU8(m1.files[entry.name] as Uint8Array)
          entries[index] = withContent(
            entry,
            entry.name === 'CAD/CadRoot.xml' ? rename(realText, m1.mark, unique) : realText,
          )
        }
      }
    })
    full(m1, 1522, 'our-docs-real-part-our-adobe', ({ unique, files, partPath, edits }) => {
      const ourPartId = /<Part\b[^>]*idref="([^"]+)"/.exec(rootOf(files))?.[1] ?? ''
      edits[partPath] = () => setPartRef(rename(m1.part, m1.mark, unique), ourPartId)
    })
    full(m1, 1523, 'our-docs-our-part-real-adobe', ({ unique, adobePath, edits }) => {
      edits[adobePath] = () => rename(m1.adobe, m1.mark, unique)
    })

    // 1524-1526 full package + our part features: all-real, real trims, no mark.
    full(m1, 1524, 'full-real-part-features', ({ unique, partPath, edits }) => {
      edits[partPath] = (text) =>
        replaceMark(
          replaceHoles(
            replaceTrims(
              replaceLastGroup(text, m1.section),
              renameTrims(m1.trims, m1.mark, unique),
            ),
            m1.holes,
          ),
          rename(m1.marks, m1.mark, unique),
        )
    })
    full(m1, 1525, 'full-real-section-trims', ({ unique, partPath, edits }) => {
      edits[partPath] = (text) =>
        replaceTrims(replaceLastGroup(text, m1.section), renameTrims(m1.trims, m1.mark, unique))
    })
    full(m1, 1526, 'full-real-section-no-mark', ({ partPath, edits }) => {
      edits[partPath] = (text) => replaceMark(replaceLastGroup(text, m1.section), '')
    })

    // 1530-1531 sharp-chord outer section + sampled inner (production alternative).
    {
      const unique = 'M-35-1530'
      const ownFiles = own('M-35', unique)
      const ownPart = strFromU8(ownFiles['CAD/part1000.svg'] as Uint8Array)
      const ourInner = sectionPaths(lastGroup(ownPart))[1] ?? ''
      const sharpOuterPath = sharpPath(sectionPaths(m35.section)[0] ?? '')
      const section = composeSection(m35.section, [sharpOuterPath, ourInner])
      inReal(m35, 1530, (svg) => replaceLastGroup(svg, section), 'sharp-outer-sampled-inner')
    }
    {
      const unique = 'M-1-1531'
      const ownFiles = own('M-1', unique)
      const ownPart = strFromU8(ownFiles['CAD/part1000.svg'] as Uint8Array)
      const ourInner = sectionPaths(lastGroup(ownPart))[1] ?? ''
      const sharpOuterPath = sharpPath(sectionPaths(m1.section)[0] ?? '')
      const section = composeSection(m1.section, [sharpOuterPath, ourInner])
      inReal(m1, 1531, (svg) => replaceLastGroup(svg, section), 'sharp-outer-sampled-inner')
    }

    expect(reports).toHaveLength(22)
    const readme = [
      'Round 3 probes (1500–1531)',
      '',
      'Builds on the arc-bundle results: exact outer section is required; UB has a front-trim issue;',
      'M-42 has a mitre/end-cut issue; full packages still reject even with arcs.',
      '',
      '## Test order',
      '1. 1505 M-1 control + 1506 known-good baseline;',
      '   1500 M-3 control; 1501 real section + real trims; 1502 + real holes;',
      '   1503 + real marks; 1504 sharp root + real trims/holes/marks.',
      '   1507 M-35 control + 1508 known-good baseline.',
      '2. 1510 M-42 control; 1511 real section + real trims, no mark;',
      '   1512 our section + real trims, no mark; 1513 real section + real trims + default mark.',
      '3. 1520 our docs + real SVGs (our zipQt); 1521 real docs + our SVGs (our zipQt);',
      '   1522 our docs + real part + our Adobe; 1523 our docs + our part + real Adobe.',
      '4. 1524 our part with real section/trims/holes/marks; 1525 real section + real trims;',
      '   1526 real section, no mark.',
      '5. 1530 M-35 sharp outer + sampled inner; 1531 M-1 sharp outer + sampled inner.',
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

function renameTrims(
  trims: { start: string; end: string },
  from: string,
  to: string,
): { start: string; end: string } {
  return { start: rename(trims.start, from, to), end: rename(trims.end, from, to) }
}
