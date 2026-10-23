import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '@test/fixtures'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, it } from 'vitest'
import { partSectionForCode } from '@/lib/sections/stock'
import { buildNcepFromNc } from './fromNc'
import { buildNcex, type NcexPart } from './ncex'

/**
 * Writes a probe set of `.ncex` / `.ncexa` files for a WiseCAM import session.
 * Only runs when `WRITE_NCEX_PROBES=<dir>` is set:
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncex-probes pnpm exec vitest run src/lib/wisecam/probes.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES

type Files = Record<string, Uint8Array>

function rezip(files: Files): Uint8Array {
  const ordered: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    mimetype: [files.mimetype as Uint8Array, { level: 0 }],
  }
  for (const [path, data] of Object.entries(files)) {
    if (path === 'mimetype') continue
    ordered[path] = [data, { level: 6 }]
  }
  return zipSync(ordered)
}

function rewriteManifest(files: Files): void {
  const paths = Object.keys(files)
    .filter((path) => path !== 'mimetype' && path !== 'ncex.opf')
    .sort()
  const items = paths.map((path) => `        <item href="${path}" />`).join('\n')
  const metadata = strFromU8(files['CAD/cad.opf'] as Uint8Array).match(
    /<metadata[\s\S]*?<\/metadata>/,
  )?.[0]
  files['ncex.opf'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" ?>\n<package>\n${metadata ?? ''}\n    <manifest>\n${items}\n    </manifest>\n</package>\n`,
  )
}

function rewriteContainer(files: Files): void {
  const roots = ['CAD/cad.opf', 'CNC/cnc.opf', 'ncex.opf'].filter((path) => files[path])
  const lines = roots
    .map((path) => `    <rootfile full-path="${path}" media-type="application/ncex-package+xml"/>`)
    .join('\n')
  files['META-INF/container.xml'] = strToU8(
    `<?xml version="1.0"?>\n<container version="1.0" xmlns="http://www.weihong.com.cn/phoenix/ncex">\n  <rootfiles>\n${lines}\n  </rootfiles>\n</container>\n`,
  )
}

function withoutCnc(files: Files): Files {
  const out: Files = {}
  for (const [path, data] of Object.entries(files)) {
    if (path.startsWith('CNC/')) continue
    out[path] = data
  }
  rewriteContainer(out)
  rewriteManifest(out)
  return out
}

function withoutFiles(files: Files, predicate: (path: string) => boolean): Files {
  const out: Files = {}
  for (const [path, data] of Object.entries(files)) {
    if (predicate(path)) continue
    out[path] = data
  }
  rewriteManifest(out)
  return out
}

function onePart(files: Files): Files {
  const cad = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const adobe = cad.match(/<Adobe [^>]*\/>/)?.[0]
  const part = cad.match(/<Part [^>]*\/>/)?.[0]
  if (!adobe || !part) return files
  const adobeSvg = /svgname="([^"]+)"/.exec(adobe)?.[1]
  const partSvg = /svgname="([^"]+)"/.exec(part)?.[1]
  const out: Files = {}
  for (const [path, data] of Object.entries(files)) {
    if (path.startsWith('CAD/adobe') && !path.endsWith(adobeSvg ?? '')) continue
    if (path.startsWith('CAD/part') && !path.endsWith(partSvg ?? '')) continue
    out[path] = data
  }
  out['CAD/CadRoot.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>\n<cadroot version="1.0" xmlns="http://www.weihong.com.cn/cadcam">\n <Adobes>\n  ${adobe}\n </Adobes>\n <Parts>\n  ${part}\n </Parts>\n <BaseZone idref="52" count="0" adobeid="94"/>\n</cadroot>\n`,
  )
  rewriteManifest(out)
  return out
}

function generatedPart(
  profile: string,
  dims: number[],
  family: 'RHS' | 'PFC' | 'I',
  holes: NcexPart['holes'],
  extra: Partial<NcexPart> = {},
): NcexPart {
  const section = partSectionForCode(profile, dims)
  if (!section) throw new Error(`no section for ${profile}`)
  const typeCode = family === 'RHS' ? 8195 : family === 'PFC' ? 8199 : 8200
  return {
    mark: `PROBE-${family}`,
    profile,
    profileType: family === 'RHS' ? 'M' : family === 'PFC' ? 'U' : 'I',
    typeCode,
    length: 600,
    quantity: 2,
    thickness: dims[3] ?? 6,
    legThickness: dims[2] ?? 9,
    section: section.points,
    innerSection: section.holes?.[0],
    holes,
    ...extra,
  }
}

function write(name: string, bytes: Uint8Array): void {
  writeFileSync(join(outDir as string, name), bytes)
}

function unzip(path: string): Files {
  return unzipSync(new Uint8Array(readFileSync(path))) as Files
}

function cadEntry(files: Files, kind: 'Adobe' | 'Part'): { idref: string; svgname: string } {
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const tag = root.match(new RegExp(`<${kind}\\b[^>]*/>`))?.[0] ?? ''
  const idref = /idref="([^"]+)"/.exec(tag)?.[1] ?? ''
  const svgname = /svgname="([^"]+)"/.exec(tag)?.[1] ?? ''
  return { idref, svgname }
}

/** Rebuild `ncex.opf` in WiseCAM's order (CAD first, then any CNC entries). */
function rebuildManifest(files: Files): void {
  const cad = ['CAD/CadRoot.xml', 'CAD/cad.opf', 'CAD/Technology.xml', 'CAD/CustomizeData.xml']
  const adobe = Object.keys(files)
    .filter((path) => /^CAD\/adobe.*\.svg$/.test(path))
    .sort()
  const parts = Object.keys(files)
    .filter((path) => /^CAD\/part.*\.svg$/.test(path))
    .sort()
  const cnc = Object.keys(files)
    .filter((path) => path.startsWith('CNC/'))
    .sort()
  const items = [...cad, ...adobe, ...parts, ...cnc]
    .filter((path) => files[path])
    .map((path) => `        <item href="${path}" />`)
    .join('\n')
  const metadata = strFromU8(files['CAD/cad.opf'] as Uint8Array).match(
    /<metadata[\s\S]*?<\/metadata>/,
  )?.[0]
  files['ncex.opf'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" ?>\n<package>\n${metadata ?? ''}\n    <manifest>\n${items}\n    </manifest>\n</package>\n`,
  )
}

