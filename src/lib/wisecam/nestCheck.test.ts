import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseNexPackage } from './ncexParse'
import {
  checkNestPackage,
  checkNestSet,
  nestMarkKey,
  nestReference,
  normalizeNestMark,
} from './nestCheck'

interface TestPart {
  id: string
  name: string
  total: number
  nested: number
}

interface TestResult {
  id: string
  copies: number
  /** Per-bar placements. */
  partInfo: [string, number][]
  /** Override the drawn instances (defaults to the PartInfo split). */
  drawn?: [string, number][]
}

function packageBytes(
  parts: TestPart[],
  results: TestResult[],
  adobes: { id: string; total?: number; nested?: number }[] = [{ id: 'a1' }],
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/ncex+zip'),
    'CAD/CadRoot.xml': strToU8(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<cadroot version="1.0" xmlns="http://www.weihong.com.cn/cadcam">',
        ' <Adobes>',
        ...adobes.map(
          (adobe) =>
            `  <Adobe idref="${adobe.id}" svgname="adobe${adobe.id}.svg" params="Type=8200;Length=12000;TotalCount=${adobe.total ?? 10000};NestedCount=${adobe.nested ?? 0};"/>`,
        ),
        ' </Adobes>',
        ' <Parts>',
        ...parts.map(
          (part) =>
            `  <Part idref="${part.id}" svgname="part${part.id}.svg" params="Type=8200;Name=${part.name};TotalCount=${part.total};NestedCount=${part.nested};Thickness=5;LegThickness=7;"/>`,
        ),
        ' </Parts>',
        ` <BaseZone idref="52" count="0" adobeid="${adobes[0]?.id ?? 'a1'}"/>`,
        ' <Results>',
        ...results.map((result) => {
          const info = result.partInfo.map(([id, count]) => `(${id},${count})`).join('')
          return `  <Result idref="${result.id}" count="2" adobeid="a1" params="Count=${result.copies};PartInfo=${info};ResultName=test;"/>`
        }),
        ' </Results>',
        '</cadroot>',
      ].join('\n'),
    ),
  }
  for (const result of results) {
    const drawn = result.drawn ?? result.partInfo
    const groups = drawn
      .flatMap(([id, count]) => Array.from({ length: count }, () => id))
      .map(
        (id) =>
          ` <g wh:class="cadpart" wh:refid="${id}" wh:matrixinfo3d="1,0,0,0 0,1,0,0 0,0,1,0"></g>`,
      )
    files[`CAD/${result.id}_0.svg`] = strToU8(
      `<svg xmlns:wh="http://www.weihong.com.cn/cadcam">\n${groups.join('\n')}\n</svg>`,
    )
  }
  return zipSync(files)
}

function parse(
  parts: TestPart[],
  results: TestResult[],
  adobes?: { id: string; total?: number; nested?: number }[],
) {
  return parseNexPackage(packageBytes(parts, results, adobes))
}

