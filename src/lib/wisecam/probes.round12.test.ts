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
 * Round 12: RHS/SHS end-cut isolation (section vs trims, start vs end), layer-6 etch forms,
 * etch position correction, and M-39 new-size isolation.
 *
 *   WRITE_NCEX_PROBES=~/Downloads/ncep-probes-round12 \
 *     pnpm exec vitest run src/lib/wisecam/probes.round12.test.ts
 */
const outDir = process.env.WRITE_NCEX_PROBES

type Files = Record<string, Uint8Array>
type Edit = (text: string) => string

interface Real {
  internalMark: string
  entries: RawZipEntry[]
  files: Files
  partPath: string
  part: string
  section: string
  trims: { start: string; end: string }
  holes: string
  marks: string
}

function rootOf(files: Files): string {
  return strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
}

function svgName(files: Files, kind: 'Adobe' | 'Part'): string {
  const root = rootOf(files)
  const tag = root.match(new RegExp(`<${kind}\\b[^>]*/>`))?.[0] ?? ''
  return /svgname="([^"]+)"/.exec(tag)?.[1] ?? ''
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

function trims(partSvg: string): { start: string; end: string } {
  return {
    start: partSvg.match(/<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/)?.[0] ?? '',
    end: partSvg.match(/<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/)?.[0] ?? '',
  }
}

function replaceTrims(svg: string, real: { start: string; end: string }): string {
  return svg
    .replace(/<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/, real.start)
    .replace(/<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/, real.end)
}

function holeBlock(partSvg: string): string {
  return (partSvg.match(/<circle\b[^>]*\/>/g) ?? []).join('\n')
}

function replaceHoles(svg: string, holes: string): string {
  let replaced = false
  return svg.replace(/<circle\b[^>]*\/>\s*/g, () => {
    if (replaced) return ''
    replaced = true
    return `${holes}\n  `
  })
}

