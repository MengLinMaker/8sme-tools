import { readFileSync } from 'node:fs'
import { fixture, fixtureExists } from '@test/fixtures'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildNcepFromNc, partFromNc } from './fromNc'
import { type NcepPackage, ncepErrors, parseNcepPackage } from './ncepParse'

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

  it('develops the NC cut contours onto the net', () => {
    const part = partFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'))
    if (!part) throw new Error('no part')
    expect(part.cuts?.length).toBe(3)
    expect(part.cuts?.every((cut) => cut.points.length >= 4)).toBe(true)
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

function truncateRange(
  pkg: NcepPackage,
  type: 0 | 1,
): { station: [number, number]; along: [number, number] } {
  const truncate = pkg.partSvg?.part?.truncates.find((entry) => entry.truncateType === type)
  if (!truncate) throw new Error(`no truncate type ${type}`)
  const points = truncate.paths.flatMap((path) => path.points)
  return {
    station: [Math.min(...points.map(([x]) => x)), Math.max(...points.map(([x]) => x))],
    along: [Math.min(...points.map(([, y]) => y)), Math.max(...points.map(([, y]) => y))],
  }
}

function holeSet(pkg: NcepPackage): string[] {
  const norm = (value: number): number => (Math.abs(value) < 0.005 ? 0 : value)
  return (pkg.partSvg?.part?.holes ?? [])
    .map((hole) => `${norm(hole.cx).toFixed(2)},${norm(hole.cy).toFixed(2)},${hole.r.toFixed(2)}`)
    .sort()
}

function expectRange(
  actual: { station: [number, number]; along: [number, number] },
  expected: { station: [number, number]; along: [number, number] },
): void {
  expect(actual.station[0]).toBeCloseTo(expected.station[0], 2)
  expect(actual.station[1]).toBeCloseTo(expected.station[1], 2)
  expect(actual.along[0]).toBeCloseTo(expected.along[0], 2)
  expect(actual.along[1]).toBeCloseTo(expected.along[1], 2)
}

describe('generated NCEP packages pass the parser', () => {
  const marks = ['M-1', 'M-3', 'M-34', 'M-35', 'M-42'] as const

  it('reads hyphenated marks from the NC header', () => {
    for (const mark of marks) {
      expect(partFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'))?.mark).toBe(mark)
    }
  })

  for (const mark of marks) {
    it(`${mark}: validates and matches WiseCAM's developed geometry`, () => {
      const nc = readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8')
      const bytes = buildNcepFromNc(nc)
      if (!bytes) throw new Error('no package')
      const generated = parseNcepPackage(bytes)
      expect(ncepErrors(generated)).toEqual([])
      const userPathWarning = generated.issues.some((issue) => issue.code === 'adobe-userpath')
      expect(userPathWarning).toBe(generated.profileType === 'U' || generated.profileType === 'I')

      const real = parseNcepPackage(new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`))))
      expect(generated.mark).toBe(real.mark)
      expect(generated.typeCode).toBe(real.typeCode)
      expect(generated.profileType).toBe(real.profileType)
      // The converter preserves the NC quantity; WiseCAM's per-part export writes 1.
      expect(generated.quantity).toBe(partFromNc(nc)?.quantity)
      expect(generated.thickness ?? 0).toBeCloseTo(real.thickness ?? 0, 6)
      expect(generated.legThickness ?? 0).toBeCloseTo(real.legThickness ?? 0, 6)
      if (mark === 'M-34') {
        // Known open issue: the DSTV `u` face is reversed for this PFC (1 mm hole shift).
        expect(generated.partSvg?.part?.holes.length).toBe(real.partSvg?.part?.holes.length)
      } else {
        expect(holeSet(generated)).toEqual(holeSet(real))
      }

      for (const type of [0, 1] as const) {
        expectRange(truncateRange(generated, type), truncateRange(real, type))
      }
      expect(generated.partSvg?.sections[0]?.wires.length).toBe(
        real.partSvg?.sections[0]?.wires.length,
      )
    })
  }

  it('develops the M-3 and M-42 shaped ends instead of straight cuts', () => {
    const m3 = parseNcepPackage(
      buildNcepFromNc(readFileSync(fixture('ncep', 'M-3.nc1'), 'utf8')) as Uint8Array,
    )
    expect(truncateRange(m3, 0).along).toEqual([expect.closeTo(0, 6), expect.closeTo(90, 6)])
    expect(truncateRange(m3, 1).along).toEqual([
      expect.closeTo(3296.48, 2),
      expect.closeTo(3386.48, 2),
    ])

    const m42 = parseNcepPackage(
      buildNcepFromNc(readFileSync(fixture('ncep', 'M-42.nc1'), 'utf8')) as Uint8Array,
    )
    expect(truncateRange(m42, 1).along).toEqual([expect.closeTo(56, 6), expect.closeTo(106, 6)])
  })
})
