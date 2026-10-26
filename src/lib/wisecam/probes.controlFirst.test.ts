import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { fixture } from '@test/fixtures'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildNcepFromNc } from './fromNc'
import { type NcepPackage, ncepErrors, parseNcepPackage } from './ncepParse'
import { crc32, zipQt } from './ncex'
import { type RawZipEntry, readZipRaw, writeZipRaw } from './probeZip'

/**
 * Control-first package probes. The previous own-NC pack failed even with real part + real Adobe,
 * so this pack starts from the byte-identical real M-1 package and replaces one file at a time.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-control-first \
 *     pnpm exec vitest run src/lib/wisecam/probes.controlFirst.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

interface ProbeReport {
  file: string
  mark: string
  variant: string
  errors: string[]
  warnings: string[]
}

const BASE = 'M-1'
const OUT_MARK = 'M-1'
const OUR_PART = 'CAD/part1000.svg'
const OUR_ADOBE = 'CAD/adobe500.svg'

function svgName(files: Files, kind: 'Adobe' | 'Part'): string {
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const tag = root.match(new RegExp(`<${kind}\\b[^>]*/>`))?.[0] ?? ''
  return /svgname="([^"]+)"/.exec(tag)?.[1] ?? ''
}

function partId(files: Files): string {
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  return /<Part\b[^>]*idref="([^"]+)"/.exec(root)?.[1] ?? ''
}

function setPartRef(svg: string, id: string): string {
  return svg.replace(/wh:refid="[^"]*"/, `wh:refid="${id}"`)
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

function ownFiles(mark: string): Files {
  const bytes = buildNcepFromNc(readFileSync(fixture('ncep', `${BASE}.nc1`), 'utf8'), { mark })
  if (!bytes) throw new Error(`cannot build own ${mark}`)
  return unzipSync(bytes) as Files
}

function renameEntry(entries: RawZipEntry[], from: string, to: string): RawZipEntry[] {
  return entries.map((entry) => (entry.name === from ? { ...entry, name: to } : entry))
}

function edited(entries: RawZipEntry[], files: Files, edits: Record<string, Edit>): RawZipEntry[] {
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

function codes(issues: NcepPackage['issues'], severity: 'error' | 'warning'): string[] {
  return issues.filter((issue) => issue.severity === severity).map((issue) => issue.code)
}

function lineFor(report: ProbeReport): string {
  const parser = [
    ...report.errors.map((code) => `error:${code}`),
    ...report.warnings.map((code) => `warn:${code}`),
  ]
  return `| ${report.file} | ${report.mark} | ${report.variant} | ${parser.join(', ') || 'ok'} |`
}

describe.skipIf(!outDir)('control-first package probes', () => {
  it('writes 800-808 and the transfer ZIP', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const baseRaw = new Uint8Array(readFileSync(fixture('ncep', `${BASE}.ncep`)))
    const baseEntries = readZipRaw(baseRaw)
    const baseFiles = unzipSync(baseRaw) as Files
    const realPartName = svgName(baseFiles, 'Part')
    const realAdobeName = svgName(baseFiles, 'Adobe')
    const realPartPath = `CAD/${realPartName}`
    const realAdobePath = `CAD/${realAdobeName}`
    const realPartId = partId(baseFiles)
    const realPart = strFromU8(baseFiles[realPartPath] as Uint8Array)
    const realAdobe = strFromU8(baseFiles[realAdobePath] as Uint8Array)

    const reports: ProbeReport[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      const pkg = parseNcepPackage(bytes)
      reports.push({
        file: name,
        mark,
        variant,
        errors: codes(pkg.issues, 'error'),
        warnings: codes(pkg.issues, 'warning'),
      })
    }

    // 800: byte-identical real control.
    writeFileSync(join(out, '800-real-M-1-control.ncep'), baseRaw)
    const controlPkg = parseNcepPackage(baseRaw)
    reports.push({
      file: '800-real-M-1-control.ncep',
      mark: OUT_MARK,
      variant: 'byte-identical real control',
      errors: codes(controlPkg.issues, 'error'),
      warnings: codes(controlPkg.issues, 'warning'),
    })

    // 801: re-zipped with our writer, no content edits.
    write('801-real-M-1-rezip.ncep', baseEntries, OUT_MARK, 're-zipped control')

    // 802: only technologyID changes.
    write(
      '802-real-M-1-fresh-guid.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) =>
          text.replace(
            /technologyID="[^"]*"/g,
            () => `technologyID="${randomUUID().toUpperCase()}"`,
          ),
      }),
      OUT_MARK,
      'fresh technologyID',
    )

    // 803: rename the mark consistently, SVG geometry unchanged.
    write(
      '803-real-M-1-renamed.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, OUT_MARK, 'M-1-803'),
        [realPartPath]: (text) => rename(text, OUT_MARK, 'M-1-803'),
        [realAdobePath]: (text) => rename(text, OUT_MARK, 'M-1-803'),
      }),
      'M-1-803',
      'consistent rename',
    )

    // 804: real package + our part SVG only.
    const our804 = ownFiles('M-1-804')
    write(
      '804-real-M-1-our-part.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, OUT_MARK, 'M-1-804'),
        [realAdobePath]: (text) => rename(text, OUT_MARK, 'M-1-804'),
        [realPartPath]: () =>
          setPartRef(strFromU8(our804[OUR_PART as keyof Files] as Uint8Array), realPartId),
      }),
      'M-1-804',
      'our part only',
    )

    // 805: real package + our Adobe SVG only.
    const our805 = ownFiles('M-1-805')
    write(
      '805-real-M-1-our-adobe.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, OUT_MARK, 'M-1-805'),
        [realPartPath]: (text) => rename(text, OUT_MARK, 'M-1-805'),
        [realAdobePath]: () => strFromU8(our805[OUR_ADOBE as keyof Files] as Uint8Array),
      }),
      'M-1-805',
      'our Adobe only',
    )

    // 806: real SVGs + all our package docs (CadRoot/Technology/CustomizeData/opf).
    const our806 = ownFiles('M-1-806')
    const docs806: Record<string, Edit> = {
      'CAD/CadRoot.xml': () => strFromU8(our806['CAD/CadRoot.xml'] as Uint8Array),
      'CAD/Technology.xml': () => strFromU8(our806['CAD/Technology.xml'] as Uint8Array),
      'CAD/CustomizeData.xml': () => strFromU8(our806['CAD/CustomizeData.xml'] as Uint8Array),
      'CAD/cad.opf': () => strFromU8(our806['CAD/cad.opf'] as Uint8Array),
      'ncex.opf': () => strFromU8(our806['ncex.opf'] as Uint8Array),
    }
    docs806[realPartPath] = () => setPartRef(rename(realPart, OUT_MARK, 'M-1-806'), '1000')
    docs806[realAdobePath] = () => rename(realAdobe, OUT_MARK, 'M-1-806')
    write(
      '806-real-M-1-our-docs.ncep',
      renameEntry(
        renameEntry(edited(baseEntries, baseFiles, docs806), realPartPath, OUR_PART),
        realAdobePath,
        OUR_ADOBE,
      ),
      'M-1-806',
      'our package docs, real SVGs',
    )

    // 809: byte-identical real content, re-encoded by our production ZIP writer (`zipQt`).
    const realFiles = unzipSync(baseRaw) as Files
    const realOrder = baseEntries.map((entry) => entry.name)
    write(
      '809-real-M-1-zipqt.ncep',
      readZipRaw(zipQt(realFiles, realOrder)),
      OUT_MARK,
      'real content through zipQt',
    )

    // 810: same, but with the real DOS timestamp (isolates timestamps).
    write(
      '810-real-M-1-zipqt-real-time.ncep',
      readZipRaw(zipQt(realFiles, realOrder, { timestamp: new Date(2026, 9, 20, 11, 3, 54) })),
      OUT_MARK,
      'real content through zipQt, real timestamp',
    )

    // 811: same, but stored (isolates fflate deflate).
    write(
      '811-real-M-1-zipqt-stored.ncep',
      readZipRaw(
        zipQt(realFiles, realOrder, {
          timestamp: new Date(2026, 9, 20, 11, 3, 54),
          storeAll: true,
        }),
      ),
      OUT_MARK,
      'real content through zipQt, stored',
    )

    // 807: our full generated package.
    const own807 = buildNcepFromNc(readFileSync(fixture('ncep', `${BASE}.nc1`), 'utf8'), {
      mark: 'M-1-807',
    })
    if (!own807) throw new Error('cannot build own M-1-807')
    write('807-our-M-1-full.ncep', readZipRaw(own807), 'M-1-807', 'our full package')

    // 808: our SVGs + the real package docs.
    const our808 = ownFiles('M-1-808')
    write(
      '808-our-M-1-svgs-real-docs.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, OUT_MARK, 'M-1-808'),
        [realPartPath]: () =>
          setPartRef(strFromU8(our808[OUR_PART as keyof Files] as Uint8Array), realPartId),
        [realAdobePath]: () => strFromU8(our808[OUR_ADOBE as keyof Files] as Uint8Array),
      }),
      'M-1-808',
      'our SVGs, real package docs',
    )

    expect(reports).toHaveLength(12)
    const readme = [
      'Control-first package probes (800–808)',
      '',
      'Base: the byte-identical real M-1.ncep. One file (or one consistent rename) changes per probe.',
      'Import one at a time. Stop at the first failure and report which code failed.',
      '',
      '## Test order',
      '1. 800 real control. If this fails, stop — transfer/machine/cache is the problem.',
      '2. 801 re-zipped control. If this fails, our ZIP writer is the problem.',
      '3. 802 fresh technologyID. If this fails, technologyID/cache is the problem.',
      '4. 803 consistent rename. If this fails, mark/name handling is the problem.',
      '5. 804 our part, then 805 our Adobe.',
      '6. 809 real content through our production zipQt. If this fails, the ZIP writer is',
      '   the problem. 810 adds the real timestamp; 811 stores (no deflate) to isolate those.',
      '7. 806 our package docs + real SVGs, then 807 our full package.',
      '8. 808 our SVGs + real package docs. Compare 806 and 808 to tell docs from SVGs.',
      '',
      '## Matrix',
      '| File | CadRoot Name | Variant | Parser |',
      '| --- | --- | --- | --- |',
      ...reports.map(lineFor),
      '',
      'Parser pass is necessary but not sufficient. Record the actual WiseCAM result per file.',
      '',
    ].join('\n')
    writeFileSync(join(out, 'README.txt'), readme)

    const zipFiles: Record<string, Uint8Array> = {}
    for (const report of reports) {
      zipFiles[report.file] = new Uint8Array(readFileSync(join(out, report.file)))
    }
    zipFiles['README.txt'] = strToU8(readme)
    writeFileSync(`${out.replace(/\/+$/, '')}.zip`, zipSync(zipFiles, { level: 6 }))

    // The real control must always be valid.
    expect(ncepErrors(controlPkg)).toEqual([])
  }, 120_000)
})
