import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, it } from 'vitest'
import { crc32, zipQt } from './ncex'
import {
  entryNamed,
  type RawZipEntry,
  readZipRaw,
  replaceCompressed,
  writeZipRaw,
} from './probeZip'

/**
 * Failure probes. `77` (our content, Python zlib bytes, Qt metadata) works; `90` (same
 * content through `zipQt`) fails. These pin down whether fflate, timestamps or the header
 * layout is responsible, and put our PFC content back inside untouched real ZIP headers.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-100-108 \
 *     pnpm exec vitest run src/lib/wisecam/probes.zip.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES
const DOWNLOADS = join(homedir(), 'Downloads')
const GOOD_77 = join(DOWNLOADS, 'ncep-probes-70-83', '77-raw-our-package-qtmeta.ncep')
const BAD_90 = join(DOWNLOADS, 'ncep-probes-90-94', '90-M-1-our-full.ncep')
const REAL_DIR = join(DOWNLOADS, 'NCEP samples 2 Hidden Grove')
const OUR_DIR = join(DOWNLOADS, 'ncep-probes-90-94')

type Files = Record<string, Uint8Array>

function replaceContent(
  entries: RawZipEntry[],
  name: string,
  data: Uint8Array,
  compressed: Uint8Array,
): RawZipEntry[] {
  return entries.map((entry) =>
    entry.name === name
      ? {
          ...entry,
          compressed,
          compressedSize: compressed.length,
          uncompressedSize: data.length,
          crc: crc32(data),
        }
      : entry,
  )
}

function withZlib(entries: RawZipEntry[], name: string, data: Uint8Array): RawZipEntry[] {
  return replaceContent(entries, name, data, new Uint8Array(deflateRawSync(data)))
}

function svgInfo(files: Files, kind: 'Adobe' | 'Part'): { idref: string; svgname: string } {
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const tag = root.match(new RegExp(`<${kind}\\b[^>]*/>`))?.[0] ?? ''
  return {
    idref: /idref="([^"]+)"/.exec(tag)?.[1] ?? '',
    svgname: /svgname="([^"]+)"/.exec(tag)?.[1] ?? '',
  }
}

function baseZoneId(files: Files): string {
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  return /<BaseZone\b[^>]*idref="([^"]+)"/.exec(root)?.[1] ?? '52'
}

describe.skipIf(!outDir)('write ZIP failure probes', () => {
  it('writes fflate/zlib/timestamp/flag probes and real-header PFC probes', () => {
    if (!existsSync(GOOD_77) || !existsSync(BAD_90)) {
      throw new Error(`missing ${GOOD_77} or ${BAD_90}`)
    }
    mkdirSync(outDir as string, { recursive: true })
    const good = readZipRaw(new Uint8Array(readFileSync(GOOD_77)))
    const bad = readZipRaw(new Uint8Array(readFileSync(BAD_90)))
    const goodTime = entryNamed(good, 'mimetype')
    const badTime = entryNamed(bad, 'mimetype')
    const fflateBytes = (name: string): Uint8Array => entryNamed(bad, name).compressed
    const out = (name: string, entries: RawZipEntry[]): void => {
      writeFileSync(join(outDir as string, name), writeZipRaw(entries))
    }

    out('100-control-77.ncep', good)
    out(
      '101-77-cadroot-fflate.ncep',
      replaceCompressed(good, 'CAD/CadRoot.xml', fflateBytes('CAD/CadRoot.xml')),
    )
    out(
      '102-77-part-fflate.ncep',
      replaceCompressed(good, 'CAD/part1000.svg', fflateBytes('CAD/part1000.svg')),
    )
    out(
      '103-77-all-fflate.ncep',
      good.map((entry) =>
        entry.method === 8
          ? {
              ...entry,
              compressed: fflateBytes(entry.name),
              compressedSize: fflateBytes(entry.name).length,
            }
          : entry,
      ),
    )
    out(
      '104-77-timestamps-90.ncep',
      good.map((entry) => ({ ...entry, time: badTime.time, date: badTime.date })),
    )
    out(
      '105-77-all-fflate-timestamps-90.ncep',
      good.map((entry) => ({
        ...entry,
        time: badTime.time,
        date: badTime.date,
        ...(entry.method === 8
          ? { compressed: fflateBytes(entry.name), compressedSize: fflateBytes(entry.name).length }
          : {}),
      })),
    )
    out(
      '106-90-layout-77bytes.ncep',
      bad.map((entry) => {
        const source = entryNamed(good, entry.name)
        return { ...entry, compressed: source.compressed, compressedSize: source.compressedSize }
      }),
    )
    out(
      '107-90-timestamps-77.ncep',
      bad.map((entry) => ({ ...entry, time: goodTime.time, date: goodTime.date })),
    )
    out(
      '108-90-flags0.ncep',
      bad.map((entry) =>
        entry.name.startsWith('CAD/') || entry.name.startsWith('CNC/')
          ? { ...entry, flags: 0 }
          : entry,
      ),
    )

    const goodFiles = unzipSync(new Uint8Array(readFileSync(GOOD_77))) as Files
    const goodOrder = Object.keys(goodFiles)
    const fromQt = (name: string, options: Parameters<typeof zipQt>[2]): void => {
      writeFileSync(join(outDir as string, name), zipQt(goodFiles, goodOrder, options))
    }
    fromQt('109-zipqt-level6.ncep', { level: 6 })
    fromQt('110-zipqt-level1.ncep', { level: 1 })
    fromQt('111-zipqt-stored.ncep', { storeAll: true })
    fromQt('112-zipqt-vmade20.ncep', { versionMadeBy: 20 })
    fromQt('113-zipqt-flags0.ncep', { flags: 'none' })

    for (const mark of ['M-8', 'M-34', 'M-40']) {
      const realPath = join(REAL_DIR, `${mark}.ncep`)
      const ourPath = join(OUR_DIR, `90-${mark}-our-full.ncep`)
      if (!existsSync(realPath) || !existsSync(ourPath)) continue
      const realBytes = new Uint8Array(readFileSync(realPath))
      const ourBytes = new Uint8Array(readFileSync(ourPath))
      const real = readZipRaw(realBytes)
      const realFiles = unzipSync(realBytes) as Files
      const ourFiles = unzipSync(ourBytes) as Files
      const ourPart = svgInfo(ourFiles, 'Part')
      const ourAdobe = svgInfo(ourFiles, 'Adobe')
      const realPart = svgInfo(realFiles, 'Part')
      const realAdobe = svgInfo(realFiles, 'Adobe')
      const ourPartPath = `CAD/${ourPart.svgname}`
      const ourAdobePath = `CAD/${ourAdobe.svgname}`
      const realPartPath = `CAD/${realPart.svgname}`
      const realAdobePath = `CAD/${realAdobe.svgname}`
      const part = strToU8(
        strFromU8(ourFiles[ourPartPath] as Uint8Array).replace(
          `wh:refid="${ourPart.idref}"`,
          `wh:refid="${realPart.idref}"`,
        ),
      )
      const adobe = strToU8(
        strFromU8(ourFiles[ourAdobePath] as Uint8Array).replace(
          `wh:refid="${ourAdobe.idref}"`,
          `wh:refid="${realAdobe.idref}"`,
        ),
      )

      out(`120-${mark}-real-control.ncep`, real)
      out(`121-${mark}-real-our-part.ncep`, withZlib(real, realPartPath, part))
      out(
        `122-${mark}-real-our-part-adobe.ncep`,
        withZlib(withZlib(real, realPartPath, part), realAdobePath, adobe),
      )

      const realBase = baseZoneId(realFiles)
      const root = strToU8(
        strFromU8(ourFiles['CAD/CadRoot.xml'] as Uint8Array)
          .replace(`idref="${ourAdobe.idref}"`, `idref="${realAdobe.idref}"`)
          .replace(`svgname="${ourAdobe.svgname}"`, `svgname="${realAdobe.svgname}"`)
          .replace(`idref="${ourPart.idref}"`, `idref="${realPart.idref}"`)
          .replace(`svgname="${ourPart.svgname}"`, `svgname="${realPart.svgname}"`)
          .replace('BaseZone idref="52"', `BaseZone idref="${realBase}"`),
      )
      const customize = strToU8(
        strFromU8(ourFiles['CAD/CustomizeData.xml'] as Uint8Array).replace(
          'idref="52"',
          `idref="${realBase}"`,
        ),
      )
      const nopf = strToU8(
        strFromU8(ourFiles['ncex.opf'] as Uint8Array)
          .replace(ourAdobe.svgname, realAdobe.svgname)
          .replace(ourPart.svgname, realPart.svgname),
      )
      let full = withZlib(real, realPartPath, part)
      full = withZlib(full, realAdobePath, adobe)
      full = withZlib(full, 'CAD/CadRoot.xml', root)
      full = withZlib(full, 'CAD/cad.opf', ourFiles['CAD/cad.opf'] as Uint8Array)
      full = withZlib(full, 'CAD/CustomizeData.xml', customize)
      full = withZlib(full, 'ncex.opf', nopf)
      out(`123-${mark}-real-our-full-realnames.ncep`, full)
      out(
        `124-${mark}-real-our-full-ourtech.ncep`,
        withZlib(full, 'CAD/Technology.xml', ourFiles['CAD/Technology.xml'] as Uint8Array),
      )
    }

    writeFileSync(
      join(outDir as string, 'README.txt'),
      [
        'ZIP failure isolation (100-113): start from the working 77 package.',
        '  100 control; 101/102/103 fflate bytes; 104/105 timestamps;',
        '  106 our layout + 77 bytes; 107 77 timestamps; 108 flags 0.',
        '  109-113 our zipQt at level 6 / level 1 / stored / version 20 / flags 0.',
        '',
        'PFC content in real ZIP headers (120-124): 120 control, 121 our part,',
        '  122 + our adobe, 123 our full content, 124 + our Technology.',
        '',
      ].join('\n'),
    )
  }, 120_000)
})
