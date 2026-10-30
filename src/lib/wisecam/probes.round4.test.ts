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
 * Round 4 probes: per-corner arc roles (UB/tube), grey-strip hole removal, M-34 handedness, and
 * bevel child-path structure.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-round4 \
 *     pnpm exec vitest run src/lib/wisecam/probes.round4.test.ts
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

function sharpArcsInGroup(group: string, pathIndex: number, indices: Set<number>): string {
  const paths = sectionPaths(group)
  let arc = 0
  const path = paths[pathIndex] ?? ''
  const sharp = path.replace(/A([^MLAZ]*)/g, (match, params: string) => {
    const index = arc++
    if (!indices.has(index)) return match
    const numbers = params.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []
    return `L${numbers.at(-2) ?? '0'},${numbers.at(-1) ?? '0'}`
  })
  paths[pathIndex] = sharp
  return composeSection(group, paths)
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

function loadReal(path: string): Real {
  const raw = new Uint8Array(readFileSync(path))
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
    part,
    section: lastGroup(part),
    trims: trims(part),
    holes: holeBlock(part),
    marks: markElements(part),
  }
}

function real(mark: string): Real {
  return loadReal(fixture('ncep', `${mark}.ncep`))
}

function ref(name: string): Real {
  return loadReal(fixture('ncep', 'reference-variations', `${name}.ncep`))
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
    ...entry.errors.map((c) => `error:${c}`),
    ...entry.warnings.map((c) => `warn:${c}`),
  ]
  return `| ${entry.file} | ${entry.mark} | ${entry.variant} | ${entry.sectionGroups} | ${entry.userPaths} | ${parser.join(', ') || 'ok'} |`
}

