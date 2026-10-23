import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, it } from 'vitest'
import { crc32 } from './ncex'
import { type RawZipEntry, readZipRaw, writeZipRaw } from './probeZip'

/**
 * Content permutation matrix: the same minor edits repeated on PFC, UB and hollow sections.
 * Each output starts from a real NCEP; only the edited entry is recompressed (zlib 6), so the
 * ZIP/container is the known-good real one.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-400-531 \
 *     pnpm exec vitest run src/lib/wisecam/probes.matrix.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES
const REAL_DIR = join(homedir(), 'Downloads/NCEP samples 2 Hidden Grove')

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string
type Paths = { root: string; part: string; adobe: string }

const SECTIONS = [
  { mark: 'M-1', family: 'PFC380', donor: 'M-8' },
  { mark: 'M-8', family: 'PFC300', donor: 'M-1' },
  { mark: 'M-3', family: 'UB310', donor: 'M-4' },
  { mark: 'M-4', family: 'UB410', donor: 'M-3' },
  { mark: 'M-26', family: 'SHS89', donor: 'M-31' },
  { mark: 'M-31', family: 'SHS100', donor: 'M-26' },
  { mark: 'M-42', family: 'RHS100x50', donor: 'M-26' },
] as const

function svgName(files: Files, kind: 'Adobe' | 'Part'): string {
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const tag = root.match(new RegExp(`<${kind}\\b[^>]*/>`))?.[0] ?? ''
  return /svgname="([^"]+)"/.exec(tag)?.[1] ?? ''
}

function base(mark: string): { entries: RawZipEntry[]; files: Files } {
  const bytes = new Uint8Array(readFileSync(join(REAL_DIR, `${mark}.ncep`)))
  return { entries: readZipRaw(bytes), files: unzipSync(bytes) as Files }
}

function paths(files: Files): Paths {
  return {
    root: 'CAD/CadRoot.xml',
    part: `CAD/${svgName(files, 'Part')}`,
    adobe: `CAD/${svgName(files, 'Adobe')}`,
  }
}

function write(mark: string, name: string, edits: Record<string, Edit>): void {
  const { entries, files } = base(mark)
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

function replaceAll(find: string, value: string): Edit {
  return (text) => text.split(find).join(value)
}

const firstCircle = /<circle\b[^>]*\/>/

function shiftInnerCadY(params: string, dy: number): string {
  return params.replace(/InnerCad=([^;"]+)/, (_whole, cad: string) => {
    const shifted = cad.replace(
      /([MNL])(-?[\d.]+(?:e[+-]?\d+)?),(-?[\d.]+(?:e[+-]?\d+)?)/gi,
      (_m, cmd: string, x: string, y: string) => `${cmd}${x},${Number(y) + dy}`,
    )
    return `InnerCad=${shifted}`
  })
}

function shiftCircle(circle: string, dy: number): string {
  const cy = Number(/ cy="([^"]+)"/.exec(circle)?.[1] ?? 0) + dy
  return circle
    .replace(/ cy="[^"]+"/, ` cy="${cy}"`)
    .replace(
      /wh:params="([^"]*)"/,
      (_m, params: string) => `wh:params="${shiftInnerCadY(params, dy)}"`,
    )
}

function duplicateCircle(circle: string, id: number, dy: number): string {
  return shiftCircle(circle.replace(/wh:id="\d+"/, `wh:id="${id}"`), dy)
}

function removeBalanced(text: string, key: string): string {
  let out = text
  for (;;) {
    const start = out.indexOf(`${key}={`)
    if (start < 0) return out
    let depth = 0
    let end = start + key.length + 1
    for (; end < out.length; end++) {
      if (out[end] === '{') depth++
      else if (out[end] === '}') {
        depth--
        if (depth === 0) {
          end++
          break
        }
      }
    }
    out = out.slice(0, start) + out.slice(end)
  }
}

function sectionGroup(svg: string, adobe: boolean): string {
  const groups = svg.match(/<g\b[^>]*wh:class="cadgroup"[^>]*>[\s\S]*?<\/g>/g) ?? []
  return (adobe ? groups.find((g) => g.includes('ANGLE_DISTINGUISH')) : groups[0]) ?? ''
}

function renumber(svg: string, start = 19200000): string {
  let id = start
  return svg.replace(/wh:id="\d+"/g, () => `wh:id="${id++}"`)
}

function swapSection(
  baseFiles: Files,
  donorFiles: Files,
): { part: Edit; adobe: Edit; thickness: string; leg: string } {
  const basePart = sectionGroup(strFromU8(baseFiles[paths(baseFiles).part] as Uint8Array), false)
  const baseAdobe = sectionGroup(strFromU8(baseFiles[paths(baseFiles).adobe] as Uint8Array), true)
  const donorPart = renumber(
    sectionGroup(strFromU8(donorFiles[paths(donorFiles).part] as Uint8Array), false),
  )
  const donorAdobe = renumber(
    sectionGroup(strFromU8(donorFiles[paths(donorFiles).adobe] as Uint8Array), true),
  )
  const donorRoot = strFromU8(donorFiles['CAD/CadRoot.xml'] as Uint8Array)
  return {
    part: (s) => (basePart ? s.replace(basePart, donorPart) : s),
    adobe: (s) => (baseAdobe ? s.replace(baseAdobe, donorAdobe) : s),
    thickness: /Thickness=([^;]+)/.exec(donorRoot)?.[1] ?? '',
    leg: /LegThickness=([^;]+)/.exec(donorRoot)?.[1] ?? '',
  }
}

function endY(svg: string): number {
  const tag = /<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/.exec(svg)?.[0] ?? ''
  const point = /([ML])\s*(-?[\d.]+),(-?[\d.]+)/.exec(tag)
  return Number(point?.[3] ?? 0)
}

function editEndCut(svg: string, delta: number, dy: number): string {
  const y0 = endY(svg)
  return svg
    .replace(/(<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>)/, (tag) =>
      tag.replace(/([MNL])(-?[\d.]+),(-?[\d.]+)/g, (whole, cmd: string, x: string, y: string) =>
        Math.abs(Number(y) - y0) < 1e-5 ? `${cmd}${x},${Number(y) + delta}` : whole,
      ),
    )
    .replace(/<circle\b[^>]*\/>/g, (circle) => {
      if (dy === 0) return circle
      const cy = Number(/ cy="([^"]+)"/.exec(circle)?.[1] ?? 0)
      return cy > y0 - 100 ? shiftCircle(circle, dy) : circle
    })
}

function addHole(circle: string): string {
  return circle + '\n  ' + duplicateCircle(circle, 19200001, 100)
}

const TESTS = [
  { key: 'control', edit: () => ({}) },
  {
    key: 'name-X',
    edit: (mark: string, p: Paths): Record<string, Edit> => {
      const rename = (s: string): string =>
        s
          .split(`Name=${mark}`)
          .join(`Name=X-${mark}`)
          .split(`Part=${mark}`)
          .join(`Part=X-${mark}`)
          .split(`LabelContent=${mark}`)
          .join(`LabelContent=X-${mark}`)
          .split(`>${mark}</text>`)
          .join(`>X-${mark}</text>`)
      return { [p.root]: rename, [p.part]: rename, [p.adobe]: rename }
    },
  },
  {
    key: 'quantity-2',
    edit: (_m: string, p: Paths) => ({ [p.root]: replaceAll('TotalCount=1', 'TotalCount=2') }),
  },
  {
    key: 'invert-1',
    edit: (_m: string, p: Paths) => ({ [p.root]: replaceAll('Invert=0', 'Invert=1') }),
  },
  {
    key: 'rotate-90',
    edit: (_m: string, p: Paths) => ({ [p.root]: replaceAll('RotateAngle=0', 'RotateAngle=90') }),
  },
  {
    key: 'end-cut-20',
    edit: (_m: string, p: Paths) => ({ [p.part]: (s: string) => editEndCut(s, -20, 0) }),
  },
  {
    key: 'longer-200',
    edit: (_m: string, p: Paths) => ({ [p.part]: (s: string) => editEndCut(s, 200, 200) }),
  },
  {
    key: 'section-swap',
    edit: (_m: string, p: Paths, files: Files, donor: Files): Record<string, Edit> => {
      const swap = swapSection(files, donor)
      return {
        [p.part]: swap.part,
        [p.adobe]: swap.adobe,
        [p.root]: (s: string) =>
          s
            .replace(/Thickness=[^;]+/g, `Thickness=${swap.thickness}`)
            .replace(/LegThickness=[^;]+/g, `LegThickness=${swap.leg}`),
      }
    },
  },
  {
    key: 'lead-angle-45',
    edit: (_m: string, p: Paths) => ({
      [p.part]: (s: string) => s.replace(/\bAngle=[-0-9.]+/g, 'Angle=0.7853981633974483'),
      [p.adobe]: (s: string) => s.replace(/\bAngle=[-0-9.]+/g, 'Angle=0.7853981633974483'),
    }),
  },
  {
    key: 'remove-lead',
    edit: (_m: string, p: Paths) => ({
      [p.part]: (s: string) => removeBalanced(removeBalanced(s, 'LeadIn'), 'LeadOut'),
      [p.adobe]: (s: string) => removeBalanced(removeBalanced(s, 'LeadIn'), 'LeadOut'),
    }),
  },
  {
    key: 'text-X',
    needs: 'text',
    edit: (mark: string, p: Paths): Record<string, Edit> => ({
      [p.part]: (s: string) =>
        s
          .split(`LabelContent=${mark}`)
          .join(`LabelContent=X-${mark}`)
          .split(`>${mark}</text>`)
          .join(`>X-${mark}</text>`),
    }),
  },
  {
    key: 'remove-hole',
    needs: 'holes',
    edit: (_m: string, p: Paths) => ({ [p.part]: (s: string) => s.replace(firstCircle, '') }),
  },
  {
    key: 'add-hole',
    needs: 'holes',
    edit: (_m: string, p: Paths) => ({
      [p.part]: (s: string) => {
        const circle = firstCircle.exec(s)?.[0]
        return circle ? s.replace(circle, () => addHole(circle)) : s
      },
    }),
  },
] as const

describe.skipIf(!outDir)('write section permutation matrix', () => {
  it('writes 400-531', () => {
    mkdirSync(outDir as string, { recursive: true })
    const lines = ['Section permutation matrix: real ZIP, one content edit per probe.', '']
    SECTIONS.forEach((section, si) => {
      const { files } = base(section.mark)
      const p = paths(files)
      const part = strFromU8(files[p.part] as Uint8Array)
      const hasText = /<text\b/.test(part)
      const hasHoles = firstCircle.test(part)
      const donor = base(section.donor).files
      lines.push(`## ${section.mark} ${section.family} (donor ${section.donor})`)
      TESTS.forEach((test, ti) => {
        const need = 'needs' in test ? test.needs : undefined
        if (need === 'text' && !hasText) return
        if (need === 'holes' && !hasHoles) return
        const number = 400 + si * 20 + ti
        const name = `${number}-${section.mark}-${test.key}.ncep`
        const edits = test.key === 'control' ? {} : test.edit(section.mark, p, files, donor)
        write(section.mark, name, edits)
        lines.push(`- ${number} ${test.key}`)
      })
      lines.push('')
    })
    writeFileSync(join(outDir as string, 'README.txt'), lines.join('\n'))
  }, 120_000)
})
