import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, it } from 'vitest'
import { crc32 } from './ncex'
import { type RawZipEntry, readZipRaw, writeZipRaw } from './probeZip'

/**
 * One minor content change at a time, on top of a byte-preserved real NCEP. Nothing is
 * re-zipped: only the edited SVG/XML entry is recompressed (zlib level 6) and its CRC/sizes
 * updated, so a failure names the content change, not the container.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-300-329 \
 *     pnpm exec vitest run src/lib/wisecam/probes.minor.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES
const REAL_DIR = join(homedir(), 'Downloads/NCEP samples 2 Hidden Grove')

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

function svgName(files: Files, kind: 'Adobe' | 'Part'): string {
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const tag = root.match(new RegExp(`<${kind}\\b[^>]*/>`))?.[0] ?? ''
  return /svgname="([^"]+)"/.exec(tag)?.[1] ?? ''
}

function base(mark: string): { bytes: Uint8Array; entries: RawZipEntry[]; files: Files } {
  const bytes = new Uint8Array(readFileSync(join(REAL_DIR, `${mark}.ncep`)))
  return { bytes, entries: readZipRaw(bytes), files: unzipSync(bytes) as Files }
}

function write(
  name: string,
  mark: string,
  edits: (paths: { part: string; adobe: string; root: string }) => Record<string, Edit>,
): void {
  const { entries, files } = base(mark)
  const root = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const paths = {
    root: 'CAD/CadRoot.xml',
    part: `CAD/${svgName(files, 'Part')}`,
    adobe: `CAD/${svgName(files, 'Adobe')}`,
  }
  const changes = edits(paths)
  const out = entries.map((entry) => {
    const change = changes[entry.name]
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
  void root
}

function replaceAll(find: string, value: string): Edit {
  return (text) => text.split(find).join(value)
}

const firstCircle = /<circle\b[^>]*\/>/

function shiftInnerCadY(params: string, dy: number): string {
  return params.replace(/InnerCad=([^;"]+)/, (_whole, cad: string) => {
    const shifted = cad.replace(
      /([MN])(-?[\d.]+(?:e[+-]?\d+)?),(-?[\d.]+(?:e[+-]?\d+)?)/gi,
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

function addText(text: string): string {
  const block = /<text\b[\s\S]*?<\/text>/.exec(text)?.[0]
  if (!block) return text
  const x = Number(/ x="([^"]+)"/.exec(block)?.[1] ?? 0) + 100
  const y = Number(/ y="([^"]+)"/.exec(block)?.[1] ?? 0) + 100
  const extra = block
    .replace(/wh:id="\d+"/, 'wh:id="19000002"')
    .replace(/ x="[^"]+"/, ` x="${x}"`)
    .replace(/ y="[^"]+"/, ` y="${y}"`)
    .replace(/transform="rotate\(90 [^)]+\)"/, `transform="rotate(90 ${x},${y})"`)
    .replace(/LabelContent=M-1/g, 'LabelContent=M-2')
    .replace(/>M-1<\/text>/, '>M-2</text>')
  return text.replace(block, () => `${block}\n ${extra}`)
}

function endCut(svg: string, to: string): string {
  return svg.replace(/(<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>)/, (path) =>
    path.replace(/5084\.2|5084\.1999999999998/g, to),
  )
}

function shiftEndHoles(svg: string, dy: number): string {
  return svg.replace(/<circle\b[^>]*\/>/g, (circle) => {
    const cy = Number(/ cy="([^"]+)"/.exec(circle)?.[1] ?? 0)
    return cy > 5000 ? shiftCircle(circle, dy) : circle
  })
}

function sectionGroup(svg: string, adobe: boolean): string {
  const groups = svg.match(/<g\b[^>]*wh:class="cadgroup"[^>]*>[\s\S]*?<\/g>/g) ?? []
  return (adobe ? groups.find((g) => g.includes('ANGLE_DISTINGUISH')) : groups[0]) ?? ''
}

function renumber(svg: string, start = 19100000): string {
  let id = start
  return svg.replace(/wh:id="\d+"/g, () => `wh:id="${id++}"`)
}

function swapSection(
  baseFiles: Files,
  donorFiles: Files,
): { part: Edit; adobe: Edit; thickness: string; leg: string } {
  const basePart = sectionGroup(
    strFromU8(baseFiles[`CAD/${svgName(baseFiles, 'Part')}`] as Uint8Array),
    false,
  )
  const baseAdobe = sectionGroup(
    strFromU8(baseFiles[`CAD/${svgName(baseFiles, 'Adobe')}`] as Uint8Array),
    true,
  )
  const donorPart = renumber(
    sectionGroup(strFromU8(donorFiles[`CAD/${svgName(donorFiles, 'Part')}`] as Uint8Array), false),
  )
  const donorAdobe = renumber(
    sectionGroup(strFromU8(donorFiles[`CAD/${svgName(donorFiles, 'Adobe')}`] as Uint8Array), true),
  )
  const donorRoot = strFromU8(donorFiles['CAD/CadRoot.xml'] as Uint8Array)
  return {
    part: (s) => (basePart ? s.replace(basePart, donorPart) : s),
    adobe: (s) => (baseAdobe ? s.replace(baseAdobe, donorAdobe) : s),
    thickness: /Thickness=([^;]+)/.exec(donorRoot)?.[1] ?? '',
    leg: /LegThickness=([^;]+)/.exec(donorRoot)?.[1] ?? '',
  }
}

describe.skipIf(!outDir)('write minor content probes', () => {
  it('writes 300-329', () => {
    mkdirSync(outDir as string, { recursive: true })
    write('300-M-1-control.ncep', 'M-1', () => ({}))
    const rename = (s: string): string =>
      s
        .replace(/Name=M-1\b/g, 'Name=X-1')
        .replace(/Part=M-1\b/g, 'Part=X-1')
        .replace(/LabelContent=M-1\b/g, 'LabelContent=X-1')
        .replace(/>M-1<\/text>/g, '>X-1</text>')
    write('301-M-1-name-X1.ncep', 'M-1', (p) => ({
      [p.root]: rename,
      [p.part]: rename,
      [p.adobe]: rename,
    }))
    write('302-M-1-quantity-2.ncep', 'M-1', (p) => ({
      [p.root]: replaceAll('TotalCount=1', 'TotalCount=2'),
    }))
    write('303-M-1-invert-1.ncep', 'M-1', (p) => ({
      [p.root]: replaceAll('Invert=0', 'Invert=1'),
    }))
    write('304-M-1-rotate-90.ncep', 'M-1', (p) => ({
      [p.root]: replaceAll('RotateAngle=0', 'RotateAngle=90'),
    }))
    write('305-M-1-length-meta-4000.ncep', 'M-1', (p) => ({
      [p.root]: replaceAll('Length=3000', 'Length=4000'),
    }))
    write('306-M-1-remove-one-hole.ncep', 'M-1', (p) => ({
      [p.part]: (s) => s.replace(firstCircle, ''),
    }))
    write('307-M-1-remove-all-holes.ncep', 'M-1', (p) => ({
      [p.part]: (s) => s.replace(/<circle\b[^>]*\/>/g, ''),
    }))
    write('308-M-1-add-hole.ncep', 'M-1', (p) => ({
      [p.part]: (s) => {
        const circle = firstCircle.exec(s)?.[0]
        return circle
          ? s.replace(circle, () => circle + '\n  ' + duplicateCircle(circle, 19000001, 100))
          : s
      },
    }))
    write('309-M-1-move-hole.ncep', 'M-1', (p) => ({
      [p.part]: (s) => {
        const circle = firstCircle.exec(s)?.[0]
        return circle ? s.replace(circle, () => shiftCircle(circle, 50)) : s
      },
    }))
    write('310-M-1-remove-text.ncep', 'M-1', (p) => ({
      [p.part]: (s) => s.replace(/<text\b[\s\S]*?<\/text>/g, ''),
    }))
    write('311-M-1-text-X1.ncep', 'M-1', (p) => ({
      [p.part]: (s) =>
        s.replace(/LabelContent=M-1/g, 'LabelContent=X-1').replace(/>M-1<\/text>/, '>X-1</text>'),
    }))
    write('312-M-1-add-text.ncep', 'M-1', (p) => ({
      [p.part]: addText,
    }))
    write('313-M-1-end-cut-shorter-20.ncep', 'M-1', (p) => ({
      [p.part]: (s) => endCut(s, '5064.2'),
    }))
    write('314-M-1-end-cut-longer-20.ncep', 'M-1', (p) => ({
      [p.part]: (s) => endCut(s, '5104.2'),
    }))
    write('315-M-1-longer-200.ncep', 'M-1', (p) => ({
      [p.part]: (s) => shiftEndHoles(endCut(s, '5284.2'), 200),
    }))
    write('316-M-1-type-8195.ncep', 'M-1', (p) => ({
      [p.root]: replaceAll('Type=8199', 'Type=8195'),
    }))
    {
      const donor = base('M-8')
      const donorFiles = donor.files
      const swap = swapSection(base('M-1').files, donorFiles)
      write('317-M-1-section-M8.ncep', 'M-1', (p) => ({
        [p.part]: swap.part,
        [p.adobe]: swap.adobe,
        [p.root]: (s) =>
          s
            .replace(/Thickness=[^;]+/g, `Thickness=${swap.thickness}`)
            .replace(/LegThickness=[^;]+/g, `LegThickness=${swap.leg}`),
      }))
    }

    write('320-M-26-control.ncep', 'M-26', () => ({}))
    write('321-M-26-angle-15.ncep', 'M-26', (p) => ({
      [p.part]: replaceAll('Angle=0.5235987755982988', 'Angle=0.2617993877991494'),
      [p.adobe]: replaceAll('Angle=0.5235987755982988', 'Angle=0.2617993877991494'),
    }))
    write('322-M-26-angle-45.ncep', 'M-26', (p) => ({
      [p.part]: replaceAll('Angle=0.5235987755982988', 'Angle=0.7853981633974483'),
      [p.adobe]: replaceAll('Angle=0.5235987755982988', 'Angle=0.7853981633974483'),
    }))
    write('323-M-26-angle-0.ncep', 'M-26', (p) => ({
      [p.part]: replaceAll('Angle=0.5235987755982988', 'Angle=0'),
      [p.adobe]: replaceAll('Angle=0.5235987755982988', 'Angle=0'),
    }))
    write('324-M-26-remove-lead.ncep', 'M-26', (p) => ({
      [p.part]: (s) => removeBalanced(removeBalanced(s, 'LeadIn'), 'LeadOut'),
      [p.adobe]: (s) => removeBalanced(removeBalanced(s, 'LeadIn'), 'LeadOut'),
    }))
    write('325-M-26-angle-60.ncep', 'M-26', (p) => ({
      [p.part]: replaceAll('Angle=0.5235987755982988', 'Angle=1.0471975511965976'),
      [p.adobe]: replaceAll('Angle=0.5235987755982988', 'Angle=1.0471975511965976'),
    }))

    write('326-M-34-control.ncep', 'M-34', () => ({}))
    write('327-M-34-start-notch-removed.ncep', 'M-34', (p) => ({
      [p.part]: (s) =>
        s.replace(/<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/, (tag) =>
          tag.replace(/ d="[^"]+"/, ' d="M-240,90 L240,90 "'),
        ),
    }))
    write('328-M-1-lead-angle-45.ncep', 'M-1', (p) => ({
      [p.part]: replaceAll('Angle=0.5235987755982988', 'Angle=0.7853981633974483'),
      [p.adobe]: replaceAll('Angle=0.5235987755982988', 'Angle=0.7853981633974483'),
    }))

    writeFileSync(
      join(outDir as string, 'README.txt'),
      [
        'Minor content probes on real NCEP packages (ZIP headers untouched).',
        '300 control, 301 name, 302 quantity, 303 invert, 304 rotate, 305 Length metadata,',
        '306 remove 1 hole, 307 remove all holes, 308 add hole, 309 move hole,',
        '310 remove text, 311 text X-1, 312 add text, 313/314 end cut +/-20,',
        '315 200 mm longer, 316 Type 8195, 317 M-8 section swap.',
        '320 M-26 control, 321/322/323 lead angle 15/45/0 deg, 324 remove lead-in/out,',
        '325 lead angle 60 deg, 326 M-34 control, 327 M-34 start notch removed,',
        '328 M-1 lead angle 45 deg.',
        '',
        'Angle= is the lead-in/out angle in wh:technical, not the shaped end contour.',
        '',
      ].join('\n'),
    )
  }, 120_000)
})
