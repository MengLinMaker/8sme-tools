import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { fixture } from '@test/fixtures'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, it } from 'vitest'
import { crc32 } from './ncex'
import { type RawZipEntry, readZipRaw, writeZipRaw } from './probeZip'

/**
 * Control-first injection, step 1: strip optional features from a real package instead of
 * building a package from scratch. The start/end trim paths are structural: every real part has
 * them, and removing them leaves an empty `cadpart` that WiseCAM rejects.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-inject-600-608 \
 *     pnpm exec vitest run src/lib/wisecam/probes.inject.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

const SECTIONS = [
  { code: 600, mark: 'M-1', family: 'PFC380' },
  { code: 603, mark: 'M-3', family: 'UB310' },
  { code: 606, mark: 'M-35', family: 'SHS89' },
] as const

function svgName(files: Files, kind: 'Adobe' | 'Part'): string {
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const tag = root.match(new RegExp(`<${kind}\\b[^>]*/>`))?.[0] ?? ''
  return /svgname="([^"]+)"/.exec(tag)?.[1] ?? ''
}

function base(mark: string): { raw: Uint8Array; entries: RawZipEntry[]; files: Files } {
  const raw = new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`)))
  return { raw, entries: readZipRaw(raw), files: unzipSync(raw) as Files }
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

function removeHoles(svg: string): string {
  return svg.replace(/<circle\b[^>]*\/>/g, '')
}

function blank(svg: string): string {
  return removeHoles(svg).replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, '')
}

/**
 * Real part structure from all 17 controls:
 *   style, cadpart (start trim + end trim + optional holes/text), cadgroup (1-2 section paths).
 * The section group is a sibling of cadpart, never nested inside it.
 */
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

describe.skipIf(!outDir)('write control-first injection probes', () => {
  it('writes 600-608', () => {
    mkdirSync(outDir as string, { recursive: true })
    const lines = [
      'Control-first injection, step 1: remove features from real NCEP parts.',
      'Every file starts from the real package; variants only replace the part SVG.',
      '',
    ]
    for (const section of SECTIONS) {
      const { raw, entries, files } = base(section.mark)
      writeFileSync(join(outDir as string, `${section.code}-${section.mark}-control.ncep`), raw)

      const noHoles = `${section.mark}-${section.code + 1}`
      write(
        entries,
        files,
        `${section.code + 1}-${section.mark}-no-holes.ncep`,
        section.mark,
        noHoles,
        removeHoles,
      )

      const blankName = `${section.mark}-${section.code + 2}`
      write(
        entries,
        files,
        `${section.code + 2}-${section.mark}-blank.ncep`,
        section.mark,
        blankName,
        blank,
      )

      lines.push(`## ${section.mark} ${section.family}`)
      lines.push(`- ${section.code} control — real package, unchanged`)
      lines.push(
        `- ${section.code + 1} no holes — all circles removed; trims, section and text kept`,
      )
      lines.push(`- ${section.code + 2} blank — holes and text removed; trims and section kept`)
      lines.push('')
    }
    lines.push(
      'All three should load. The start/end trim paths are not optional: without them cadpart',
      'is empty and WiseCAM rejects the part, even though the SVG is well-formed.',
      '',
    )
    writeFileSync(join(outDir as string, 'README.txt'), lines.join('\n'))
  }, 120_000)
})
