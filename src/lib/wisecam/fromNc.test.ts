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
