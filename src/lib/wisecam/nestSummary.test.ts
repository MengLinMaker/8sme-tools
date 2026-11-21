import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { NcexPackage } from './ncexParse'
import { parseNexPackage } from './ncexParse'
import { summarizeNests } from './nestSummary'

interface TestPart {
  id: string
  name: string
}

function packageBytes(
  parts: TestPart[],
  results: { id: string; copies: number; partInfo: [string, number][] }[],
): Uint8Array {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<cadroot version="1.0" xmlns="http://www.weihong.com.cn/cadcam">',
    ' <Adobes>',
    '  <Adobe idref="a1" svgname="adobe1.svg" params="Type=8200;Length=12000;TotalCount=10000;NestedCount=0;"/>',
    ' </Adobes>',
    ' <Parts>',
    ...parts.map(
      (part) =>
        `  <Part idref="${part.id}" svgname="part${part.id}.svg" params="Type=8200;Name=${part.name};TotalCount=1;NestedCount=0;"/>`,
    ),
    ' </Parts>',
    ' <Results>',
    ...results.map((result) => {
      const info = result.partInfo.map(([id, count]) => `(${id},${count})`).join('')
      return `  <Result idref="${result.id}" count="2" adobeid="a1" params="Count=${result.copies};PartInfo=${info};"/>`
    }),
    ' </Results>',
    '</cadroot>',
  ].join('\n')
  return zipSync({
    mimetype: strToU8('application/ncex+zip'),
    'CAD/CadRoot.xml': strToU8(xml),
  })
}

function loaded(file: string, bytes: Uint8Array): { file: string; package: NcexPackage } {
  return { file, package: parseNexPackage(bytes) }
}

describe('summarizeNests', () => {
  it('extracts each part name as written and counts the pieces under it', () => {
    const summary = summarizeNests([
      loaded(
        'a.ncexa',
        packageBytes(
          [{ id: 'p1', name: 'M_29 QIE' }],
          [{ id: 'r1', copies: 2, partInfo: [['p1', 3]] }],
        ),
      ),
      loaded(
        'b.ncexa',
        packageBytes(
          [{ id: 'p2', name: 'M_29' }],
          [{ id: 'r2', copies: 6, partInfo: [['p2', 1]] }],
        ),
      ),
    ])
    expect(summary.names).toEqual([
      {
        name: 'M_29',
        nested: 6,
        files: ['b.ncexa'],
        sources: [{ file: 'b.ncexa', quantity: 6 }],
      },
      {
        name: 'M_29 QIE',
        nested: 6,
        files: ['a.ncexa'],
        sources: [{ file: 'a.ncexa', quantity: 6 }],
      },
    ])
    expect(summary.totals).toMatchObject({
      packages: 2,
      results: 2,
      pieces: 12,
      names: 2,
      unnamed: 0,
    })
  })

  it('reports unnamed parts instead of inventing a mark', () => {
    const summary = summarizeNests([
      loaded(
        'unnamed.ncexa',
        packageBytes([{ id: 'p1', name: '' }], [{ id: 'r1', copies: 1, partInfo: [['p1', 1]] }]),
      ),
    ])
    expect(summary.totals.unnamed).toBe(1)
    expect(summary.names).toEqual([])
  })

  it('counts a result exported twice once, but keeps the raw name spellings', () => {
    const summary = summarizeNests([
      loaded(
        'project.ncexa',
        packageBytes(
          [{ id: 'p1', name: 'M_29' }],
          [{ id: 'r1', copies: 3, partInfo: [['p1', 2]] }],
        ),
      ),
      loaded(
        'beam.ncexa',
        packageBytes(
          [{ id: 'p1', name: 'M_29 QIE' }],
          [{ id: 'r1', copies: 3, partInfo: [['p1', 2]] }],
        ),
      ),
    ])
    expect(summary.names).toEqual([
      {
        name: 'M_29',
        nested: 6,
        files: ['project.ncexa'],
        sources: [{ file: 'project.ncexa', quantity: 6 }],
      },
      {
        name: 'M_29 QIE',
        nested: 0,
        files: ['beam.ncexa'],
        sources: [],
      },
    ])
    expect(summary.findings.map((finding) => finding.code)).toContain('duplicate-result')
  })

  it('breaks a part total down by each nesting that contributed', () => {
    const summary = summarizeNests([
      loaded(
        'first.ncexa',
        packageBytes(
          [{ id: 'p1', name: 'M_40' }],
          [{ id: 'r1', copies: 2, partInfo: [['p1', 1]] }],
        ),
      ),
      loaded(
        'second.ncexa',
        packageBytes(
          [{ id: 'p2', name: 'M_40' }],
          [{ id: 'r2', copies: 3, partInfo: [['p2', 1]] }],
        ),
      ),
    ])
    expect(summary.names).toEqual([
      {
        name: 'M_40',
        nested: 5,
        files: ['first.ncexa', 'second.ncexa'],
        sources: [
          { file: 'second.ncexa', quantity: 3 },
          { file: 'first.ncexa', quantity: 2 },
        ],
      },
    ])
  })

  it('lists extracted names even when a CAD-only package has no results', () => {
    const summary = summarizeNests([
      loaded('part.ncexa', packageBytes([{ id: 'p1', name: 'M_29' }], [])),
    ])
    expect(summary.totals.packagesWithoutResults).toBe(1)
    expect(summary.names).toEqual([{ name: 'M_29', nested: 0, files: ['part.ncexa'], sources: [] }])
    expect(summary.totals.names).toBe(1)
  })
})
