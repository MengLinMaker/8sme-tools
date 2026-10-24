import { readFileSync } from 'node:fs'
import { fixture } from '@test/fixtures'
import { describe, expect, it } from 'vitest'
import { buildNcepFromNc } from './fromNc'
import { type NcepPackage, ncepErrors, parseNcepPackage, parseNcepSvg } from './ncepParse'

const MARKS = [
  'M-1',
  'M-3',
  'M-4',
  'M-5',
  'M-8',
  'M-9',
  'M-26',
  'M-30',
  'M-31',
  'M-34',
  'M-35',
  'M-39',
  'M-40',
  'M-42',
  'M-43',
  'M-51',
  'M-52',
] as const

function parseFixture(mark: string): NcepPackage {
  return parseNcepPackage(new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`))))
}

function truncateRange(pkg: NcepPackage, type: 0 | 1): [number, number] {
  const truncate = pkg.partSvg?.part?.truncates.find((entry) => entry.truncateType === type)
  if (!truncate) throw new Error(`no truncate type ${type}`)
  const points = truncate.paths.flatMap((path) => path.points)
  return [Math.min(...points.map(([, y]) => y)), Math.max(...points.map(([, y]) => y))]
}

describe('NCEP SVG parser on the real fixtures', () => {
  for (const mark of MARKS) {
    it(`${mark}: parses without errors`, () => {
      const pkg = parseFixture(mark)
      expect(
        ncepErrors(pkg),
        ncepErrors(pkg)
          .map((issue) => issue.message)
          .join('\n'),
      ).toEqual([])
      expect(pkg.mark).toBe(mark)
      expect(pkg.partSvg).not.toBeNull()
      expect(pkg.adobeSvg).not.toBeNull()
      expect(pkg.partSvg?.part).not.toBeNull()
      expect(pkg.partSvg?.part?.truncates).toHaveLength(2)
      expect(pkg.partSvg?.part?.wires).toHaveLength(0)
      expect(pkg.partSvg?.sections.length).toBeGreaterThan(0)
      expect(pkg.partSvg?.extents.station).not.toBeNull()
      expect(pkg.partSvg?.extents.along).not.toBeNull()
      expect(pkg.files.some((name) => name.startsWith('CNC/'))).toBe(false)
    })
  }

  it('reads the CadRoot type, quantity and thickness', () => {
    const pfc = parseFixture('M-1')
    expect(pfc.typeCode).toBe(8199)
    expect(pfc.profileType).toBe('U')
    expect(pfc.quantity).toBe(1)
    expect(pfc.thickness).toBeCloseTo(10, 6)
    expect(pfc.legThickness).toBeCloseTo(17.5, 6)

    expect(parseFixture('M-3').profileType).toBe('I')
    expect(parseFixture('M-26').profileType).toBe('M')
  })

  it('keeps shaped end cuts rather than forcing a rectangle', () => {
    const m3 = parseFixture('M-3')
    const start = truncateRange(m3, 0)
    expect(start[0]).toBeCloseTo(0, 6)
    expect(start[1]).toBeCloseTo(90, 6)
    expect(truncateRange(m3, 1)[0]).toBeCloseTo(3296.48, 2)
    expect(truncateRange(m3, 1)[1]).toBeCloseTo(3386.48, 2)
    expect(m3.partSvg?.part?.holes.some((hole) => Math.abs(hole.cy - 35) < 1e-6)).toBe(true)

    const m5 = truncateRange(parseFixture('M-5'), 0)
    expect(m5[0]).toBeCloseTo(0, 6)
    expect(m5[1]).toBeCloseTo(400, 6)
    const m42 = truncateRange(parseFixture('M-42'), 1)
    expect(m42[0]).toBeCloseTo(56, 6)
    expect(m42[1]).toBeCloseTo(106, 6)
  })

  it('treats InnerCad as optional and non-authoritative', () => {
    const m1 = parseFixture('M-1')
    const start = m1.partSvg?.part?.truncates.find((entry) => entry.truncateType === 0)
    expect(start?.innerCad?.length).toBeGreaterThan(2)
    const dStations = start?.paths.flatMap((path) => path.points.map(([x]) => x)) ?? []
    const innerStations = start?.innerCad?.map(([x]) => x) ?? []
    expect(Math.max(...dStations)).toBeCloseTo(290, 2)
    expect(Math.max(...innerStations)).toBeLessThan(290)

    const m3 = parseFixture('M-3')
    expect(m3.partSvg?.part?.truncates.every((entry) => entry.innerCad == null)).toBe(true)
  })

  it('normalises layer-6 rectangles and text marks', () => {
    const m3 = parseFixture('M-3')
    const marks = m3.partSvg?.part?.marks ?? []
    const text = marks.find((mark) => mark.tag === 'text')
    expect(text?.label).toBe('M-3')
    expect(text?.rotate).toBe(90)
    const rect = marks.find((mark) => mark.tag === 'rect')
    expect(rect?.paths[0]?.closed).toBe(true)
    const points = rect?.paths[0]?.points ?? []
    expect(points).toHaveLength(4)
    expect(Math.min(...points.map(([x]) => x))).toBeCloseTo(-125.5, 6)
    expect(Math.max(...points.map(([x]) => x))).toBeCloseTo(125.5, 6)

    const m42 = parseFixture('M-42')
    expect(m42.partSvg?.part?.marks).toHaveLength(0)
    expect(m42.partSvg?.part?.holes).toHaveLength(0)
  })

  it('parses parts with no holes', () => {
    expect(parseFixture('M-31').partSvg?.part?.holes).toHaveLength(0)
  })

  it('round-trips the NCEP we generate from the M-1 NC', () => {
    const bytes = buildNcepFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'))
    expect(bytes).not.toBeNull()
    if (!bytes) return
    const pkg = parseNcepPackage(bytes)
    expect(
      ncepErrors(pkg),
      ncepErrors(pkg)
        .map((issue) => issue.message)
        .join('\n'),
    ).toEqual([])
    expect(pkg.partSvg?.part?.truncates).toHaveLength(2)
    expect(pkg.partSvg?.part?.holes.length).toBeGreaterThan(0)

    const real = parseFixture('M-1')
    const circleSet = (value: NcepPackage): string[] =>
      (value.partSvg?.part?.holes ?? [])
        .map((hole) => `${hole.cx.toFixed(2)},${hole.cy.toFixed(2)},${hole.r.toFixed(2)}`)
        .sort()
    expect(circleSet(pkg)).toEqual(circleSet(real))
  })
})

describe('NCEP SVG validation', () => {
  it('flags an empty cadpart', () => {
    const document = parseNcepSvg(
      '<svg xmlns:wh="http://www.weihong.com.cn/cadcam"><g wh:class="cadpart" wh:id="1"/></svg>',
      'part',
    )
    const codes = document.issues.map((issue) => issue.code)
    expect(codes).toContain('truncate-count')
    expect(codes).toContain('section')
  })

  it('flags a section group nested inside cadpart', () => {
    const svg = `<svg xmlns:wh="http://www.weihong.com.cn/cadcam">
      <g wh:class="cadpart" wh:id="1">
        <g wh:class="cadgroup" wh:id="2"><path d="M0,0 L1,1"/></g>
      </g>
    </svg>`
    const document = parseNcepSvg(svg, 'part')
    expect(document.issues.some((issue) => issue.code === 'nested-group')).toBe(true)
  })

  it('reports a non-ZIP payload', () => {
    const pkg = parseNcepPackage(new Uint8Array([1, 2, 3]))
    expect(pkg.issues.some((issue) => issue.code === 'zip')).toBe(true)
  })
})
