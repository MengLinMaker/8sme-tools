import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { partSectionForCode } from '@/lib/sections/stock'
import { buildNcex, type NcexPart } from './ncex'

/** PFC380*100 — the M-1 sample; hole stations match WiseCAM's own part230.svg. */
function pfcPart(): NcexPart {
  const section = partSectionForCode('PFC380*100', [380, 100, 17.5, 10, 14])
  if (!section) throw new Error('no PFC section')
  // Stations decoded from WiseCAM part230.svg: u → -290+y, v → -190+y, o → 190+y.
  const holes = [
    ...[284.2, 1184.2, 2084.2, 2984.2, 3884.2, 4784.2].map((along) => ({
      station: 190 + 50,
      along,
      radius: 7,
    })),
    ...[135, 235].map((along) => ({ station: -290 + 50, along, radius: 11 })),
    ...[284.2, 1184.2, 2084.2, 2984.2, 3884.2, 4784.2].flatMap((along) => [
      { station: -190 + 115, along, radius: 7 },
      { station: -190 + 265, along, radius: 7 },
    ]),
    ...[85, 155, 225, 295].map((y) => ({
      station: -190 + y,
      along: 5049.2,
      radius: 11,
    })),
  ]
  return {
    mark: 'M-1',
    profile: 'PFC380*100',
    profileType: 'U',
    typeCode: 8199,
    length: 5084.2,
    quantity: 1,
    thickness: 10,
    legThickness: 17.5,
    section: section.points,
    innerSection: section.innerSection,
    // A PFC's unrolled surface is web + two flange backs only: 380 + 100 + 100.
    unrolledPerimeter: 580,
    holes,
  }
}

describe('buildNcex', () => {
  it('writes a valid OPC/ZIP with mimetype first and stored', () => {
    const bytes = buildNcex([pfcPart()])
    // First local file header name must be mimetype.
    const name = strFromU8(bytes.slice(30, 30 + 8))
    expect(name).toBe('mimetype')
    const files = unzipSync(bytes)
    expect(files.mimetype).toBeDefined()
    expect(strFromU8(files.mimetype as Uint8Array)).toBe('application/ncex+zip')
    expect(files['META-INF/container.xml']).toBeDefined()
    expect(files['CAD/CadRoot.xml']).toBeDefined()
    expect(files['ncex.opf']).toBeDefined()
  })

  it('writes type, quantity and stance into CadRoot.xml', () => {
    const files = unzipSync(
      buildNcex([{ ...pfcPart(), quantity: 3, rotateAngle: 90, invert: true }]),
    )
    const cad = strFromU8(files['CAD/CadRoot.xml'] as Uint8Array)
    expect(cad).toContain('Type=8199')
    expect(cad).toContain('Name=M-1')
    expect(cad).toContain('TotalCount=3')
    expect(cad).toContain('RotateAngle=90')
    expect(cad).toContain('Invert=1')
  })

  it('places holes at the decoded unrolled stations', () => {
    const files = unzipSync(buildNcex([pfcPart()]))
    const svg = strFromU8(files['CAD/part1000.svg'] as Uint8Array)
    // o face at y=50 → station 240
    expect(svg).toContain('cx="240.00"')
    // u face at y=50 → station -240
    expect(svg).toContain('cx="-240.00"')
    // v face at y=115 → station -75
    expect(svg).toContain('cx="-75.00"')
    expect(svg).toContain('cy="284.20"')
    // end holes at y=85 → station -105
    expect(svg).toContain('cx="-105.00"')
    expect(svg).toContain('cy="5049.20"')
  })

  it('draws the cross-section and straight end cuts', () => {
    const files = unzipSync(buildNcex([pfcPart()]))
    const svg = strFromU8(files['CAD/part1000.svg'] as Uint8Array)
    expect(svg).toContain('TrucateType=0')
    expect(svg).toContain('TrucateType=1')
    // PFC380*100 outer perimeter is 580, so the unrolled seam is ±290.
    expect(svg).toContain('M-290.00,0.00 L290.00,0.00')
    expect(svg).toContain('M290.00,5084.20 L-290.00,5084.20')
    // Section outline is present.
    expect(svg).toContain('-190.00,50.00')
  })

  it('writes the PFC inner cavity as the second section path', () => {
    const files = unzipSync(buildNcex([pfcPart()]))
    const svg = strFromU8(files['CAD/part1000.svg'] as Uint8Array)
    const group = svg.slice(svg.indexOf('wh:class="cadgroup"'))
    // Outer section + inner cavity, unlike an I-section which has only the outer path.
    expect(group.match(/<path\b/g)).toHaveLength(2)
    expect(group).toContain('M-172.50,-50.00')
    expect(group).toContain('-172.50,26.00')
    expect(group).toContain('-158.50,40.00')
    expect(group).toContain('172.50,26.00')
    expect(group).toContain('172.50,-50.00')
  })

  it('puts the section cadgroup beside cadpart, not nested inside it', () => {
    const files = unzipSync(buildNcex([pfcPart()]))
    const svg = strFromU8(files['CAD/part1000.svg'] as Uint8Array)
    const cadgroupAt = svg.indexOf('wh:class="cadgroup"')
    expect(cadgroupAt).toBeGreaterThan(-1)
    expect(svg.indexOf('</g>')).toBeLessThan(cadgroupAt)
  })

  it('emits a fresh, valid technologyID for every part and build', () => {
    const ids = (bytes: Uint8Array): string[] => {
      const cad = strFromU8(unzipSync(bytes)['CAD/CadRoot.xml'] as Uint8Array)
      return [...cad.matchAll(/technologyID="([^"]+)"/g)].map((match) => match[1] as string)
    }
    const first = ids(buildNcex([pfcPart()]))
    const second = ids(buildNcex([pfcPart()]))
    const all = [...first, ...second]
    expect(first.length).toBeGreaterThan(0)
    for (const id of all) {
      expect(id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
    }
    expect(new Set(all).size).toBe(all.length)
  })

  it('rejects an empty part list', () => {
    expect(() => buildNcex([])).toThrow()
  })
})
