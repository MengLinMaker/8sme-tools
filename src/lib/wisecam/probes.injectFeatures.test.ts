import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { fixture } from '@test/fixtures'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, it } from 'vitest'
import { buildNcepFromNc } from './fromNc'
import { crc32 } from './ncex'
import { type RawZipEntry, readZipRaw, writeZipRaw } from './probeZip'

/**
 * Control-first injection, stages 2-4: keep a real populated control package and replace one
 * feature category at a time — own NC holes, own NC end cut, then a donor bevel/notch.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-inject-620-627 \
 *     pnpm exec vitest run src/lib/wisecam/probes.injectFeatures.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

const HOLES = [
  { code: 620, mark: 'M-1', family: 'PFC380' },
  { code: 621, mark: 'M-3', family: 'UB310' },
  { code: 622, mark: 'M-35', family: 'SHS89' },
] as const

const END_CUTS = [
  { code: 623, mark: 'M-1', family: 'PFC380' },
  { code: 624, mark: 'M-35', family: 'SHS89' },
] as const

const BEVELS = [
  { code: 625, base: 'M-8', donor: 'M-34', family: 'PFC300' },
  { code: 626, base: 'M-3', donor: 'M-5', family: 'UB310' },
  { code: 627, base: 'M-42', donor: 'M-43', family: 'RHS100x50' },
] as const

function svgName(files: Files, kind: 'Adobe' | 'Part'): string {
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const tag = root.match(new RegExp(`<${kind}\\b[^>]*/>`))?.[0] ?? ''
  return /svgname="([^"]+)"/.exec(tag)?.[1] ?? ''
}

function partSvg(files: Files): string {
  return strFromU8(files[`CAD/${svgName(files, 'Part')}`] as Uint8Array)
}

function base(mark: string): { raw: Uint8Array; entries: RawZipEntry[]; files: Files } {
  const raw = new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`)))
  return { raw, entries: readZipRaw(raw), files: unzipSync(raw) as Files }
}

function own(mark: string): Files {
  const bytes = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), { mark })
  if (!bytes) throw new Error(`cannot build own ${mark}`)
  return unzipSync(bytes) as Files
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

function trim(svg: string, type: number): string {
  return svg.match(new RegExp(`<path\\b[^>]*IsTrucate=1;TrucateType=${type};[^>]*/>`))?.[0] ?? ''
}

function circles(svg: string): string {
  return svg.match(/(?:<circle\b[^>]*\/>\s*)+/)?.[0] ?? ''
}

function renumber(text: string, start = 19_300_000): string {
  let id = start
  return text.replace(/wh:id="\d+"/g, () => `wh:id="${id++}"`)
}

function assertPartStructure(svg: string, name: string): void {
  const part = svg.match(/<g\b[^>]*wh:class="cadpart"[^>]*>[\s\S]*?<\/g>/)?.[0] ?? ''
  const section = svg.match(/<g\b[^>]*wh:class="cadgroup"[^>]*>[\s\S]*?<\/g>/)?.[0] ?? ''
  if (!part || !section) throw new Error(`${name}: missing cadpart/cadgroup`)
  for (const type of [0, 1]) {
    if (!new RegExp(`TrucateType=${type};`).test(part)) {
      throw new Error(`${name}: missing TrucateType=${type}`)
    }
  }
  const sectionPaths = (section.match(/<path\b/g) ?? []).length
  if (sectionPaths < 1 || sectionPaths > 2) {
    throw new Error(`${name}: section needs 1-2 paths, got ${sectionPaths}`)
  }
}

