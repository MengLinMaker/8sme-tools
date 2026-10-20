import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, it } from 'vitest'
import { fixture } from '@test/fixtures'
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

describe.skipIf(!outDir)('write NCEX probes', () => {
  it('writes the probe set', () => {
    mkdirSync(outDir as string, { recursive: true })
    const samplePath = join(
      homedir(),
      'Downloads',
      'Base 2 Hidden Grove',
      'Base 2 Hidden Grove.ncexa',
    )
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
      const bytes = buildNcepFromNc(nc)
      if (bytes) write(`20-ncep-${mark}.ncep`, bytes)
    }

    // Our writer + WiseCAM's Technology.xml (the one file we don't emit).
    const withTech = unzipSync(buildNcex([pfc]))
    withTech['CAD/Technology.xml'] = new Uint8Array(real['CAD/Technology.xml'] as Uint8Array)
    write('17-gen-pfc-with-tech.ncex', rezip(withTech))
  }, 120_000)
})