describe.skipIf(!outDir)('round 4 breakthrough probes', () => {
  it('writes 1900-1944 and the transfer ZIP', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Report[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }

    const m3 = real('M-3')
    const m34 = real('M-34')
    const m35 = real('M-35')

    const inReal = (
      base: Real,
      code: number,
      variant: string,
      transform: (svg: string, unique: string) => string,
      useOwn: boolean,
    ): void => {
      const unique = `${base.internalMark}-${code}`
      const source = useOwn
        ? strFromU8(own(base.internalMark, unique)['CAD/part1000.svg'] as Uint8Array)
        : base.part
      const part = setPartRef(transform(source, unique), base.partId)
      write(
        `${code}-${base.internalMark}-${variant}.ncep`,
        editEntries(base.entries, base.files, {
          'CAD/CadRoot.xml': (text) => rename(text, base.internalMark, unique),
          [base.adobePath]: (text) => rename(text, base.internalMark, unique),
          [base.partPath]: () => part,
        }),
        unique,
        variant,
      )
    }

    // Arc-role matrix: real M-3 section has one path with four arcs.
    const ubArc = (code: number, indices: number[], variant: string): void => {
      inReal(
        m3,
        code,
        variant,
        (svg) => replaceLastGroup(svg, sharpArcsInGroup(m3.section, 0, new Set(indices))),
        true,
      )
    }
    writeFileSync(
      join(out, '1900-real-M-3-control.ncep'),
      readFileSync(fixture('ncep', 'M-3.ncep')),
    )
    reports.push(
      report(
        '1900-real-M-3-control.ncep',
        'M-3',
        'real control',
        parseNcepPackage(new Uint8Array(readFileSync(fixture('ncep', 'M-3.ncep')))),
      ),
    )
    ubArc(1901, [], 'all-arcs')
    ubArc(1902, [0], 'sharp-arc-0')
    ubArc(1903, [1], 'sharp-arc-1')
    ubArc(1904, [2], 'sharp-arc-2')
    ubArc(1905, [3], 'sharp-arc-3')
    ubArc(1906, [0, 2], 'sharp-arcs-0-2')
    ubArc(1907, [1, 3], 'sharp-arcs-1-3')
    ubArc(1908, [0, 1, 2, 3], 'sharp-all-arcs')

    // Tube arc-role matrix: outer path 0, inner path 1.
    const tubeArc = (code: number, pathIndex: number, indices: number[], variant: string): void => {
      inReal(
        m35,
        code,
        variant,
        (svg) => replaceLastGroup(svg, sharpArcsInGroup(m35.section, pathIndex, new Set(indices))),
        true,
      )
    }
    writeFileSync(
      join(out, '1910-real-M-35-control.ncep'),
      readFileSync(fixture('ncep', 'M-35.ncep')),
    )
    reports.push(
      report(
        '1910-real-M-35-control.ncep',
        'M-35',
        'real control',
        parseNcepPackage(new Uint8Array(readFileSync(fixture('ncep', 'M-35.ncep')))),
      ),
    )
    tubeArc(1911, 0, [], 'all-arcs')
    tubeArc(1912, 0, [0], 'sharp-outer-0')
    tubeArc(1913, 0, [1], 'sharp-outer-1')
    tubeArc(1914, 0, [2], 'sharp-outer-2')
    tubeArc(1915, 0, [3], 'sharp-outer-3')
    tubeArc(1916, 0, [0, 1, 2, 3], 'sharp-all-outer')
    tubeArc(1917, 1, [0, 1, 2, 3], 'sharp-all-inner')

    // Grey-strip hole removal on the real UB reference variations.
    const ubBase = ref('UB')
    const ubCorrected = ref('UB corrected hole')
    const removeColumns = (holes: string, targets: number[]): string =>
      holes.replace(/<circle\b[^>]*\/>/g, (tag) => {
        const cx = Number(/cx="([^"]+)"/.exec(tag)?.[1] ?? NaN)
        return targets.some((target) => Math.abs(cx - target) < 0.5) ? '' : tag
      })
    inReal(ubBase, 1920, 'base-control', (svg) => svg, false)
    inReal(ubCorrected, 1921, 'corrected-control', (svg) => svg, false)
    inReal(
      ubBase,
      1922,
      'minus-plus-column',
      (svg) => replaceHoles(svg, removeColumns(ubBase.holes, [178.857])),
      false,
    )
    inReal(
      ubBase,
      1923,
      'minus-minus-column',
      (svg) => replaceHoles(svg, removeColumns(ubBase.holes, [-178.857])),
      false,
    )
    inReal(
      ubBase,
      1924,
      'minus-both-columns',
      (svg) => replaceHoles(svg, removeColumns(ubBase.holes, [178.857, -178.857])),
      false,
    )

    // M-34 handedness: shift the two u-face holes from -195.5 to -194.5.
    const shiftUHoles = (holes: string): string =>
      holes.replace(/<circle\b[^>]*\/>/g, (tag) => {
        const cx = Number(/cx="([^"]+)"/.exec(tag)?.[1] ?? NaN)
        const cy = Number(/cy="([^"]+)"/.exec(tag)?.[1] ?? NaN)
        if (
          Math.abs(cx + 195.5) < 0.2 &&
          (Math.abs(cy - 4471.25) < 0.1 || Math.abs(cy - 4571.25) < 0.1)
        ) {
          return tag.replace(/cx="[^"]*"/, 'cx="-194.50"')
        }
        return tag
      })
    writeFileSync(
      join(out, '1930-real-M-34-control.ncep'),
      readFileSync(fixture('ncep', 'M-34.ncep')),
    )
    reports.push(
      report(
        '1930-real-M-34-control.ncep',
        'M-34',
        'real control',
        parseNcepPackage(new Uint8Array(readFileSync(fixture('ncep', 'M-34.ncep')))),
      ),
    )
    inReal(
      m34,
      1931,
      'our-part-our-holes',
      (svg) =>
        replaceMark(
          replaceHoles(
            replaceTrims(replaceLastGroup(svg, m34.section), {
              start: rename(m34.trims.start, m34.internalMark, `${m34.internalMark}-1931`),
              end: rename(m34.trims.end, m34.internalMark, `${m34.internalMark}-1931`),
            }),
            m34.holes,
          ),
          rename(m34.marks, m34.internalMark, `${m34.internalMark}-1931`),
        ),
      true,
    )
    inReal(
      m34,
      1932,
      'our-part-shifted-u-holes',
      (svg, unique) =>
        replaceMark(
          replaceHoles(
            replaceTrims(replaceLastGroup(svg, m34.section), {
              start: rename(m34.trims.start, m34.internalMark, unique),
              end: rename(m34.trims.end, m34.internalMark, unique),
            }),
            shiftUHoles(m34.holes),
          ),
          rename(m34.marks, m34.internalMark, unique),
        ),
      true,
    )

    // Bevel nesting: real Beveled PFC reference, edit the end trim's children.
    const bevel = ref('Beveled PFC')
    const bevelNo = ref('Beveled PFC remove bevel')
    const endTrim = (part: string): string =>
      part.match(/<path\b[^>]*IsTrucate=1;TrucateType=1;[\s\S]*?<\/path>/)?.[0] ?? ''
    const bevelChildren = (part: string): string[] => endTrim(part).match(/<path\b[^>]*\/>/g) ?? []
    inReal(bevel, 1940, 'bevel-control', (svg) => svg, false)
    inReal(bevelNo, 1941, 'remove-bevel-control', (svg) => svg, false)
    inReal(
      bevel,
      1942,
      'bevel-children-hoisted',
      (svg) => {
        const end = endTrim(svg)
        const children = bevelChildren(svg)
        const outer = end.replace(/<path\b[^>]*\/>/g, '')
        return svg.replace(end, `${outer}\n${children.join('\n')}`)
      },
      false,
    )
    inReal(
      bevel,
      1943,
      'bevel-outer-trim-removed',
      (svg) => {
        const end = endTrim(svg)
        return svg.replace(end, bevelChildren(svg).join('\n'))
      },
      false,
    )
    inReal(
      bevel,
      1944,
      'bevel-first-child-only',
      (svg) => {
        const end = endTrim(svg)
        const children = bevelChildren(svg)
        const outer = end.replace(/<path\b[^>]*\/>/g, '')
        const first = children[0] ?? ''
        return svg.replace(end, outer.replace('</path>', `${first}</path>`))
      },
      false,
    )

    expect(reports).toHaveLength(30)
    const readme = [
      'Round 4 breakthrough probes (1900–1944)',
      '',
      'Groups:',
      '- 1900–1908 UB per-corner arc roles (real M-3 section, one path, 4 arcs)',
      '- 1910–1917 tube per-corner arc roles (outer path 0, inner path 1)',
      '- 1920–1924 grey-strip hole removal from the real UB reference',
      '- 1930–1932 M-34 handedness / u-face hole shift',
      '- 1940–1944 bevel child-path nesting',
      '',
      'Known-good anchors: 1901/1911 all arcs, 1921 corrected holes, 1940 bevel control.',
      'Known-bad anchors: 1908/1916 sharp all arcs, 1943 no outer trim.',
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
    for (const entry of reports)
      zipFiles[entry.file] = new Uint8Array(readFileSync(join(out, entry.file)))
    zipFiles['README.txt'] = strToU8(readme)
    writeFileSync(`${out.replace(/\/+$/, '')}.zip`, zipSync(zipFiles, { level: 6 }))
  }, 120_000)
})
