import { existsSync, readFileSync } from 'node:fs'
import { fixture, fixtureExists, nw31Top } from '@test/fixtures'
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

const MARKS = ['M-1', 'M-3', 'M-9', 'M-35', 'M-42'] as const

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

  it('emits true arcs, not sampled polylines, in the section group', () => {
    const sectionGroup = (mark: string): string => {
      const bytes = buildNcepFromNc(readFileSync(fixture('ncep', `${mark}.nc1`), 'utf8'))
      if (!bytes) throw new Error(`no package for ${mark}`)
      const svg = ncepPartSvg(bytes)
      return svg.slice(svg.indexOf('wh:class="cadgroup"'))
    }

    // UB root fillets (r13), PFC web/flange fillets (r14), SHS corners (r12.5 outer/r7.5 inner).
    expect(sectionGroup('M-3')).toContain('A13.00,13.00')
    expect(sectionGroup('M-1')).toContain('A14.00,14.00')
    expect(sectionGroup('M-35')).toContain('A12.50,12.50')
    expect(sectionGroup('M-35')).toContain('A7.50,7.50')

    // The sampled interior vertices must be gone; only exact corner vertices remain.
    expect(sectionGroup('M-3')).not.toContain('140.56,12.39')
    expect(sectionGroup('M-1')).not.toContain('-172.02,29.62')
    expect(sectionGroup('M-35')).not.toContain('35.24,-44.07')
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

  it('emits NC scribe marks on the layer-6 etch layer', () => {
    const part = partFromNc(readFileSync(fixture('ncep', 'M-3.nc1'), 'utf8'))
    expect(part?.marks).toHaveLength(2)
    const bytes = buildNcepFromNc(readFileSync(fixture('ncep', 'M-3.nc1'), 'utf8'))
    if (!bytes) throw new Error('no package')
    const svg = ncepPartSvg(bytes)
    expect((svg.match(/<rect\b/g) ?? []).length).toBe(2)
    expect(svg).toContain('wh:layer="6"')
    expect(svg).not.toContain('needSetAdobe=true')
    expect(svg).toContain('LeadLine=')
    expect(svg).not.toContain('LabelContent=M-3')
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
    const bytes = buildNcepFromNc(ncText)
    if (!bytes) throw new Error('no package')
    const svg = ncepPartSvg(bytes)
    expect(svg).toContain('LabelContent=TEST')
    expect(svg).toContain('>TEST</text>')
  })

  it('keeps notched end-cut steps in contour order along the beam', () => {
    const part = partFromNc(readFileSync(fixture('ncep', 'M-34.nc1'), 'utf8'))
    if (!part) throw new Error('no part')
    const points = part.startCut ?? []
    const at = (station: number, along: number): number =>
      points.findIndex(([s, a]) => Math.abs(s - station) < 0.01 && Math.abs(a - along) < 0.01)
    // Real M-34 start trim: left side goes 79 → 0; right side goes 0 → 79.
    expect(at(-125, 79)).toBeGreaterThanOrEqual(0)
    expect(at(-125, 0)).toBeGreaterThan(at(-125, 79))
    expect(at(125, 0)).toBeGreaterThanOrEqual(0)
    expect(at(125, 79)).toBeGreaterThan(at(125, 0))
  })

  it('develops the NC cut contours onto the net', () => {
    const part = partFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'))
    if (!part) throw new Error('no part')
    expect(part.cuts?.length).toBe(3)
    expect(part.cuts?.every((cut) => cut.points.length >= 4)).toBe(true)
  })

  it.skipIf(!fixtureExists('nw30-bottom', 'm105.nc1'))(
    'samples DSTV radius arcs in the developed cuts and end cuts',
    () => {
      const part = partFromNc(readFileSync(fixture('nw30-bottom', 'm105.nc1'), 'utf8'))
      if (!part) throw new Error('no part')
      // The SHS corner arcs (R 6.7) must be sampled, not collapsed to their chord vertices.
      const outer = part.cuts?.filter((cut) => cut.kind === 'outer') ?? []
      expect(outer.some((cut) => cut.points.length > 40)).toBe(true)
      // The end cut follows the rounded corners across the face instead of a straight line.
      expect(part.startCut?.length).toBeGreaterThan(10)
      expect(part.endCut?.length).toBeGreaterThan(10)
    },
  )

  it('writes the real container.xml bytes (no trailing newline)', () => {
    const bytes = buildNcepFromNc(readFileSync(fixture('ncep', 'M-1.nc1'), 'utf8'))
    if (!bytes) throw new Error('no package')
    const real = unzipSync(new Uint8Array(readFileSync(fixture('ncep', 'M-1.ncep'))))
    const ours = unzipSync(bytes)
    expect(strFromU8(ours['META-INF/container.xml'] as Uint8Array)).toBe(
      strFromU8(real['META-INF/container.xml'] as Uint8Array),
    )
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
  const marks = ['M-1', 'M-3', 'M-9', 'M-34', 'M-35', 'M-42'] as const

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
      expect(userPathWarning).toBe(false)
      if (generated.profileType === 'U' || generated.profileType === 'I') {
        expect(generated.adobeSvg?.groups.length).toBe(3)
        expect(generated.adobeSvg?.userPaths).toHaveLength(1)
        expect(generated.adobeSvg?.userPaths[0]?.wires.length).toBe(
          generated.profileType === 'U' ? 5 : 6,
        )
      } else {
        expect(generated.adobeSvg?.groups.length).toBe(2)
        expect(generated.adobeSvg?.userPaths).toHaveLength(0)
      }

      const real = parseNcepPackage(new Uint8Array(readFileSync(fixture('ncep', `${mark}.ncep`))))
      expect(generated.mark).toBe(real.mark)
      expect(generated.typeCode).toBe(real.typeCode)
      expect(generated.profileType).toBe(real.profileType)
      // The converter preserves the NC quantity; WiseCAM's per-part export writes 1.
      expect(generated.quantity).toBe(partFromNc(nc)?.quantity)
      expect(generated.thickness ?? 0).toBeCloseTo(real.thickness ?? 0, 6)
      expect(generated.legThickness ?? 0).toBeCloseTo(real.legThickness ?? 0, 6)
      expect(holeSet(generated)).toEqual(holeSet(real))

      for (const type of [0, 1] as const) {
        expectRange(truncateRange(generated, type), truncateRange(real, type))
      }
      expect(generated.partSvg?.sections[0]?.wires.length).toBe(
        real.partSvg?.sections[0]?.wires.length,
      )
    })
  }

  it('follows the tube corner cylinder instead of chording the mitre', () => {
    const nearest = (points: [number, number][] | undefined, target: [number, number]): number => {
      if (!points?.length) return Infinity
      return Math.min(
        ...points.map((point) => Math.hypot(point[0] - target[0], point[1] - target[1])),
      )
    }
    const m43 = partFromNc(readFileSync(fixture('ncep', 'M-43.nc1'), 'utf8'))
    // Real M-43 start passes through the v/o corner arc, and the h flat sits on the outer
    // mitre (along 50) rather than the AK root (45).
    expect(nearest(m43?.startCut, [45.17, 2.28])).toBeLessThan(0.6)
    expect(nearest(m43?.startCut, [57.14, 12.5])).toBeLessThan(0.6)
    const hFlat = (m43?.startCut ?? []).filter(([station]) => station > 100 && station < 178)
    expect(hFlat.length).toBeGreaterThan(0)
    expect(hFlat.every(([, along]) => Math.abs(along - 50) < 0.6)).toBe(true)

    const m42 = partFromNc(readFileSync(fixture('ncep', 'M-42.nc1'), 'utf8'))
    expect(nearest(m42?.endCut, [47.32, 102.34])).toBeLessThan(0.6)
    const m42H = (m42?.endCut ?? []).filter(([station]) => station > 100 && station < 178)
    expect(m42H.every(([, along]) => Math.abs(along - 56) < 0.6)).toBe(true)

    const m35 = partFromNc(readFileSync(fixture('ncep', 'M-35.nc1'), 'utf8'))
    expect(m35?.startCut).toHaveLength(2)
    expect(m35?.endCut).toHaveLength(2)
  })

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

describe('partFromNc end-cut development', () => {
  const m130 = nw31Top('NC files', 'm130.nc1')

  it.skipIf(!existsSync(m130))('stitches a stepped end in perimeter order (m130)', () => {
    const part = partFromNc(readFileSync(m130, 'utf8'))
    const start = part?.startCut
    expect(start).toBeTruthy()
    if (!start) return
    // PFC100*50 start trim. The bottom flange (`u`) is the bottom view, so its across axis is
    // reversed: the notched toe (y=50) is at station -100 with along ≈18.2, and the web-side edge
    // (y=0) meets `v` at station -50 with along 0. The old non-reversed mapping swapped these.
    expect(start[0]?.[0]).toBeCloseTo(-100, 1)
    expect(start[0]?.[1]).toBeCloseTo(18.2, 0)
    const atMinus50 = start.find(([station]) => Math.abs(station + 50) < 0.01)
    expect(atMinus50?.[1]).toBeCloseTo(0, 0)
    // `v` and `o` share the other web edge at +50 (along 23.43).
    const atPlus50 = start.find(([station]) => Math.abs(station - 50) < 0.01)
    expect(atPlus50?.[1]).toBeCloseTo(23.43, 0)
    expect(start[start.length - 1]?.[0]).toBeCloseTo(100, 1)
    expect(start[start.length - 1]?.[1]).toBeCloseTo(41.63, 0)
  })

  for (const mark of ['M-51', 'M-42'] as const) {
    const path = fixture('ncep', `${mark}.nc1`)
    it.skipIf(!existsSync(path))(`${mark}: never draws a cut across the unrolled seam`, () => {
      const part = partFromNc(readFileSync(path, 'utf8'))
      expect(part).toBeTruthy()
      if (!part) return
      const seam = part.unrolledPerimeter ?? 0
      for (const cut of part.cuts ?? []) {
        for (let i = 1; i < cut.points.length; i++) {
          const a = cut.points[i - 1] as [number, number]
          const b = cut.points[i] as [number, number]
          expect(Math.abs(b[0] - a[0])).toBeLessThanOrEqual(seam / 2)
        }
      }
    })
  }

  it.skipIf(!existsSync(m130))('is a pure function of the NC text', () => {
    const nc = readFileSync(m130, 'utf8')
    const first = partFromNc(nc)
    // Jump to other parts (the app's navigation) then develop the same NC again.
    partFromNc(readFileSync(nw31Top('NC files', 'm31.nc1'), 'utf8'))
    partFromNc(readFileSync(nw31Top('NC files', 'm117.nc1'), 'utf8'))
    const again = partFromNc(nc)
    expect(JSON.stringify(again?.startCut)).toBe(JSON.stringify(first?.startCut))
    expect(JSON.stringify(again?.endCut)).toBe(JSON.stringify(first?.endCut))
    expect(JSON.stringify(again?.cuts)).toBe(JSON.stringify(first?.cuts))
  })
})
