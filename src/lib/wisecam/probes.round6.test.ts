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
 * Round 6 probes: rotate/flip section arc sweeps (with real trims/holes/marks fixed) and test
 * corrected layer-4 marking bars.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-round6 \
 *     pnpm exec vitest run src/lib/wisecam/probes.round6.test.ts
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

const ARC_RE =
  /A(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?),(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+([01]),([01])\s+(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?),(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g

function rotatedSweeps(path: string, transform: (sweeps: number[]) => number[]): string {
  const sweeps = [...path.matchAll(ARC_RE)].map((m) => Number(m[5]))
  const next = transform(sweeps)
  let index = 0
  return path.replace(ARC_RE, (_match, rx, ry, rot, large, _sweep, x, y) => {
    const sweep = next[index++] ?? 0
    return `A${rx},${ry} ${rot} ${large},${sweep} ${x},${y}`
  })
}

function rotateSectionSweeps(group: string, pathIndex: number, shift: number): string {
  const paths = sectionPaths(group)
  paths[pathIndex] = rotatedSweeps(paths[pathIndex] ?? '', (sweeps) =>
    sweeps.map((_, index) => sweeps[(index + shift) % sweeps.length] ?? 0),
  )
  return composeSection(group, paths)
}

function flattenSectionSweeps(group: string, pathIndex: number, value: 0 | 1): string {
  const paths = sectionPaths(group)
  paths[pathIndex] = rotatedSweeps(paths[pathIndex] ?? '', (sweeps) => sweeps.map(() => value))
  return composeSection(group, paths)
}

function flipSectionSweeps(group: string, pathIndex: number): string {
  const paths = sectionPaths(group)
  paths[pathIndex] = rotatedSweeps(paths[pathIndex] ?? '', (sweeps) =>
    sweeps.map((sweep) => (sweep === 0 ? 1 : 0)),
  )
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

function correctBars(marks: string): string {
  return barsOnly(marks).replace(/<rect\b[^>]*\/>/g, (tag) => {
    let next = tag
      .replace(/wh:layer="6"/, 'wh:layer="4"')
      .replace(/class="layer6"/, 'class="layer4"')
    if (/wh:params="/.test(next)) {
      next = next.replace(/wh:params="([^"]*)"/, (_match, params: string) => {
        const value = params.includes('needSetAdobe=') ? params : `${params}needSetAdobe=true;`
        return `wh:params="${value}"`
      })
    } else {
      next = next.replace(/\/>$/, ' wh:params="needSetAdobe=true;"/>')
    }
    return next
  })
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

describe.skipIf(!outDir)('round 6 arc rotation / corrected marking', () => {
  it('writes 2100-2125 and the transfer ZIP', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Report[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }
    const m3 = real('M-3')
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
      [2100, m3],
      [2110, m35],
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

    // UB sweep rotation/flip with real trims/holes/marks fixed.
    const ub = (code: number, transform: (group: string) => string, variant: string): void =>
      inReal(m3, code, variant, (svg, unique) => {
        const next = clean(m3, svg, unique)
        return replaceLastGroup(next, transform(m3.section))
      })
    ub(2101, (g) => g, 'original-sweeps')
    ub(2102, (g) => rotateSectionSweeps(g, 0, 1), 'rotate-sweeps-1')
    ub(2103, (g) => rotateSectionSweeps(g, 0, 2), 'rotate-sweeps-2')
    ub(2104, (g) => rotateSectionSweeps(g, 0, 3), 'rotate-sweeps-3')
    ub(2105, (g) => flipSectionSweeps(g, 0), 'flip-all-sweeps')
    ub(2106, (g) => flattenSectionSweeps(g, 0, 0), 'all-sweep-0')
    ub(2107, (g) => flattenSectionSweeps(g, 0, 1), 'all-sweep-1')

    // Tube outer-sweep rotation/flip with real features fixed.
    const tube = (code: number, transform: (group: string) => string, variant: string): void =>
      inReal(m35, code, variant, (svg, unique) => {
        const next = clean(m35, svg, unique)
        return replaceLastGroup(next, transform(m35.section))
      })
    tube(2111, (g) => g, 'original-sweeps')
    tube(2112, (g) => rotateSectionSweeps(g, 0, 1), 'rotate-sweeps-1')
    tube(2113, (g) => rotateSectionSweeps(g, 0, 2), 'rotate-sweeps-2')
    tube(2114, (g) => rotateSectionSweeps(g, 0, 3), 'rotate-sweeps-3')
    tube(2115, (g) => flipSectionSweeps(g, 0), 'flip-all-sweeps')
    tube(2116, (g) => flattenSectionSweeps(g, 0, 0), 'all-sweep-0')
    tube(2117, (g) => flattenSectionSweeps(g, 0, 1), 'all-sweep-1')

    // Corrected marking bars on the UB part.
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
    markCase(2120, 'our-text-only', (_unique, svg) => textOnly(svg))
    markCase(2121, 'real-text-uncorrected-bars', (unique) =>
      rename(m3.marks, m3.internalMark, unique),
    )
    markCase(2122, 'real-text-corrected-bars', (unique) => {
      const text = rename(textOnly(m3.marks), m3.internalMark, unique)
      return `${text}\n${correctBars(m3.marks)}`
    })
    markCase(
      2123,
      'our-text-corrected-bars',
      (_unique, svg) => `${textOnly(svg)}\n${correctBars(m3.marks)}`,
    )
    markCase(2124, 'corrected-bars-only', () => correctBars(m3.marks))
    markCase(2125, 'uncorrected-bars-only', () => barsOnly(m3.marks))

    expect(reports).toHaveLength(22)
    const readme = [
      'Round 6 probes (2100–2125)',
      '',
      'Arc sweeps are rotated/flipped with real trims/holes/marks fixed, to test whether the arc',
      'assignment/orientation is systematically wrong. Marking probes compare uncorrected layer-6',
      'bars with corrected layer-4 + needSetAdobe bars.',
      '',
      'Groups:',
      '- 2100–2107 UB arc-sweep rotation/flip',
      '- 2110–2117 tube arc-sweep rotation/flip',
      '- 2120–2125 UB marking correction',
      '',
      'Anchors: 2101/2111 original sweeps, 2105/2115 flipped, 2121 uncorrected bars,',
      '2122 corrected bars.',
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
