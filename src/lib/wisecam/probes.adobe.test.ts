import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { fixture } from '@test/fixtures'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildNcepFromNc } from './fromNc'
import { type NcepPackage, ncepErrors, parseNcepPackage } from './ncepParse'
import { crc32 } from './ncex'
import { type RawZipEntry, readZipRaw, writeZipRaw } from './probeZip'

/**
 * Adobe-isolation probes. Base is the byte-identical real M-1 package; only the Adobe SVG (or a
 * consistent mark rename) changes. Use this to prove or disprove the Adobe structure hypothesis.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-adobe \
 *     pnpm exec vitest run src/lib/wisecam/probes.adobe.test.ts
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
  adobeGroups: number
  userPaths: number
  sectionPaths: number
}

const BASE = 'M-1'
const OUR_ADOBE = 'CAD/adobe500.svg'

function svgName(files: Files, kind: 'Adobe' | 'Part'): string {
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
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

function ownFiles(mark: string): Files {
  const bytes = buildNcepFromNc(readFileSync(fixture('ncep', `${BASE}.nc1`), 'utf8'), { mark })
  if (!bytes) throw new Error(`cannot build own ${mark}`)
  return unzipSync(bytes) as Files
}

function lastGroup(svg: string): string {
  const start = svg.lastIndexOf('<g ')
  const end = svg.indexOf('</g>', start)
  if (start < 0 || end < 0) throw new Error('no group found')
  return svg.slice(start, end + 4)
}

function userPathGroup(adobe: string): string {
  const group = adobe.match(/<g\b[^>]*wh:params="USERPATH=USERPATH;"[^>]*>[\s\S]*?<\/g>/)?.[0]
  if (!group) throw new Error('real adobe has no USERPATH group')
  return group
}

function removeUserPath(adobe: string): string {
  return adobe.replace(userPathGroup(adobe), '')
}

function insertBeforeLastGroup(adobe: string, group: string): string {
  const at = adobe.lastIndexOf('<g ')
  if (at < 0) throw new Error('no last group')
  return `${adobe.slice(0, at)}${group}\n ${adobe.slice(at)}`
}

function replaceLastGroup(adobe: string, group: string): string {
  const old = lastGroup(adobe)
  return adobe.replace(old, group)
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

function report(file: string, mark: string, variant: string, pkg: NcepPackage): ProbeReport {
  return {
    file,
    mark,
    variant,
    errors: pkg.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code),
    warnings: pkg.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.code),
    adobeGroups: pkg.adobeSvg?.groups.length ?? 0,
    userPaths: pkg.adobeSvg?.userPaths.length ?? 0,
    sectionPaths:
      pkg.adobeSvg?.sections.reduce((total, group) => total + group.wires.length, 0) ?? 0,
  }
}

function lineFor(entry: ProbeReport): string {
  const parser = [
    ...entry.errors.map((code) => `error:${code}`),
    ...entry.warnings.map((code) => `warn:${code}`),
  ]
  return `| ${entry.file} | ${entry.mark} | ${entry.variant} | ${entry.adobeGroups} | ${entry.userPaths} | ${entry.sectionPaths} | ${parser.join(', ') || 'ok'} |`
}

describe.skipIf(!outDir)('Adobe isolation probes', () => {
  it('writes 900-911 and the transfer ZIP', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const baseRaw = new Uint8Array(readFileSync(fixture('ncep', `${BASE}.ncep`)))
    const baseEntries = readZipRaw(baseRaw)
    const baseFiles = unzipSync(baseRaw) as Files
    const realAdobeName = svgName(baseFiles, 'Adobe')
    const realAdobePath = `CAD/${realAdobeName}`
    const realPartName = svgName(baseFiles, 'Part')
    const realPartPath = `CAD/${realPartName}`
    const realAdobe = strFromU8(baseFiles[realAdobePath] as Uint8Array)
    const realSection = lastGroup(realAdobe)
    const realUserPath = userPathGroup(realAdobe)

    const reports: ProbeReport[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }

    // 900: byte-identical real control.
    writeFileSync(join(out, '900-real-M-1-control.ncep'), baseRaw)
    reports.push(
      report(
        '900-real-M-1-control.ncep',
        BASE,
        'byte-identical real control',
        parseNcepPackage(baseRaw),
      ),
    )

    // 901: consistent rename control (real SVGs, unique mark).
    write(
      '901-real-M-1-renamed.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, BASE, 'M-1-901'),
        [realPartPath]: (text) => rename(text, BASE, 'M-1-901'),
        [realAdobePath]: (text) => rename(text, BASE, 'M-1-901'),
      }),
      'M-1-901',
      'consistent rename control',
    )

    // 902: real package + our Adobe only.
    const our902 = ownFiles('M-1-902')
    write(
      '902-real-M-1-our-adobe.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, BASE, 'M-1-902'),
        [realPartPath]: (text) => rename(text, BASE, 'M-1-902'),
        [realAdobePath]: () =>
          removeUserPath(strFromU8(our902[OUR_ADOBE as keyof Files] as Uint8Array)),
      }),
      'M-1-902',
      'our Adobe without USERPATH',
    )

    // 903: our Adobe + real USERPATH group.
    const our903 = ownFiles('M-1-903')
    write(
      '903-real-M-1-our-adobe-userpath.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, BASE, 'M-1-903'),
        [realPartPath]: (text) => rename(text, BASE, 'M-1-903'),
        [realAdobePath]: () =>
          insertBeforeLastGroup(
            removeUserPath(strFromU8(our903[OUR_ADOBE as keyof Files] as Uint8Array)),
            realUserPath,
          ),
      }),
      'M-1-903',
      'our Adobe without USERPATH + real USERPATH',
    )

    // 904: our Adobe + real section group.
    const our904 = ownFiles('M-1-904')
    write(
      '904-real-M-1-our-adobe-section.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, BASE, 'M-1-904'),
        [realPartPath]: (text) => rename(text, BASE, 'M-1-904'),
        [realAdobePath]: () =>
          replaceLastGroup(
            removeUserPath(strFromU8(our904[OUR_ADOBE as keyof Files] as Uint8Array)),
            realSection,
          ),
      }),
      'M-1-904',
      'our Adobe without USERPATH + real section',
    )

    // 905: our Adobe + real USERPATH + real section.
    const our905 = ownFiles('M-1-905')
    write(
      '905-real-M-1-our-adobe-full.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, BASE, 'M-1-905'),
        [realPartPath]: (text) => rename(text, BASE, 'M-1-905'),
        [realAdobePath]: () =>
          insertBeforeLastGroup(
            replaceLastGroup(
              removeUserPath(strFromU8(our905[OUR_ADOBE as keyof Files] as Uint8Array)),
              realSection,
            ),
            realUserPath,
          ),
      }),
      'M-1-905',
      'our Adobe without USERPATH + real USERPATH + real section',
    )

    // 906: real Adobe minus USERPATH.
    write(
      '906-real-M-1-adobe-no-userpath.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, BASE, 'M-1-906'),
        [realPartPath]: (text) => rename(text, BASE, 'M-1-906'),
        [realAdobePath]: (text) => removeUserPath(rename(text, BASE, 'M-1-906')),
      }),
      'M-1-906',
      'real Adobe, USERPATH removed',
    )

    // 907: real Adobe with our section group.
    const our907 = ownFiles('M-1-907')
    write(
      '907-real-M-1-adobe-our-section.ncep',
      edited(baseEntries, baseFiles, {
        'CAD/CadRoot.xml': (text) => rename(text, BASE, 'M-1-907'),
        [realPartPath]: (text) => rename(text, BASE, 'M-1-907'),
        [realAdobePath]: (text) =>
          replaceLastGroup(
            rename(text, BASE, 'M-1-907'),
            lastGroup(strFromU8(our907[OUR_ADOBE as keyof Files] as Uint8Array)),
          ),
      }),
      'M-1-907',
      'real Adobe + our section',
    )

    // 908: our full package + real Adobe.
    const our908 = ownFiles('M-1-908')
    const our908Adobe = svgName(our908, 'Adobe')
    write(
      '908-our-M-1-real-adobe.ncep',
      edited(
        readZipRaw(
          buildNcepFromNc(readFileSync(fixture('ncep', `${BASE}.nc1`), 'utf8'), {
            mark: 'M-1-908',
          }) as Uint8Array,
        ),
        our908,
        {
          [`CAD/${our908Adobe}`]: () => rename(realAdobe, BASE, 'M-1-908'),
        },
      ),
      'M-1-908',
      'our package + real Adobe',
    )

    // 909: our full package + our Adobe + real USERPATH.
    const our909 = ownFiles('M-1-909')
    const our909Adobe = svgName(our909, 'Adobe')
    write(
      '909-our-M-1-adobe-userpath.ncep',
      edited(
        readZipRaw(
          buildNcepFromNc(readFileSync(fixture('ncep', `${BASE}.nc1`), 'utf8'), {
            mark: 'M-1-909',
          }) as Uint8Array,
        ),
        our909,
        {
          [`CAD/${our909Adobe}`]: (text) =>
            insertBeforeLastGroup(removeUserPath(text), realUserPath),
        },
      ),
      'M-1-909',
      'our package + our Adobe without USERPATH + real USERPATH',
    )

    // 910: our full package + our Adobe + real section.
    const our910 = ownFiles('M-1-910')
    const our910Adobe = svgName(our910, 'Adobe')
    write(
      '910-our-M-1-adobe-section.ncep',
      edited(
        readZipRaw(
          buildNcepFromNc(readFileSync(fixture('ncep', `${BASE}.nc1`), 'utf8'), {
            mark: 'M-1-910',
          }) as Uint8Array,
        ),
        our910,
        {
          [`CAD/${our910Adobe}`]: (text) => replaceLastGroup(removeUserPath(text), realSection),
        },
      ),
      'M-1-910',
      'our package + our Adobe without USERPATH + real section',
    )

    // 911: our full package + our Adobe + real USERPATH + real section.
    const our911 = ownFiles('M-1-911')
    const our911Adobe = svgName(our911, 'Adobe')
    write(
      '911-our-M-1-adobe-full.ncep',
      edited(
        readZipRaw(
          buildNcepFromNc(readFileSync(fixture('ncep', `${BASE}.nc1`), 'utf8'), {
            mark: 'M-1-911',
          }) as Uint8Array,
        ),
        our911,
        {
          [`CAD/${our911Adobe}`]: (text) =>
            insertBeforeLastGroup(
              replaceLastGroup(removeUserPath(text), realSection),
              realUserPath,
            ),
        },
      ),
      'M-1-911',
      'our package + our Adobe without USERPATH + real USERPATH + real section',
    )

    expect(reports).toHaveLength(12)
    const readme = [
      'Adobe isolation probes (900–911)',
      '',
      'Base: byte-identical real M-1.ncep. Only the Adobe SVG (or a consistent mark rename) changes.',
      'Import one at a time. Stop at the first failure and report the code.',
      '',
      '## Test order',
      '1. 900 real control; 901 consistent rename control.',
      '2. 902 our Adobe without USERPATH. If this fails, the Adobe is the problem.',
      '3. 903 our Adobe without USERPATH + real USERPATH. If this passes, USERPATH is the cause.',
      '4. 904 our Adobe without USERPATH + real section. If this passes, the sampled section is the cause.',
      '5. 905 our Adobe without USERPATH + real USERPATH + real section should pass if the Adobe is the only issue.',
      '6. 906 real Adobe minus USERPATH; 907 real Adobe + our section.',
      '7. 908–911 repeat the Adobe matrix inside our full package.',
      '',
      '## Matrix',
      '| File | CadRoot Name | Variant | Adobe groups | USERPATH | Section paths | Parser |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...reports.map(lineFor),
      '',
      'Parser pass is necessary but not sufficient. Record the actual WiseCAM result per file.',
      '',
    ].join('\n')
    writeFileSync(join(out, 'README.txt'), readme)

    const zipFiles: Record<string, Uint8Array> = {}
    for (const entry of reports) {
      zipFiles[entry.file] = new Uint8Array(readFileSync(join(out, entry.file)))
    }
    zipFiles['README.txt'] = strToU8(readme)
    writeFileSync(`${out.replace(/\/+$/, '')}.zip`, zipSync(zipFiles, { level: 6 }))

    expect(ncepErrors(parseNcepPackage(baseRaw))).toEqual([])
  }, 120_000)
})
