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
 * Round 2 probes. Known-good baseline: 1203 = our part + real arc section in a real package.
 * This pack pushes that baseline into the full generated package, UB, tubes, and mark variants.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-arcs \
 *     pnpm exec vitest run src/lib/wisecam/probes.arcs.test.ts
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
  markElements: string
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
    markElements: markElements(part),
  }
}

function own(mark: string, unique: string): Files {
  const bytes = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
    mark: unique,
  })
  if (!bytes) throw new Error(`cannot build own ${mark}`)
  return unzipSync(bytes) as Files
}

function svgName(files: Files, kind: 'Adobe' | 'Part'): string {
  const root = rootOf(files)
  const tag = root.match(new RegExp(`<${kind}\\b[^>]*/>`))?.[0] ?? ''
  return /svgname="([^"]+)"/.exec(tag)?.[1] ?? ''
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

function markElements(partSvg: string): string {
  const text = partSvg.match(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/)?.[0] ?? ''
  const rects = partSvg.match(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g) ?? []
  return [text, ...rects].filter(Boolean).join('\n')
}

function replaceMark(partSvg: string, elements: string): string {
  const without = partSvg
    .replace(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/, '@@MARK@@')
    .replace(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g, '')
  return without.replace('@@MARK@@', elements)
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

describe.skipIf(!outDir)('round 2 arc/mark probes', () => {
  it('writes 1300-1316 and the transfer ZIP', () => {
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

    // 1300/1302/1304/1306 controls.
    for (const [code, base] of [
      [1300, m1],
      [1302, m3],
      [1304, m35],
      [1306, m42],
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

    const ourPartBaseline = (
      base: Real,
      code: number,
      transform: (svg: string) => string,
      variant: string,
      adobe: 'real' | 'ours' = 'real',
    ): void => {
      const unique = `${base.mark}-${code}`
      const ownFiles = own(base.mark, unique)
      let part = setPartRef(
        transform(strFromU8(ownFiles['CAD/part1000.svg'] as Uint8Array)),
        base.partId,
      )
      if (adobe === 'ours') {
        const edits: Record<string, Edit> = {
          'CAD/CadRoot.xml': (text) => rename(text, base.mark, unique),
          [base.partPath]: () => part,
          [base.adobePath]: () => strFromU8(ownFiles['CAD/adobe500.svg'] as Uint8Array),
        }
        write(
          `${code}-${base.mark}-${variant}.ncep`,
          editEntries(base.entries, base.files, edits),
          unique,
          variant,
        )
        return
      }
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

    // 1301/1303/1305/1307: our part + real arc section (the 1203 baseline).
    ourPartBaseline(m1, 1301, (svg) => replaceLastGroup(svg, m1.section), 'our-part-real-section')
    ourPartBaseline(m3, 1303, (svg) => replaceLastGroup(svg, m3.section), 'our-part-real-section')
    ourPartBaseline(m35, 1305, (svg) => replaceLastGroup(svg, m35.section), 'our-part-real-section')
    ourPartBaseline(
      m42,
      1307,
      (svg) => replaceMark(replaceLastGroup(svg, m42.section), ''),
      'our-part-real-section-no-mark',
    )

    // 1308-1310: arc fix inside our full package.
    const fullCase = (
      code: number,
      variant: string,
      partArc: boolean,
      adobeMode: 'ours' | 'arc' | 'real',
    ): void => {
      const unique = `M-1-${code}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build full')
      const ownFiles = unzipSync(built) as Files
      const partPath = `CAD/${svgName(ownFiles, 'Part')}`
      const adobePath = `CAD/${svgName(ownFiles, 'Adobe')}`
      const entries = readZipRaw(built)
      const edits: Record<string, Edit> = {}
      if (partArc) {
        edits[partPath] = (text) => replaceLastGroup(text, m1.section)
      }
      if (adobeMode === 'arc') {
        edits[adobePath] = (text) => replaceLastGroup(text, lastGroup(m1.adobe))
      } else if (adobeMode === 'real') {
        edits[adobePath] = () => rename(m1.adobe, 'M-1', unique)
      }
      write(
        `${code}-our-M-1-${variant}.ncep`,
        editEntries(entries, ownFiles, edits),
        unique,
        variant,
      )
    }
    fullCase(1308, 'arc-part-only', true, 'ours')
    fullCase(1309, 'arc-part-adobe', true, 'arc')
    fullCase(1310, 'arc-part-real-adobe', true, 'real')

    // 1311/1312: M-1 mark variants on the arc baseline.
    ourPartBaseline(
      m1,
      1311,
      (svg) =>
        replaceMark(replaceLastGroup(svg, m1.section), rename(m1.markElements, 'M-1', 'M-1-1311')),
      'our-part-real-section-real-mark',
    )
    ourPartBaseline(
      m1,
      1312,
      (svg) => replaceMark(replaceLastGroup(svg, m1.section), ''),
      'our-part-real-section-no-mark',
    )

    // 1313/1314: M-35 mark variants on the arc baseline.
    ourPartBaseline(
      m35,
      1313,
      (svg) =>
        replaceMark(
          replaceLastGroup(svg, m35.section),
          rename(m35.markElements, 'M-35', 'M-35-1313'),
        ),
      'our-part-real-section-real-mark',
    )
    ourPartBaseline(
      m35,
      1314,
      (svg) => replaceMark(replaceLastGroup(svg, m35.section), ''),
      'our-part-real-section-no-mark',
    )

    // 1315: M-42 with the default mark kept (compare against 1307/no-mark).
    ourPartBaseline(
      m42,
      1315,
      (svg) => replaceLastGroup(svg, m42.section),
      'our-part-real-section-default-mark',
    )

    // 1316: UB with the real text + bars.
    ourPartBaseline(
      m3,
      1316,
      (svg) =>
        replaceMark(replaceLastGroup(svg, m3.section), rename(m3.markElements, 'M-3', 'M-3-1316')),
      'our-part-real-section-real-mark',
    )

    expect(reports).toHaveLength(17)
    const readme = [
      'Round 2 probes (1300–1316)',
      '',
      'Baseline: 1203 proved that our part + the real arc section group loads and saves. This pack',
      'takes that baseline and tests arcs in the full package, UB/tube arc sections, and marks.',
      '',
      '## Test order',
      '1. 1300 real M-1 control; 1301 our part + real arc section (1203 baseline).',
      '2. 1308 full package + arc part only; 1309 + arc Adobe; 1310 + real Adobe.',
      '3. 1302/1303 UB control + our part with real arc section.',
      '4. 1304/1305 M-35 control + our part with real arc section.',
      '5. 1306/1307 M-42 control + our part with real arc section and no mark.',
      '6. 1311/1312 M-1 real mark vs no mark on the arc baseline.',
      '7. 1313/1314 M-35 real mark vs no mark on the arc baseline.',
      '8. 1315 M-42 default mark on the arc baseline (compare 1307).',
      '9. 1316 UB real text + bars on the arc baseline.',
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