function write(
  entries: RawZipEntry[],
  files: Files,
  name: string,
  from: string,
  to: string,
  editPart: Edit,
): void {
  const part = `CAD/${svgName(files, 'Part')}`
  const adobe = `CAD/${svgName(files, 'Adobe')}`
  const edits: Record<string, Edit> = {
    'CAD/CadRoot.xml': (text) => rename(text, from, to),
    [part]: (text) => {
      const next = editPart(rename(text, from, to))
      assertPartStructure(next, to)
      return next
    },
    [adobe]: (text) => rename(text, from, to),
  }
  const out = entries.map((entry) => {
    const change = edits[entry.name]
    if (!change) return entry
    const data = strToU8(change(strFromU8(files[entry.name] as Uint8Array)))
    const compressed = new Uint8Array(deflateRawSync(data))
    return {
      ...entry,
      compressed,
      compressedSize: compressed.length,
      uncompressedSize: data.length,
      crc: crc32(data),
    }
  })
  writeFileSync(join(outDir as string, name), writeZipRaw(out))
}

function injectHoles(svg: string, holes: string): string {
  const marked = svg.replace(/(?:<circle\b[^>]*\/>\s*)+/, '@@OWN_HOLES@@')
  return marked.replace(/<circle\b[^>]*\/>\s*/g, '').replace('@@OWN_HOLES@@', () => holes)
}

function injectEndCut(svg: string, endCut: string): string {
  return svg.replace(/<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/, () => endCut)
}

function injectBevel(svg: string, startCut: string): string {
  return svg.replace(/<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/, () => startCut)
}

describe.skipIf(!outDir)('write control-first feature probes', () => {
  it('writes 620-627', () => {
    mkdirSync(outDir as string, { recursive: true })
    const lines = [
      'Control-first injection, stages 2-4.',
      'Real package and real start/end trims stay in place; one feature category changes per file.',
      '',
      '## Own NC holes on the real control',
    ]
    for (const section of HOLES) {
      const { entries, files } = base(section.mark)
      const ownFiles = own(section.mark)
      const ownHoles = circles(partSvg(ownFiles))
      if (!ownHoles) throw new Error(`${section.mark}: own part has no holes`)
      const to = `${section.mark}-${section.code}`
      write(
        entries,
        files,
        `${section.code}-${section.mark}-own-holes.ncep`,
        section.mark,
        to,
        (svg) => injectHoles(svg, renumber(ownHoles)),
      )
      lines.push(`- ${section.code} ${section.mark} ${section.family}: real control + own NC holes`)
    }

    lines.push('', '## Own NC end cut on the real control')
    for (const section of END_CUTS) {
      const { entries, files } = base(section.mark)
      const ownFiles = own(section.mark)
      const ownEnd = trim(partSvg(ownFiles), 1)
      if (!ownEnd) throw new Error(`${section.mark}: own part has no end cut`)
      const to = `${section.mark}-${section.code}`
      write(
        entries,
        files,
        `${section.code}-${section.mark}-own-end-cut.ncep`,
        section.mark,
        to,
        (svg) => injectEndCut(svg, renumber(rename(ownEnd, section.mark, to))),
      )
      lines.push(
        `- ${section.code} ${section.mark} ${section.family}: real control + own NC end trim`,
      )
    }

    lines.push('', '## Donor bevel/notch on a real same-section control')
    for (const section of BEVELS) {
      const { entries, files } = base(section.base)
      const donor = partSvg(base(section.donor).files)
      const startCut = trim(donor, 0)
      if (!startCut) throw new Error(`${section.donor}: donor has no start cut`)
      const to = `${section.base}-${section.code}`
      write(
        entries,
        files,
        `${section.code}-${section.base}-bevel-${section.donor}.ncep`,
        section.base,
        to,
        (svg) => injectBevel(svg, renumber(rename(startCut, section.donor, to))),
      )
      lines.push(
        `- ${section.code} ${section.family}: real ${section.base} + ${section.donor} start cut`,
      )
    }

    lines.push(
      '',
      'Test one category at a time: holes, then own end cut, then bevel. Stop at the first failure.',
      'Every base keeps its real holes, text and section; only the named feature category changes.',
      '',
    )
    writeFileSync(join(outDir as string, 'README.txt'), lines.join('\n'))
  }, 120_000)
})