function withCadFiles(files: Files, replacements: Record<string, Uint8Array>, drop: string[] = []) {
  const out: Files = { ...files }
  for (const path of drop) delete out[path]
  for (const [path, data] of Object.entries(replacements)) out[path] = data
  rebuildManifest(out)
  return out
}

const stripInnerCad = (svg: string): string => svg.replace(/InnerCad=[^;"]*;/g, '')
const stripTechnical = (svg: string): string => svg.replace(/ wh:technical="[^"]*"/g, '')
const stripTextTransform = (svg: string): string => svg.replace(/ transform="rotate\([^"]*\)"/g, '')

/** Old writer layout: everything (cuts, holes, mark, section) inside one `cadgroup`. */
function legacyStructure(svg: string): string {
  const cad = svg.match(/(<g\b[^>]*wh:class="cadpart"[^>]*>)([\s\S]*?)(<\/g>\s*<\/svg>)/)
  if (!cad) return svg
  const body = cad[2] as string
  const group = body.match(/(<g\b[^>]*wh:class="cadgroup"[^>]*>)([\s\S]*?)(<\/g>)/)
  if (!group) return svg
  const inner = body.replace(group[0], '')
  const wrapped = `<g wh:id="999001" wh:class="cadgroup" wh:layer="0" wh:isfill="0" wh:machining="1" class="layer0">\n${inner}${group[2]}</g>`
  return svg.replace(body, wrapped)
}

/** WiseCAM's own adobe has an applied-cut-path (`USERPATH`) group; ours does not. */
function adobeWithoutUserPath(svg: string): string {
  return svg.replace(/<g\b[^>]*USERPATH=USERPATH;[^>]*>[\s\S]*?<\/g>/g, '')
}

/** Swap one class of element from our part SVG for WiseCAM's real one (same M-1 part). */
function swapHoles(ours: string, real: string): string {
  const block = real.match(/(?:<circle\b[^>]*\/>\s*)+/)?.[0]
  const own = ours.match(/(?:<circle\b[^>]*\/>\s*)+/)?.[0]
  return block && own ? ours.replace(own, block) : ours
}

function swapSection(ours: string, real: string): string {
  const groupRe = /<g\b[^>]*wh:class="cadgroup"[^>]*>[\s\S]*?<\/g>/
  const block = real.match(groupRe)?.[0]
  return block ? ours.replace(groupRe, block) : ours
}

function swapText(ours: string, real: string): string {
  const textRe = /<text\b[\s\S]*?<\/text>/
  const block = real.match(textRe)?.[0]
  return block ? ours.replace(textRe, block) : ours
}

function swapTruncates(ours: string, real: string): string {
  let out = ours
  for (const type of [0, 1]) {
    const re = new RegExp(`<path\\b[^>]*IsTrucate=1;TrucateType=${type};[^>]*/>`)
    const block = real.match(re)?.[0]
    if (block) out = out.replace(re, block)
  }
  return out
}

function swapAll(ours: string, real: string): string {
  return swapTruncates(swapText(swapSection(swapHoles(ours, real), real), real), real)
}

describe.skipIf(!outDir)('write NCEX probes', () => {
  it('writes the probe set', () => {
    mkdirSync(outDir as string, { recursive: true })
    const downloadsSample = join(
      homedir(),
      'Downloads',
      'Base 2 Hidden Grove',
      'Base 2 Hidden Grove.ncexa',
    )
    const samplePath = existsSync(downloadsSample) ? downloadsSample : fixture('ncep', 'M-1.ncep')
    const real = unzipSync(new Uint8Array(readFileSync(samplePath)))

    // Baselines derived from WiseCAM's own CAD-only export.
    write('01-real-renamed.ncex', rezip(real))
    write('02-real-no-cnc.ncex', rezip(withoutCnc(real)))
    write(
      '03-real-no-cnc-no-tech.ncex',
      rezip(withoutCnc(withoutFiles(real, (p) => p.startsWith('CAD/Technology')))),
    )
    write('04-real-one-part.ncex', rezip(onePart(real)))
    write('05-real-one-part-no-cnc.ncex', rezip(onePart(withoutCnc(real))))
    const withFrame = { ...real }
    withFrame['CNC/Base_Frame.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" ?>\n<root/>\n')
    write('06-real-add-base-frame.ncex', rezip(withFrame))

    // Our writer.
    const rhs = generatedPart('RHS200*100*9.0', [200, 100, 9, 9, 22.5], 'RHS', [], {
      unrolledPerimeter: 561.3717,
    })
    const rhsHole = generatedPart(
      'RHS200*100*9.0',
      [200, 100, 9, 9, 22.5],
      'RHS',
      [{ station: 0, along: 300, radius: 5 }],
      { unrolledPerimeter: 561.3717 },
    )
    const pfc = generatedPart(
      'PFC380*100',
      [380, 100, 17.5, 10, 14],
      'PFC',
      [
        { station: -240, along: 200, radius: 7 },
        { station: -75, along: 300, radius: 7 },
        { station: 75, along: 400, radius: 7 },
        { station: 240, along: 500, radius: 7 },
      ],
      { unrolledPerimeter: 580 },
    )
    const ub = generatedPart(
      'UB310*32',
      [298, 149, 8, 5.5, 13],
      'I',
      [
        { station: -50, along: 200, radius: 7 },
        { station: 50, along: 300, radius: 7 },
        { station: -336.92, along: 400, radius: 7 },
        { station: -236.92, along: 500, radius: 7 },
      ],
      { unrolledPerimeter: 728.3407 },
    )

    // Default flavour is NCEP-style (CAD-only, no CNC/) — the importable package.
    // Exact M-1 reproduction, for a direct diff against the real M-1.ncep.
    const m1 = generatedPart(
      'PFC380*100',
      [380, 100, 17.5, 10, 14],
      'PFC',
      [
        ...[284.2, 1184.2, 2084.2, 2984.2, 3884.2, 4784.2].map((along) => ({
          station: 240,
          along,
          radius: 7,
        })),
        ...[135, 235].map((along) => ({ station: -240, along, radius: 11 })),
        ...[284.2, 1184.2, 2084.2, 2984.2, 3884.2, 4784.2].flatMap((along) => [
          { station: -75, along, radius: 7 },
          { station: 75, along, radius: 7 },
        ]),
        ...[85, 155, 225, 295].map((y) => ({ station: -190 + y, along: 5049.2, radius: 11 })),
      ],
      { unrolledPerimeter: 580, length: 5084.2, mark: 'M-1', quantity: 1 },
    )

    write('10-gen-rhs-empty.ncex', buildNcex([rhs]))
    write('11-gen-rhs-hole.ncex', buildNcex([rhsHole]))
    write('12-gen-pfc.ncex', buildNcex([pfc]))
    write('13-gen-ub.ncex', buildNcex([ub]))
    write('13b-gen-pfc.ncep', buildNcex([pfc]))
    write('12b-gen-m1-exact.ncep', buildNcex([m1]))
    // Machining flavour adds the CNC/ scaffold (for .ncexa).
    write('14-gen-rhs-empty.ncexa', buildNcex([rhs], { flavour: 'machining' }))
    write('15-gen-pfc-rot90.ncex', buildNcex([{ ...pfc, rotateAngle: 90 }]))
    write('16-gen-pfc-invert.ncex', buildNcex([{ ...pfc, invert: true }]))

    // Real NC1-derived NCEP packages: ground-truth geometry, our writer.
    for (const mark of ['M-1', 'M-3', 'M-35', 'M-42']) {
      const nc = readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8')
      const bytes = buildNcepFromNc(nc, { mark })
      if (bytes) write(`20-ncep-${mark}.ncep`, bytes)
    }

    // Our writer + WiseCAM's Technology.xml (the one file we don't emit).
    const withTech = unzipSync(buildNcex([pfc]))
    withTech['CAD/Technology.xml'] = new Uint8Array(real['CAD/Technology.xml'] as Uint8Array)
    write('17-gen-pfc-with-tech.ncex', rezip(withTech))

    // ---------------------------------------------------------------------------------------
    // Differential NCEP probes: start from WiseCAM's real M-1 and swap in ONE of our files, or
    // degrade the real part one attribute at a time. Run these in order; the first failure names
    // the component/attribute the importer needs.
    // ---------------------------------------------------------------------------------------
    const realM1 = unzip(fixture('ncep', 'M-1.ncep'))
    const realCad = strFromU8(realM1['CAD/CadRoot.xml'] as Uint8Array)
    const realPartEntry = cadEntry(realM1, 'Part')
    const realAdobeEntry = cadEntry(realM1, 'Adobe')
    const realPartSvg = strFromU8(realM1[`CAD/${realPartEntry.svgname}`] as Uint8Array)
    const realAdobeSvg = strFromU8(realM1[`CAD/${realAdobeEntry.svgname}`] as Uint8Array)

    const ncM1 = readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8')
    const ourM1 = unzipSync(buildNcepFromNc(ncM1, { mark: 'M-1' }) as Uint8Array) as Files
    const ourPartEntry = cadEntry(ourM1, 'Part')
    const ourAdobeEntry = cadEntry(ourM1, 'Adobe')
    const ourPartSvg = strFromU8(ourM1[`CAD/${ourPartEntry.svgname}`] as Uint8Array)
    const ourAdobeSvg = strFromU8(ourM1[`CAD/${ourAdobeEntry.svgname}`] as Uint8Array)

    // Point our part at the real Part id so only its grammar/geometry differs.
    const ourPartForReal = strToU8(
      ourPartSvg.replace(`wh:refid="${ourPartEntry.idref}"`, `wh:refid="${realPartEntry.idref}"`),
    )
    const realPartPath = `CAD/${realPartEntry.svgname}`
    const realAdobePath = `CAD/${realAdobeEntry.svgname}`

    // 30 = byte-for-byte control, 30b = same contents re-zipped by our writer.
    write('30-real-M1.ncep', new Uint8Array(readFileSync(fixture('ncep', 'M-1.ncep'))))
    write('30b-real-M1-rezipped.ncep', rezip(realM1))

    // Package docs: bad/invalid technologyID must not matter (both were verified as working).
    const badGuid: Files = { ...realM1 }
    badGuid['CAD/CadRoot.xml'] = strToU8(
      (realCad as string).replace(/technologyID="[^"]*"/, 'technologyID="not-a-guid"'),
    )
    write('31-real-M1-badguid.ncep', rezip(badGuid))
    const randomGuid: Files = { ...realM1 }
    randomGuid['CAD/CadRoot.xml'] = strToU8(
      (realCad as string).replace(
        /technologyID="[^"]*"/,
        'technologyID="11111111-2222-3333-4444-555555555555"',
      ),
    )
    write('32-real-M1-randomguid.ncep', rezip(randomGuid))

    // Real package, our part / our adobe / both.
    write(
      '33b-real-M1-ourpart-fixed.ncep',
      rezip(withCadFiles(realM1, { [realPartPath]: ourPartForReal })),
    )
    write(
      '34-real-M1-our-adobe.ncep',
      rezip(withCadFiles(realM1, { [realAdobePath]: strToU8(ourAdobeSvg) })),
    )
    write(
      '35-real-M1-our-part-and-adobe.ncep',
      rezip(
        withCadFiles(realM1, {
          [realPartPath]: ourPartForReal,
          [realAdobePath]: strToU8(ourAdobeSvg),
        }),
      ),
    )
    // Our whole CAD payload (CadRoot + SVGs) inside WiseCAM's real package documents.
    write(
      '36-real-docs-our-cad.ncep',
      rezip(
        withCadFiles(
          realM1,
          {
            'CAD/CadRoot.xml': ourM1['CAD/CadRoot.xml'] as Uint8Array,
            'CAD/part1000.svg': strToU8(ourPartSvg),
            'CAD/adobe500.svg': strToU8(ourAdobeSvg),
          },
          [realPartPath, realAdobePath],
        ),
      ),
    )

    // If 33b still fails, these degrade the fixed part one feature at a time.
    write(
      '37-real-M1-ourpart-no-innercad.ncep',
      rezip(withCadFiles(realM1, { [realPartPath]: strToU8(stripInnerCad(ourPartSvg)) })),
    )
    write(
      '38-real-M1-ourpart-no-technical.ncep',
      rezip(withCadFiles(realM1, { [realPartPath]: strToU8(stripTechnical(ourPartSvg)) })),
    )
    write(
      '39-real-M1-ourpart-no-text-transform.ncep',
      rezip(withCadFiles(realM1, { [realPartPath]: strToU8(stripTextTransform(ourPartSvg)) })),
    )
    write(
      '40-real-M1-ourpart-old-structure.ncep',
      rezip(withCadFiles(realM1, { [realPartPath]: strToU8(legacyStructure(ourPartSvg)) })),
    )
    write(
      '41-real-M1-adobe-no-userpath.ncep',
      rezip(withCadFiles(realM1, { [realAdobePath]: strToU8(adobeWithoutUserPath(realAdobeSvg)) })),
    )

    // If 33b still fails: keep our part but swap one element class at a time for WiseCAM's real
    // one (same M-1 geometry). The first file that works names the offending element.
    write(
      '42-real-M1-ourpart-real-holes.ncep',
      rezip(withCadFiles(realM1, { [realPartPath]: strToU8(swapHoles(ourPartSvg, realPartSvg)) })),
    )
    write(
      '43-real-M1-ourpart-real-section.ncep',
      rezip(
        withCadFiles(realM1, { [realPartPath]: strToU8(swapSection(ourPartSvg, realPartSvg)) }),
      ),
    )
    write(
      '44-real-M1-ourpart-real-text.ncep',
      rezip(withCadFiles(realM1, { [realPartPath]: strToU8(swapText(ourPartSvg, realPartSvg)) })),
    )
    write(
      '45-real-M1-ourpart-real-truncates.ncep',
      rezip(
        withCadFiles(realM1, { [realPartPath]: strToU8(swapTruncates(ourPartSvg, realPartSvg)) }),
      ),
    )
    write(
      '46-real-M1-ourpart-real-elements.ncep',
      rezip(withCadFiles(realM1, { [realPartPath]: strToU8(swapAll(ourPartSvg, realPartSvg)) })),
    )
  }, 120_000)
})
