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
 * Round 5 probes: clean arc isolation (real trims/holes/marks fixed), marking structure, and
 * M-34 start-trim development.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-round5 \
 *     pnpm exec vitest run src/lib/wisecam/probes.round5.test.ts
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

function sharpArcs(group: string, pathIndex: number, indices: Set<number>): string {
  const paths = sectionPaths(group)
  let arc = 0
  paths[pathIndex] = (paths[pathIndex] ?? '').replace(/A([^MLAZ]*)/g, (match, params: string) => {
    const index = arc++
    if (!indices.has(index)) return match
    const numbers = params.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []
    return `L${numbers.at(-2) ?? '0'},${numbers.at(-1) ?? '0'}`
  })
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

function textOnly(marks: string): string {
  return marks.match(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/)?.[0] ?? ''
}

function barsOnly(marks: string): string {
  return (marks.match(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g) ?? []).join('\n')
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
  }
}

function lineFor(entry: Report): string {
  const parser = [
    ...entry.errors.map((c) => `error:${c}`),
    ...entry.warnings.map((c) => `warn:${c}`),
  ]
  return `| ${entry.file} | ${entry.mark} | ${entry.variant} | ${parser.join(', ') || 'ok'} |`
}

describe.skipIf(!outDir)('round 5 clean arc/mark probes', () => {
  it('writes 2000-2030 and the transfer ZIP', () => {
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
    ): void => {
      const label = `${code} ${variant.replace(/-/g, ' ')}`
      const source = strFromU8(own(base.internalMark, label)['CAD/part1000.svg'] as Uint8Array)
      const part = setPartRef(transform(source, label), base.partId)
      write(
        `${label}.ncep`,
        editEntries(base.entries, base.files, {
          'CAD/CadRoot.xml': (text) => rename(text, base.internalMark, label),
          [base.adobePath]: (text) => rename(text, base.internalMark, label),
          [base.partPath]: () => part,
        }),
        label,
        variant,
      )
    }

    const clean = (base: Real, svg: string, unique: string): string => {
      let next = replaceLastGroup(svg, base.section)
      next = replaceTrims(next, {
        start: rename(base.trims.start, base.internalMark, unique),
        end: rename(base.trims.end, base.internalMark, unique),
      })
      next = replaceHoles(next, base.holes)
      next = replaceMark(next, rename(base.marks, base.internalMark, unique))
      return next
    }

    // Controls.
    for (const [code, base] of [
      [2000, m3],
      [2010, m35],
      [2030, m34],
    ] as const) {
      const raw = new Uint8Array(readFileSync(fixture('ncep', `${base.internalMark}.ncep`)))
      writeFileSync(join(out, `${code}-real-${base.internalMark}-control.ncep`), raw)
      reports.push(
        report(
          `${code}-real-${base.internalMark}-control.ncep`,
          base.internalMark,
          'real control',
          parseNcepPackage(raw),
        ),
      )
    }

    // UB clean arc matrix: real trims/holes/marks fixed, only section arcs vary.
    const ub = (code: number, indices: number[], variant: string): void =>
      inReal(m3, code, variant, (svg, unique) => {
        const next = clean(m3, svg, unique)
        return replaceLastGroup(next, sharpArcs(m3.section, 0, new Set(indices)))
      })
    ub(2001, [], 'clean-all-arcs')
    ub(2002, [0], 'clean-sharp-arc-0')
    ub(2003, [1], 'clean-sharp-arc-1')
    ub(2004, [2], 'clean-sharp-arc-2')
    ub(2005, [3], 'clean-sharp-arc-3')
    ub(2006, [0, 2], 'clean-sharp-arcs-0-2')
    ub(2007, [1, 3], 'clean-sharp-arcs-1-3')
    ub(2008, [0, 1, 2, 3], 'clean-sharp-all-arcs')

    // Tube clean arc matrix.
    const tube = (code: number, pathIndex: number, indices: number[], variant: string): void =>
      inReal(m35, code, variant, (svg, unique) => {
        const next = clean(m35, svg, unique)
        return replaceLastGroup(next, sharpArcs(m35.section, pathIndex, new Set(indices)))
      })
    tube(2011, 0, [], 'clean-all-arcs')
    tube(2012, 0, [0], 'clean-sharp-outer-0')
    tube(2013, 0, [1], 'clean-sharp-outer-1')
    tube(2014, 0, [2], 'clean-sharp-outer-2')
    tube(2015, 0, [3], 'clean-sharp-outer-3')
    tube(2016, 0, [0, 1, 2, 3], 'clean-sharp-all-outer')
    tube(2017, 1, [0, 1, 2, 3], 'clean-sharp-all-inner')

    // UB marking structure: clean geometry, vary text/bars.
    const markCase = (
      code: number,
      variant: string,
      elements: (unique: string, svg: string) => string,
    ): void =>
      inReal(m3, code, variant, (svg, unique) => {
        let next = replaceLastGroup(svg, m3.section)
        next = replaceTrims(next, {
          start: rename(m3.trims.start, m3.internalMark, unique),
          end: rename(m3.trims.end, m3.internalMark, unique),
        })
        next = replaceHoles(next, m3.holes)
        return replaceMark(next, elements(unique, svg))
      })
    markCase(2020, 'our-text-only', (_unique, svg) => textOnly(svg))
    markCase(2021, 'real-text-bars', (unique) => rename(m3.marks, m3.internalMark, unique))
    markCase(
      2022,
      'our-text-real-bars',
      (_unique, svg) => `${textOnly(svg)}\n${barsOnly(m3.marks)}`,
    )
    markCase(2023, 'real-text-only', (unique) =>
      rename(textOnly(m3.marks), m3.internalMark, unique),
    )

    // M-34: our trims, real section/holes/marks.
    inReal(m34, 2031, 'our-trims', (svg, unique) => {
      let next = replaceLastGroup(svg, m34.section)
      next = replaceHoles(next, m34.holes)
      next = replaceMark(next, rename(m34.marks, m34.internalMark, unique))
      return next
    })

    expect(reports).toHaveLength(23)
    const readme = [
      'Round 5 clean arc/mark probes (2000–2031)',
      '',
      'The round-4 arc probes were confounded by our trims/marks. This pack fixes real trims, holes',
      'and marks first, then varies only the section arcs. Marking probes vary text/bars on clean',
      'geometry. 2031 tests our M-34 notched start cut.',
      '',
      'Groups:',
      '- 2000–2008 UB clean arc roles',
      '- 2010–2017 tube clean arc roles',
      '- 2020–2023 UB marking structure',
      '- 2030–2031 M-34 control / our trims',
      '',
      'Anchors: 2001/2011 all arcs, 2008 sharp all arcs, 2021 real text+bars, 2020 our text only.',
      '',
      '## Matrix',
      '| File | CadRoot Name | Variant | Parser |',
      '| --- | --- | --- | --- |',
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
