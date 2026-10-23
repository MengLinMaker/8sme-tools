import { readFileSync } from 'node:fs'
import { fixture, fixtureExists } from '@test/fixtures'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildNcepFromNc, partFromNc } from './fromNc'

/** Circle set `(cx, cy, r)` rounded to 0.01 mm. */
function circles(svg: string): string[] {
  const out: string[] = []
  for (const match of svg.matchAll(/<circle ([^>]*)\/>/g)) {
    const attr = match[1] ?? ''
    const value = (key: string): number => {
      const found = new RegExp(`\\b${key}="([^"]*)"`).exec(attr)
      return found ? Number(found[1]) : Number.NaN
    }
    const norm = (n: number): number => (Math.abs(n) < 0.005 ? 0 : n)
    out.push(
      `${norm(value('cx')).toFixed(2)},${norm(value('cy')).toFixed(2)},${norm(value('r')).toFixed(2)}`,
    )
  }
  return out.sort()
}

function ncepPartSvg(bytes: Uint8Array): string {
  const files = unzipSync(bytes)
  const cad = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
  const name = /<Part [^>]*svgname="([^"]+)"/.exec(cad)?.[1]
  if (!name) throw new Error('no part svg')
  return strFromU8(files[`CAD/${name}`] as Uint8Array)
}

const MARKS = ['M-1', 'M-3', 'M-35', 'M-42'] as const

describe('partFromNc / NCEP', () => {
  for (const mark of MARKS) {
    const ncPath = fixture('ncep', `${mark}.nc1`)
    const ncepPath = fixture('ncep', `${mark}.ncep`)
    it.skipIf(!fixtureExists('ncep', `${mark}.ncep`))(
      `${mark}: develops the same hole stations as WiseCAM's NCEP`,
      () => {
        const ncText = readFileSync(ncPath, 'utf8')
        const expected = ncepPartSvg(new Uint8Array(readFileSync(ncepPath)))
        const part = partFromNc(ncText)
        expect(part).not.toBeNull()
        if (!part) return
        const bytes = buildNcepFromNc(ncText)
        expect(bytes).not.toBeNull()
        if (!bytes) return
        expect(circles(ncepPartSvg(bytes))).toEqual(circles(expected))
      },
      60_000,
    )
  }

  it('puts the PFC inner cavity in the section group', () => {
    const part = partFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'))
    expect(part?.innerSection?.length).toBeGreaterThan(4)
    const bytes = buildNcepFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'))
    if (!bytes) throw new Error('no package')
    const svg = ncepPartSvg(bytes)
    const group = svg.slice(svg.indexOf('wh:class="cadgroup"'))
    expect(group.match(/<path\b/g)).toHaveLength(2)
    expect(group).toContain('M-172.50,-50.00')
    expect(group).toContain('-158.50,40.00')
  })

  it('starts the unrolled surface at 0 for zero-origin tubes', () => {
    const ncText = readFileSync(fixture('ncep', 'M-35.nc1'), 'utf8')
    const part = partFromNc(ncText)
    if (!part) throw new Error('no part')
    const bytes = buildNcepFromNc(ncText)
    if (!bytes) throw new Error('no package')
    const seam = part.unrolledPerimeter ?? 0
    expect(ncepPartSvg(bytes)).toContain(`M0.00,0.00 L${seam.toFixed(2)},0.00`)
  })

  it('develops layout markings onto the unrolled surface', () => {
    const ncText = readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8').replace(
      /EN(\r?\n)?$/,
      'SI\n  v 100.00u 25.00 0.00 10.00 TEST\nEN\n',
    )
    const part = partFromNc(ncText)
    if (!part) throw new Error('no part')
    const marks = part.marks ?? []
    expect(marks.length).toBeGreaterThan(0)
    const points = marks.flatMap((mark) => mark.points)
    expect(points).toContainEqual([145, 90])
    expect(points).toContainEqual([-165, 100])
    const etch = marks.find((mark) => mark.text)
    expect(etch?.text?.value).toBe('TEST')
    expect(etch?.text?.angle).toBe(0)
    expect(etch?.text?.reversed).toBe(false)
    expect(etch?.points[0]).toEqual([-165, 100])
  })

  it('emits the NCEP file set (no CNC payload)', () => {
    const part = partFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'))
    expect(part).not.toBeNull()
    if (!part) return
    const bytes = buildNcepFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'))
    if (!bytes) throw new Error('no package')
    const names = Object.keys(unzipSync(bytes)).sort()
    expect(names).toEqual([
      'CAD/CadRoot.xml',
      'CAD/CustomizeData.xml',
      'CAD/Technology.xml',
      'CAD/adobe500.svg',
      'CAD/cad.opf',
      'CAD/part1000.svg',
      'META-INF/container.xml',
      'mimetype',
      'ncex.opf',
    ])
  })
})
