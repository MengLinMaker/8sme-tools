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
 * Feature-matrix probes. Real container throughout, so they remain valid while the full-package
 * container fix is confirmed. Isolates UB front trims/holes/marks, M-42 section/trim/mark, M-34
 * notched-start features and quantity.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-feature-matrix \
 *     pnpm exec vitest run src/lib/wisecam/probes.featureMatrix.test.ts
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
    ...entry.errors.map((code) => `error:${code}`),
    ...entry.warnings.map((code) => `warn:${code}`),
  ]
  return `| ${entry.file} | ${entry.mark} | ${entry.variant} | ${entry.sectionGroups} | ${entry.userPaths} | ${parser.join(', ') || 'ok'} |`
}

describe.skipIf(!outDir)('feature-matrix probes', () => {
  it('writes 1800-1831 and the transfer ZIP', () => {
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
    const m34 = real('M-34')
    const m42 = real('M-42')

    const controls: [number, Real][] = [
      [1800, m3],
      [1810, m42],
      [1820, m34],
      [1830, m1],
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
      variant: string,
      transform: (svg: string, unique: string) => string,
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

    // UB feature matrix: real section fixed; ours/real trims × ours/real holes × ours/real marks.
    const ubCase = (
      code: number,
      realTrims: boolean,
      realHoles: boolean,
      realMarks: boolean,
    ): void => {
      inReal(
        m3,
        code,
        `${realTrims ? 'real' : 'our'}-trims-${realHoles ? 'real' : 'our'}-holes-${realMarks ? 'real' : 'our'}-marks`,
        (svg, unique) => {
          let next = replaceLastGroup(svg, m3.section)
          if (realTrims) {
            next = replaceTrims(next, {
              start: rename(m3.trims.start, m3.mark, unique),
              end: rename(m3.trims.end, m3.mark, unique),
            })
          }
          if (realHoles) next = replaceHoles(next, m3.holes)
          if (realMarks) next = replaceMark(next, rename(m3.marks, m3.mark, unique))
          return next
        },
      )
    }
    ubCase(1801, false, true, true)
    ubCase(1802, true, false, true)
    ubCase(1803, true, true, false)
    ubCase(1804, false, false, true)
    ubCase(1805, false, true, false)
    ubCase(1806, true, false, false)
    ubCase(1807, false, false, false)
    ubCase(1808, true, true, true)

    // M-42 matrix: section ours/real × trims ours/real × no mark/default mark.
    const m42Case = (
      code: number,
      realSection: boolean,
      realTrims: boolean,
      defaultMark: boolean,
    ): void => {
      inReal(
        m42,
        code,
        `${realSection ? 'real' : 'our'}-section-${realTrims ? 'real' : 'our'}-trims-${defaultMark ? 'default' : 'no'}-mark`,
        (svg, unique) => {
          let next = replaceLastGroup(svg, realSection ? m42.section : lastGroup(svg))
          if (realTrims) {
            next = replaceTrims(next, {
              start: rename(m42.trims.start, m42.mark, unique),
              end: rename(m42.trims.end, m42.mark, unique),
            })
          }
          if (!defaultMark) next = replaceMark(next, '')
          return next
        },
      )
    }
    m42Case(1811, false, false, false)
    m42Case(1812, true, false, false)
    m42Case(1813, false, true, false)
    m42Case(1814, true, true, false)
    m42Case(1815, true, true, true)
    m42Case(1816, false, false, true)

    // M-34 PFC notched-start matrix.
    inReal(m34, 1821, 'all-real-features', (svg, unique) =>
      replaceMark(
        replaceHoles(
          replaceTrims(replaceLastGroup(svg, m34.section), {
            start: rename(m34.trims.start, m34.mark, unique),
            end: rename(m34.trims.end, m34.mark, unique),
          }),
          m34.holes,
        ),
        rename(m34.marks, m34.mark, unique),
      ),
    )
    inReal(m34, 1822, 'real-section-real-trims-our-holes-marks', (svg, unique) =>
      replaceTrims(replaceLastGroup(svg, m34.section), {
        start: rename(m34.trims.start, m34.mark, unique),
        end: rename(m34.trims.end, m34.mark, unique),
      }),
    )
    inReal(m34, 1823, 'our-section-real-trims-holes-marks', (svg, unique) =>
      replaceMark(
        replaceHoles(
          replaceTrims(svg, {
            start: rename(m34.trims.start, m34.mark, unique),
            end: rename(m34.trims.end, m34.mark, unique),
          }),
          m34.holes,
        ),
        rename(m34.marks, m34.mark, unique),
      ),
    )

    // Quantity probe: real M-1 with TotalCount=2, unique mark.
    {
      const unique = 'M-1-1831'
      const entries = editEntries(m1.entries, m1.files, {
        'CAD/CadRoot.xml': (text) =>
          rename(text, m1.mark, unique).replace(/TotalCount=1/g, 'TotalCount=2'),
        [m1.partPath]: (text) => rename(text, m1.mark, unique),
        [m1.adobePath]: (text) => rename(text, m1.mark, unique),
      })
      write('1831-M-1-quantity-2.ncep', entries, unique, 'quantity 2')
    }

    expect(reports).toHaveLength(22)
    const readme = [
      'Feature-matrix probes (1800–1831)',
      '',
      'Real containers throughout, so these are independent of the full-package container fix.',
      '',
      '## Test order',
      '1. 1800 M-3 control; 1801–1808 UB trims × holes × marks matrix.',
      '2. 1810 M-42 control; 1811–1816 section × trims × mark matrix.',
      '3. 1820 M-34 control; 1821 all-real features; 1822 our trims; 1823 our section.',
      '4. 1830 M-1 control; 1831 TotalCount=2.',
      '',
      'UB matrix isolates which front feature causes the remaining cut glitch:',
      'trims, holes or marks. 1807 is all-ours, 1808 all-real.',
      '',
      'M-42 matrix isolates whether the mitre is the trims, the section, or both;',
      '1814 all-real/no-mark should load, 1812 real section + our trims isolates the trims.',
      '',
      'M-34 is a PFC with a notched/bevelled start: 1821 all-real, 1822 our trims,',
      '1823 our section, which separates the start-cut development from the section.',
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