describe('parseNexPackage', () => {
  it('reads parts, adobes and result quantities', () => {
    const pkg = parse(
      [
        { id: 'p1', name: 'B7-20 QIE', total: 6, nested: 6 },
        { id: 'p2', name: 'B5-21', total: 6, nested: 3 },
      ],
      [
        {
          id: 'r1',
          copies: 3,
          partInfo: [
            ['p1', 1],
            ['p1', 1],
            ['p2', 1],
          ],
        },
      ],
    )
    expect(pkg.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(pkg.parts.map((part) => part.name)).toEqual(['B7-20 QIE', 'B5-21'])
    expect(pkg.results[0]?.copies).toBe(3)
    expect(pkg.results[0]?.piecesPerBar).toBe(3)
    expect(pkg.results[0]?.totalPieces).toBe(9)
    expect(pkg.results[0]?.drawn).toEqual([
      { partId: 'p1', count: 2 },
      { partId: 'p2', count: 1 },
    ])
  })

  it('keeps duplicate PartInfo entries and aggregates them for the drawing check', () => {
    const pkg = parse(
      [{ id: 'p1', name: 'B17-17', total: 6, nested: 6 }],
      [
        {
          id: 'r1',
          copies: 3,
          partInfo: [
            ['p1', 1],
            ['p1', 1],
          ],
        },
      ],
    )
    expect(pkg.results[0]?.partInfo).toHaveLength(2)
    const check = checkNestPackage(pkg)
    expect(check.findings).toEqual([])
    expect(check.rows[0]?.nested).toBe(6)
  })
})

describe('checkNestPackage', () => {
  it('passes when results produce the required quantity', () => {
    const check = checkNestPackage(
      parse(
        [{ id: 'p1', name: 'T5-26', total: 6, nested: 6 }],
        [{ id: 'r1', copies: 3, partInfo: [['p1', 2]] }],
      ),
    )
    expect(check.ok).toBe(true)
    expect(check.rows[0]).toMatchObject({ required: 6, nested: 6, declared: 6, delta: 0 })
  })

  it('flags short and excess quantities', () => {
    const check = checkNestPackage(
      parse(
        [
          { id: 'p1', name: 'T1-5', total: 18, nested: 6 },
          { id: 'p2', name: 'B3-4', total: 2, nested: 4 },
        ],
        [
          { id: 'r1', copies: 2, partInfo: [['p1', 3]] },
          { id: 'r2', copies: 2, partInfo: [['p2', 2]] },
        ],
      ),
    )
    expect(check.ok).toBe(false)
    expect(check.findings.map((finding) => finding.code)).toEqual(['part-short', 'part-excess'])
    expect(check.findings[0]?.message).toContain('missing 12')
  })

  it('flags a part that has not been nested at all', () => {
    const check = checkNestPackage(parse([{ id: 'p1', name: 'B1-1', total: 6, nested: 0 }], []))
    expect(check.findings[0]?.code).toBe('part-not-nested')
  })

  it('flags NestedCount that disagrees with the results', () => {
    const check = checkNestPackage(
      parse(
        [{ id: 'p1', name: 'B2-2', total: 6, nested: 9 }],
        [{ id: 'r1', copies: 3, partInfo: [['p1', 1]] }],
      ),
    )
    expect(check.findings.map((finding) => finding.code)).toContain('nested-count-mismatch')
  })

  it('flags a result drawing that does not hold the declared instances', () => {
    const check = checkNestPackage(
      parse(
        [{ id: 'p1', name: 'B7-20', total: 6, nested: 6 }],
        [{ id: 'r1', copies: 3, partInfo: [['p1', 2]], drawn: [['p1', 1]] }],
      ),
    )
    expect(check.findings.map((finding) => finding.code)).toContain('result-drawing-part')
  })
})

describe('nest marks', () => {
  it('strips WiseCAM/Tekla annotations', () => {
    expect(normalizeNestMark('T9-7 QIE？')).toBe('T9-7')
    expect(normalizeNestMark('B11-22 WELD QIE')).toBe('B11-22')
    expect(normalizeNestMark('Modified 12095, ITEM 30, EA 200x200x20, 4 OFF[C]')).toBe(
      '12095, ITEM 30, EA 200x200x20, 4 OFF[C]',
    )
    expect(nestMarkKey('B7-20 QIE')).toBe('b7-20')
  })
})

describe('checkNestSet', () => {
  it('counts the same result once when it is exported twice', () => {
    const a = parse(
      [{ id: 'p1', name: 'B7-20', total: 6, nested: 6 }],
      [{ id: 'r1', copies: 3, partInfo: [['p1', 2]] }],
    )
    const b = parse(
      [{ id: 'p1', name: 'B7-20 QIE', total: 6, nested: 6 }],
      [{ id: 'r1', copies: 3, partInfo: [['p1', 2]] }],
    )
    const set = checkNestSet([
      { file: 'project.ncexa', package: a },
      { file: 'B7-20 x2.ncexa', package: b },
    ])
    expect(set.aggregate.find((row) => row.mark === 'B7-20')?.nested).toBe(6)
    expect(set.findings.map((finding) => finding.code)).toContain('duplicate-result')
    expect(set.summary.duplicateResults).toBe(1)
  })

  it('flags conflicting contents for the same result id', () => {
    const a = parse(
      [{ id: 'p1', name: 'B7-20', total: 6, nested: 6 }],
      [{ id: 'r1', copies: 3, partInfo: [['p1', 2]] }],
    )
    const b = parse(
      [{ id: 'p1', name: 'B7-20', total: 6, nested: 6 }],
      [{ id: 'r1', copies: 3, partInfo: [['p1', 1]] }],
    )
    const set = checkNestSet([
      { file: 'a.ncexa', package: a },
      { file: 'b.ncexa', package: b },
    ])
    expect(set.findings.map((finding) => finding.code)).toContain('conflicting-result')
    expect(set.ok).toBe(false)
  })

  it('compares the summed nestings against the job package', () => {
    const job = parse(
      [
        { id: 'p1', name: 'B7-20', total: 6, nested: 3 },
        { id: 'p2', name: 'B5-21', total: 6, nested: 3 },
      ],
      [
        {
          id: 'r0',
          copies: 3,
          partInfo: [
            ['p1', 1],
            ['p2', 1],
          ],
        },
      ],
    )
    const nestA = parse(
      [{ id: 'p1', name: 'B7-20 QIE', total: 3, nested: 3 }],
      [{ id: 'r1', copies: 3, partInfo: [['p1', 1]] }],
    )
    const nestB = parse(
      [{ id: 'p2', name: 'B5-21 QIE', total: 3, nested: 3 }],
      [{ id: 'r2', copies: 3, partInfo: [['p2', 1]] }],
    )
    const set = checkNestSet(
      [
        { file: 'a.ncexa', package: nestA },
        { file: 'b.ncexa', package: nestB },
      ],
      nestReference(job, 'job.ncexa'),
    )
    expect(set.aggregate.map((row) => [row.mark, row.nested, row.required])).toEqual([
      ['B5-21', 3, 6],
      ['B7-20', 3, 6],
    ])
    expect(set.findings.map((finding) => finding.code)).toEqual([
      'reference-short',
      'reference-short',
      'required-mismatch',
      'required-mismatch',
    ])
    expect(set.findings.filter((finding) => finding.code === 'required-mismatch')).toHaveLength(2)
    expect(set.ok).toBe(false)
  })
})