function markElements(partSvg: string): string {
  const text = partSvg.match(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/)?.[0] ?? ''
  const rects = partSvg.match(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g) ?? []
  const lines = partSvg.match(/<line\b[^>]*wh:layer="4"[^>]*\/>/g) ?? []
  return [text, ...rects, ...lines].filter(Boolean).join('\n')
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

function real(mark: string, path = fixture('ncep', `${mark}.ncep`)): Real {
  const raw = new Uint8Array(readFileSync(path))
  const entries = readZipRaw(raw)
  const files = unzipSync(raw) as Files
  const root = rootOf(files)
  const internalMark = /<Part\b[^>]*Name=([^;"]+)/.exec(root)?.[1] ?? ''
  const partName = svgName(files, 'Part')
  const part = strFromU8(files[`CAD/${partName}`] as Uint8Array)
  return {
    internalMark,
    entries,
    files,
    partPath: `CAD/${partName}`,
    part,
    section: lastGroup(part),
    trims: trims(part),
    holes: holeBlock(part),
    marks: markElements(part),
  }
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
    if (entry.method === 0) {
      return {
        ...entry,
        compressed: data,
        compressedSize: data.length,
        uncompressedSize: data.length,
        crc: crc32(data),
      }
    }
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

function report(
  file: string,
  mark: string,
  variant: string,
  pkg: NcepPackage,
): Record<string, unknown> {
  return {
    file,
    mark,
    variant,
    errors: pkg.issues.filter((i) => i.severity === 'error').map((i) => i.code),
    warnings: pkg.issues.filter((i) => i.severity === 'warning').map((i) => i.code),
  }
}

function bars(mark: Real): string[] {
  return mark.marks.match(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g) ?? []
}

function text(mark: Real): string {
  return mark.marks.match(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/)?.[0] ?? ''
}

function withLayer(tag: string, layer: 4 | 6): string {
  return tag
    .replace(/wh:layer="\d+"/, `wh:layer="${layer}"`)
    .replace(/class="layer\d+"/, `class="layer${layer}"`)
}

function withParams(tag: string, params: string): string {
  return /wh:params="/.test(tag)
    ? tag.replace(/wh:params="[^"]*"/, `wh:params="${params}"`)
    : tag.replace(/ wh:technical=/, ` wh:params="${params}" wh:technical=`)
}

function withTechnical(tag: string, technical: string): string {
  return tag.replace(/wh:technical="[^"]*"/, `wh:technical="${technical}"`)
}

function toOutline(tag: string): string {
  const x = Number(/ x="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const y = Number(/ y="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const w = Number(/ width="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const h = Number(/ height="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const transform = / transform="([^"]+)"/.exec(tag)?.[1]
  return `<path wh:id="${/wh:id="(\d+)"/.exec(tag)?.[1] ?? '0'}" wh:class="cadpolyline" wh:layer="4" wh:isfill="0" wh:machining="1" d="M${x},${y} L${x + w},${y} L${x + w},${y + h} L${x},${y + h}" wh:params="needSetAdobe=true;" wh:technical="T={};" class="layer4"${transform ? ` transform="${transform}"` : ''}/>`
}

function toLine(tag: string): string {
  const x = Number(/ x="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const y = Number(/ y="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const w = Number(/ width="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const h = Number(/ height="([^"]+)"/.exec(tag)?.[1] ?? 0)
  const transform = / transform="([^"]+)"/.exec(tag)?.[1]
  const horizontal = w >= h
  const x1 = horizontal ? x : x + w / 2
  const y1 = horizontal ? y + h / 2 : y
  const x2 = horizontal ? x + w : x + w / 2
  const y2 = horizontal ? y + h / 2 : y + h
  return `<line wh:id="${/wh:id="(\d+)"/.exec(tag)?.[1] ?? '0'}" wh:class="cadline" wh:layer="4" wh:isfill="0" wh:machining="1" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" wh:params="needSetAdobe=true;" wh:technical="T={};" class="layer4"${transform ? ` transform="${transform}"` : ''}/>`
}

describe.skipIf(!outDir)('round 12 end/etch/shape uncertainty', () => {
  it('writes 2700-2744', () => {
    const out = outDir as string
    mkdirSync(out, { recursive: true })
    const reports: Record<string, unknown>[] = []
    const write = (name: string, entries: RawZipEntry[], mark: string, variant: string): void => {
      const bytes = writeZipRaw(entries)
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }
    const writeReal = (name: string, path: string, mark: string, variant: string): void => {
      const bytes = new Uint8Array(readFileSync(path))
      writeFileSync(join(out, name), bytes)
      reports.push(report(name, mark, variant, parseNcepPackage(bytes)))
    }
    const startTrim = /<path\b[^>]*IsTrucate=1;TrucateType=0;[^>]*\/>/
    const endTrim = /<path\b[^>]*IsTrucate=1;TrucateType=1;[^>]*\/>/

    const cutParts = (code: number, mark: string): void => {
      const base = real(mark)
      writeReal(
        `${code} ${mark} control.ncep`,
        fixture('ncep', `${mark}.ncep`),
        mark,
        'real control',
      )

      const make = (
        offset: number,
        label: string,
        edit: (part: string, unique: string) => string,
      ): void => {
        const unique = `${code + offset} ${mark} ${label}`
        const built = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
          mark: unique,
        })
        if (!built) throw new Error(`cannot build ${mark}`)
        const files = unzipSync(built) as Files
        const entries = readZipRaw(built)
        const partPath = `CAD/${svgName(files, 'Part')}`
        write(
          `${code + offset} ${mark} ${label}.ncep`,
          editEntries(entries, files, { [partPath]: (part) => edit(part, unique) }),
          unique,
          label,
        )
      }
      const realSection = (part: string): string => replaceLastGroup(part, base.section)
      const realTrims = (part: string, unique: string): string =>
        replaceTrims(part, {
          start: rename(base.trims.start, base.internalMark, unique),
          end: rename(base.trims.end, base.internalMark, unique),
        })
      const realStart = (part: string, unique: string): string =>
        part.replace(startTrim, rename(base.trims.start, base.internalMark, unique))
      const realEnd = (part: string, unique: string): string =>
        part.replace(endTrim, rename(base.trims.end, base.internalMark, unique))

      make(1, 'standard', (part) => part)
      make(2, 'real section', (part) => realSection(part))
      make(3, 'real trims', (part, unique) => realTrims(part, unique))
      make(4, 'real section trims', (part, unique) => realTrims(realSection(part), unique))
      make(5, 'real start', (part, unique) => realStart(part, unique))
      make(6, 'real end', (part, unique) => realEnd(part, unique))
    }

    cutParts(2700, 'M-43')
    cutParts(2710, 'M-51')

    const m39 = real('M-39')
    writeReal('2720 M-39 control.ncep', fixture('ncep', 'M-39.ncep'), 'M-39', 'real control')
    const m39Case = (code: number, label: string, edit: (part: string) => string): void => {
      const unique = `${code} M-39 ${label}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-39.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build M-39')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files, 'Part')}`
      write(
        `${code} M-39 ${label}.ncep`,
        editEntries(entries, files, { [partPath]: edit }),
        unique,
        label,
      )
    }
    m39Case(2721, 'standard', (part) => part)
    m39Case(2722, 'real section', (part) => replaceLastGroup(part, m39.section))
    m39Case(2723, 'real trims', (part) =>
      replaceTrims(part, {
        start: rename(m39.trims.start, m39.internalMark, '2723 M-39 real trims'),
        end: rename(m39.trims.end, m39.internalMark, '2723 M-39 real trims'),
      }),
    )
    m39Case(2724, 'real section trims', (part) =>
      replaceTrims(replaceLastGroup(part, m39.section), {
        start: rename(m39.trims.start, m39.internalMark, '2724 M-39 real section trims'),
        end: rename(m39.trims.end, m39.internalMark, '2724 M-39 real section trims'),
      }),
    )

    // Layer-6 etch forms (bars from real M-3, same geometry).
    const m3 = real('M-3')
    const m3Bars = bars(m3)
    const m3Text = text(m3)
    writeReal('2730 M-3 control.ncep', fixture('ncep', 'M-3.ncep'), 'M-3', 'real control')
    const etchCase = (
      code: number,
      label: string,
      transform: (bar: string) => string,
      addText: boolean,
    ): void => {
      const unique = `${code} M-3 ${label}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-3.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build M-3')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files, 'Part')}`
      const elements = `${addText ? rename(m3Text, m3.internalMark, unique) : ''}\n${m3Bars.map(transform).join('\n')}`
      const edits: Record<string, Edit> = {
        [partPath]: (part) =>
          replaceHoles(
            replaceTrims(replaceLastGroup(part, m3.section), {
              start: rename(m3.trims.start, m3.internalMark, unique),
              end: rename(m3.trims.end, m3.internalMark, unique),
            }),
            m3.holes,
          )
            .replace(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/, '')
            .replace(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g, '')
            .replace(/<line\b[^>]*wh:layer="4"[^>]*\/>/g, '')
            .replace(/<path\b[^>]*needSetAdobe=true;[^>]*\/>/g, '')
            .replace('</g>', `${elements}\n </g>`),
      }
      write(`${code} M-3 ${label}.ncep`, editEntries(entries, files, edits), unique, label)
    }
    const clean6 = (tag: string): string =>
      tag
        .replace(/wh:layer="4"/, 'wh:layer="6"')
        .replace(/class="layer4"/, 'class="layer6"')
        .replace(/ wh:params="needSetAdobe=true;"/, '')
    etchCase(2731, 'L6 rect', (bar) => withLayer(bar, 6), false)
    etchCase(2732, 'L6 line', (bar) => clean6(toLine(bar)), false)
    etchCase(2733, 'L6 outline', (bar) => clean6(toOutline(bar)), false)
    etchCase(
      2734,
      'L6 rect needSetAdobe',
      (bar) => withParams(withLayer(bar, 6), 'needSetAdobe=true;'),
      false,
    )
    etchCase(2735, 'L6 rect T', (bar) => withTechnical(withLayer(bar, 6), 'T={};'), false)
    etchCase(2736, 'L6 text L4', (bar) => withLayer(bar, 6), true)

    // M-1 etch position: NC position vs exemplar y=3306 vs part centre.
    const m1 = real('M-1')
    writeReal('2740 M-1 control.ncep', fixture('ncep', 'M-1.ncep'), 'M-1', 'real control')
    const m1Case = (
      code: number,
      label: string,
      edit: (part: string, unique: string) => string,
    ): void => {
      const unique = `${code} M-1 ${label}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build M-1')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files, 'Part')}`
      write(
        `${code} M-1 ${label}.ncep`,
        editEntries(entries, files, { [partPath]: (part) => edit(part, unique) }),
        unique,
        label,
      )
    }
    const ourM1 = (part: string, unique: string): string =>
      replaceHoles(
        replaceTrims(replaceLastGroup(part, m1.section), {
          start: rename(m1.trims.start, m1.internalMark, unique),
          end: rename(m1.trims.end, m1.internalMark, unique),
        }),
        m1.holes,
      )
    const setBarY = (part: string, y: number): string =>
      part.replace(/<rect\b[^>]*wh:layer="6"[^>]*\/>/, (tag) =>
        tag.replace(/ y="[^"]+"/, ` y="${y}"`),
      )
    m1Case(2741, 'NC position', (part, unique) => ourM1(part, unique))
    m1Case(2742, 'exemplar y3306', (part, unique) => setBarY(ourM1(part, unique), 3306))
    m1Case(2743, 'centre position', (part, unique) => setBarY(ourM1(part, unique), 2542.1))
    m1Case(2744, 'exemplar bar', (part, unique) =>
      ourM1(part, unique).replace(
        /<rect\b[^>]*wh:layer="6"[^>]*\/>/,
        `<rect wh:id="19000001" wh:class="cadrectangle" wh:layer="6" wh:isfill="0" wh:machining="1" x="-5" y="3306" width="110" height="10" wh:direction="0" wh:technical="T={LeadLine={Pos={Segment=1,Ratio=0.5,},LeadInBreak=0,Radius = 0,Seal=0,LeadIn={Type=0,Length=3,Angle=0.5235987755982988,Radius=3,AbsoluteAngle=1,},LeadOut={Type=0,Length=3,Angle=0.5235987755982988,Radius=0.1,},},};" class="layer6"/>`,
      ),
    )

    // Quantity / multi-piece metadata.
    const quantityCase = (code: number, mark: string): void => {
      const unique = `${code} ${mark} quantity2`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error(`cannot build ${mark}`)
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      write(
        `${code} ${mark} quantity2.ncep`,
        editEntries(entries, files, {
          'CAD/CadRoot.xml': (textValue) => textValue.replace(/TotalCount=1/g, 'TotalCount=2'),
        }),
        unique,
        'quantity 2',
      )
    }
    quantityCase(2750, 'M-3')
    quantityCase(2751, 'M-1')

    // Text/etch layer and lead-in.
    const textElement = (angle: number, size: number, layer: 4 | 6): string =>
      `<text wh:id="19000002" wh:class="cadtext" wh:layer="${layer}" wh:isfill="0" wh:machining="1" x="0.00" y="1000.00" font-family="Arial" font-size="${size}" font-size-adjust="1" letter-spacing="0" word-spacing="0" font-weight="normal" font-style="normal" wh:font-shxfont="txt.shx" wh:font-bigfont="gbcbig.shx" wh:font-isvertrical="0" wh:font-isshape="0" wh:font-obliqueangle="0" wh:font-charset="134" wh:font-pitchandfamily="32" wh:params="IsLabel=true;LabelType=0;LabelContent=ETCH TEST;LabelWidth=1.000000;LabelHeight=${size}.000000;LabelRotate=${angle};LabelSource=1;" wh:technical="T={};" class="layer${layer}" transform="rotate(${angle} 0.00,1000.00)">ETCH TEST</text>`
    const textProbe = (
      code: number,
      label: string,
      angle: number,
      size: number,
      layer: 4 | 6,
    ): void => {
      const unique = `${code} M-3 ${label}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-3.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build M-3')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files, 'Part')}`
      const element = `${textElement(angle, size, layer)}\n${withLayer(m3Bars[0] as string, 6)}`
      write(
        `${code} M-3 ${label}.ncep`,
        editEntries(entries, files, {
          [partPath]: (part) => {
            const geometry = replaceHoles(
              replaceTrims(replaceLastGroup(part, m3.section), {
                start: rename(m3.trims.start, m3.internalMark, unique),
                end: rename(m3.trims.end, m3.internalMark, unique),
              }),
              m3.holes,
            )
            return geometry
              .replace(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/, '')
              .replace(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g, '')
              .replace(/<line\b[^>]*wh:layer="4"[^>]*\/>/g, '')
              .replace(/<path\b[^>]*needSetAdobe=true;[^>]*\/>/g, '')
              .replace('</g>', `${element}\n </g>`)
          },
        }),
        unique,
        label,
      )
    }
    textProbe(2752, 'text L6 0', 0, 40, 6)
    textProbe(2753, 'text L4 0', 0, 40, 4)
    textProbe(2754, 'text L6 45', 45, 40, 6)
    textProbe(2755, 'text L6 90', 90, 40, 6)
    textProbe(2756, 'text L6 180', 180, 40, 6)
    textProbe(2757, 'text L6 size20', 0, 20, 6)
    textProbe(2758, 'text L6 size60', 0, 60, 6)

    // Handedness / mirroring.
    const flipCase = (code: number, mark: string): void => {
      const unique = `${code} ${mark} flipFlanges`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'), {
        mark: unique,
        flipFlanges: true,
      })
      if (!built) throw new Error(`cannot build ${mark}`)
      write(`${code} ${mark} flipFlanges.ncep`, readZipRaw(built), unique, 'flipFlanges')
    }
    flipCase(2759, 'M-1')
    flipCase(2760, 'M-3')

    // Edge cases: empty holes / empty marks.
    const emptyCase = (code: number, label: string, removeHoles: boolean): void => {
      const unique = `${code} M-3 ${label}`
      const built = buildNcepFromNc(readFileSync(fixture('ncep', 'M-3.nc1'), 'utf8'), {
        mark: unique,
      })
      if (!built) throw new Error('cannot build M-3')
      const files = unzipSync(built) as Files
      const entries = readZipRaw(built)
      const partPath = `CAD/${svgName(files, 'Part')}`
      write(
        `${code} M-3 ${label}.ncep`,
        editEntries(entries, files, {
          [partPath]: (part) => {
            let next = replaceTrims(replaceLastGroup(part, m3.section), {
              start: rename(m3.trims.start, m3.internalMark, unique),
              end: rename(m3.trims.end, m3.internalMark, unique),
            })
            if (removeHoles) next = next.replace(/<circle\b[^>]*\/>\s*/g, '')
            else next = replaceHoles(next, m3.holes)
            return next
              .replace(/<text\b[^>]*wh:class="cadtext"[^>]*>[\s\S]*?<\/text>/, '')
              .replace(/<rect\b[^>]*wh:layer="(?:4|6)"[^>]*\/>/g, '')
              .replace(/<line\b[^>]*wh:layer="4"[^>]*\/>/g, '')
              .replace(/<path\b[^>]*needSetAdobe=true;[^>]*\/>/g, '')
          },
        }),
        unique,
        label,
      )
    }
    emptyCase(2761, 'no holes', true)
    emptyCase(2762, 'no marks', false)

    expect(reports).toHaveLength(44)

    const readme = [
      'Round 12 (2700–2744): end-cut isolation, L6 etch forms, etch position, M-39',
      '',
      '- 2700–2706 M-43: control, standard, real section, real trims, both, real start, real end',
      '- 2710–2716 M-51: same matrix',
      '- 2720–2724 M-39: control, standard, real section, real trims, both',
      '- 2730–2736 M-3 etch: control, L6 rect/line/outline/needSetAdobe/T/text-L4',
      '- 2740–2744 M-1 position: control, NC position, exemplar y3306, centre, exemplar bar',
      '- 2750–2751 quantity 2; 2752–2758 text layer/angle/size; 2759–2760 flipFlanges;',
      '  2761–2762 empty holes / empty marks',
      '',
      '## Matrix',
      '| File | CadRoot Name | Variant | Errors | Warnings |',
      '| --- | --- | --- | --- | --- |',
      ...reports.map(
        (r) =>
          `| ${r.file} | ${r.mark} | ${r.variant} | ${(r.errors as string[]).join(', ') || 'ok'} | ${(r.warnings as string[]).join(', ') || 'ok'} |`,
      ),
      '',
    ].join('\n')
    writeFileSync(join(out, 'README.txt'), readme)
    const zipFiles: Record<string, Uint8Array> = {}
    for (const file of reports)
      zipFiles[file.file as string] = new Uint8Array(readFileSync(join(out, file.file as string)))
    zipFiles['README.txt'] = strToU8(readme)
    writeFileSync(`${out.replace(/\/+$/, '')}.zip`, zipSync(zipFiles, { level: 6 }))
  }, 240_000)
})
